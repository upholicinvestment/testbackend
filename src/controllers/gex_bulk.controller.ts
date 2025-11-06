// src/controllers/gex_bulk.controller.ts
import type { Request, Response } from "express";
import type { Db, Collection, Document, WithId } from "mongodb";

/* ───────── DB handle ───────── */
let _db: Db | undefined;
export const setGexBulkDb = (database: Db) => { _db = database; };
const db = () => { if (!_db) throw new Error("DB not set"); return _db; };

/* ───────── small utils ───────── */
const envInt = (k: string, def: number) => {
  const v = process.env[k];
  const n = v ? parseInt(v, 10) : def;
  return Number.isFinite(n) ? n : def;
};
const clean = (s: string) => (s || "").trim();

function expiryClause(expiryISO: string) {
  return {
    $or: [
      { expiry: expiryISO },
      { expiry: new Date(expiryISO) },
      {
        $expr: {
          $eq: [
            {
              $dateToString: {
                format: "%Y-%m-%d",
                date: {
                  $cond: [
                    { $eq: [{ $type: "$expiry" }, "string"] },
                    { $toDate: "$expiry" },
                    "$expiry",
                  ],
                },
              },
            },
            expiryISO,
          ],
        },
      },
      {
        $expr: {
          $and: [
            { $eq: [{ $type: "$expiry" }, "string"] },
            { $eq: [{ $substrCP: ["$expiry", 0, 10] }, expiryISO] },
          ],
        },
      },
    ],
  };
}

function looseByIdSegSym(securityId: number, seg: string, symbol: string) {
  const segRegex = new RegExp(clean(seg).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const symContains = new RegExp("NIFTY", "i"); // allow variants of NIFTY
  return {
    $or: [
      { underlying_security_id: securityId },
      { underlying_security_id: String(securityId) },
      { underlying_symbol: symContains },
      { underlying_segment: segRegex },
    ],
  };
}

async function listDistinctExpiries(coll: Collection<Document>, filter: any): Promise<string[]> {
  const cursor = coll.aggregate([
    { $match: filter },
    {
      $addFields: {
        expiryStr: {
          $cond: [
            { $eq: [{ $type: "$expiry" }, "string"] },
            { $substrCP: ["$expiry", 0, 10] },
            { $dateToString: { format: "%Y-%m-%d", date: "$expiry" } },
          ],
        },
      },
    },
    { $group: { _id: "$expiryStr", n: { $sum: 1 } } },
    { $sort: { _id: 1 } },
  ]);
  const out: string[] = [];
  for await (const d of cursor) if (d?._id) out.push(String(d._id));
  return out;
}

function pickNearestOrLatest(expiries: string[], todayISO: string): string | null {
  if (!expiries.length) return null;
  const today = new Date(`${todayISO}T00:00:00Z`);
  for (const e of expiries) {
    const d = new Date(`${e}T00:00:00Z`);
    if (d >= today) return e;
  }
  return expiries[expiries.length - 1];
}

function istTodayBoundsUTC() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const ymd = fmt.format(new Date());
  const [y, m, d] = ymd.split("-").map(Number);
  // 09:15 IST → 03:45 UTC ; 15:30 IST → 10:00 UTC (use 09:15 exact: 03:45)
  const startUTC = new Date(Date.UTC(y, m - 1, d, 3, 45, 0, 0));
  const endUTCMarket = new Date(Date.UTC(y, m - 1, d, 10, 0, 0));
  const nowUTC = new Date();
  const endUTC = new Date(Math.min(endUTCMarket.getTime(), nowUTC.getTime()));
  return { startUTC, endUTC, ymd };
}

function istDayBoundsUTCFromYMD(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  const startUTC = new Date(Date.UTC(y, m - 1, d, 3, 45, 0, 0));
  const endUTCMarket = new Date(Date.UTC(y, m - 1, d, 10, 0, 0));
  return { startUTC, endUTC: endUTCMarket, ymd };
}

function windowSinceMinutes(mins: number) {
  const end = new Date();
  const start = new Date(end.getTime() - mins * 60_000);
  // compute IST date label of end (for X-GEX-Day)
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
  const ymd = fmt.format(end);
  return { startUTC: start, endUTC: end, ymd };
}

function ticksFilter(
  securityId: number,
  seg: string,
  symbol: string,
  expiryISO: string,
  startUTC: Date,
  endUTC: Date
) {
  return {
    $and: [
      looseByIdSegSym(securityId, seg, symbol),
      expiryClause(expiryISO),
      { ts: { $gte: startUTC, $lte: endUTC } },
    ],
  };
}

/* tomatch cache controller behaviour: */
function istYMDFromDate(d: Date) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d);
}

async function fetchTicksPreferPreviousDay(
  _db: Db,
  securityId: number,
  seg: string,
  symbol: string,
  expiryISO: string,
  startUTC: Date,
  endUTC: Date,
  fallbackLimit = Number(process.env.GEX_FALLBACK_TICKS || "2000"),
): Promise<{
  rows: Document[];
  fallbackType: "today" | "previous_day" | "previous_partial" | "synth_from_option_chain" | "none";
  fallback_count?: number;
  prev_day_ymd?: string;
}> {
  const ticksColl = _db.collection("option_chain_ticks");
  // 1) try requested window
  const baseFilter = {
    $and: [
      looseByIdSegSym(securityId, seg, symbol),
      expiryClause(expiryISO),
      { ts: { $gte: startUTC, $lte: endUTC } },
    ],
  };
  const windowRows = await ticksColl.find(baseFilter, { sort: { ts: 1, _id: 1 }, projection: { last_price: 1, ts: 1 } }).toArray();
  if (windowRows && windowRows.length) return { rows: windowRows, fallbackType: "today" };

  // 2) try latest ticks strictly before startUTC
  const beforeFilter = {
    $and: [
      looseByIdSegSym(securityId, seg, symbol),
      expiryClause(expiryISO),
      { ts: { $lt: startUTC } },
    ],
  };
  const prevPartial = await ticksColl.find(beforeFilter, { sort: { ts: -1, _id: -1 }, projection: { last_price: 1, ts: 1 }, limit: fallbackLimit }).toArray();
  if (!prevPartial || !prevPartial.length) return { rows: [], fallbackType: "none" };

  const latestPrev = prevPartial[0];
  const latestPrevTs = new Date((latestPrev as any).ts);
  const prevYmd = istYMDFromDate(latestPrevTs);

  // Attempt to fetch full previous trading day window for prevYmd
  const prevDayBounds = istDayBoundsUTCFromYMD(prevYmd);
  const prevDayFilter = {
    $and: [
      looseByIdSegSym(securityId, seg, symbol),
      expiryClause(expiryISO),
      { ts: { $gte: prevDayBounds.startUTC, $lte: prevDayBounds.endUTC } },
    ],
  };

  const prevDayRows = await ticksColl.find(prevDayFilter, { sort: { ts: 1, _id: 1 }, projection: { last_price: 1, ts: 1 } }).toArray();
  if (prevDayRows && prevDayRows.length) {
    return { rows: prevDayRows, fallbackType: "previous_day", prev_day_ymd: prevYmd, fallback_count: prevDayRows.length };
  }

  // If full previous day not available, try building series from option_chain snapshots
  const ocColl = _db.collection("option_chain");
  const candidates = await ocColl.find({ $and: [ looseByIdSegSym(securityId, seg, symbol), expiryClause(expiryISO) ] })
    .project({ last_price: 1, updated_at: 1, ts: 1 })
    .sort({ updated_at: 1, ts: 1 })
    .toArray();

  const ocRows: { last_price: number; ts: string }[] = [];
  for (const d of candidates) {
    const rawTs = (d as any).updated_at || (d as any).ts;
    if (!rawTs) continue;
    const dt = new Date(rawTs);
    if (isNaN(dt.getTime())) continue;
    if (dt >= prevDayBounds.startUTC && dt <= prevDayBounds.endUTC) {
      const price = Number((d as any).last_price);
      if (!Number.isFinite(price)) continue;
      ocRows.push({ last_price: price, ts: dt.toISOString() });
    }
  }
  if (ocRows.length) {
    ocRows.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    return { rows: ocRows as any as Document[], fallbackType: "synth_from_option_chain", prev_day_ymd: prevYmd, fallback_count: ocRows.length };
  }

  // fallback: return prevPartial (chronological)
  prevPartial.reverse();
  return { rows: prevPartial as Document[], fallbackType: "previous_partial", fallback_count: prevPartial.length };
}

/* ───────── GET /api/gex/nifty/bulk ─────────
   Combines: cache snapshot + today (or sinceMin) ticks with ETag + day header  */
export const getNiftyGexBulk: any = async (req: Request, res: Response) => {
  try {
    const securityId = envInt("NIFTY_SECURITY_ID", 13);
    const seg = process.env.NIFTY_UNDERLYING_SEG || "IDX_I";
    const symbol = process.env.NIFTY_SYMBOL || "NIFTY";

    const expiryReq = String(req.query.expiry || "").slice(0, 10) || null;
    const scope = String(req.query.scope || "today").toLowerCase(); // "today" | "since"
    const sinceMin = parseInt(String(req.query.sinceMin || "1440"), 10);

    const ocColl = db().collection("option_chain");
    const loose = looseByIdSegSym(securityId, seg, symbol);
    const sortLatest = { updated_at: -1 as const, _id: -1 as const };

    // Resolve expiry
    let doc: WithId<Document> | null = null;
    let chosenExpiry = expiryReq;
    if (chosenExpiry) {
      doc = await ocColl.findOne({ $and: [loose, expiryClause(chosenExpiry)] }, { sort: sortLatest });
    }
    if (!doc) {
      const exps = await listDistinctExpiries(ocColl, loose);
      const todayISO = new Date().toISOString().slice(0, 10);
      chosenExpiry = pickNearestOrLatest(exps, todayISO);
      if (chosenExpiry) {
        doc = await ocColl.findOne({ $and: [loose, expiryClause(chosenExpiry)] }, { sort: sortLatest });
      }
    }
    if (!doc) {
      return res.status(404).json({ error: "NO_OPTION_CHAIN_DOC", tried: { securityId, seg, symbol, expiry: expiryReq } });
    }

    const expiryISO =
      typeof (doc as any).expiry === "string"
        ? (doc as any).expiry.slice(0, 10)
        : new Date((doc as any).expiry).toISOString().slice(0, 10);

    // Build time window
    const win =
      scope === "since" && Number.isFinite(sinceMin) && sinceMin > 0
        ? windowSinceMinutes(sinceMin)
        : istTodayBoundsUTC();

    // Pull ticks inside window (with extended fallback)
    const ticksColl = db().collection("option_chain_ticks");
    const filter = ticksFilter(securityId, seg, symbol, expiryISO, win.startUTC, win.endUTC);
    const { rows: rawRows, fallbackType, fallback_count, prev_day_ymd } = await fetchTicksPreferPreviousDay(db(), securityId, seg, symbol, expiryISO, win.startUTC, win.endUTC);

    let rows = rawRows || [];
    let synthesized = false;

    // If still empty, fall back to option_chain.last_price single point
    if ((!rows || rows.length === 0)) {
      const price = Number((doc as any).last_price ?? NaN);
      if (Number.isFinite(price)) {
        let tsNum = win.startUTC.getTime() + 60_000;
        if ((doc as any).updated_at) {
          const cand = new Date((doc as any).updated_at).getTime();
          if (cand >= win.startUTC.getTime() && cand <= win.endUTC.getTime()) tsNum = cand;
        }
        rows = [{ last_price: price, ts: new Date(tsNum).toISOString() } as any];
        synthesized = true;
      }
    }

    const points = (rows || [])
      .map((r) => ({ x: new Date((r as any).ts as string).getTime(), y: Number((r as any).last_price) }))
      .filter((p) => Number.isFinite(p.y));

    const gexPayload = {
      symbol: (doc as any).underlying_symbol || "NIFTY",
      expiry: expiryISO,
      spot: Number((doc as any).last_price ?? 0),
      rows: Array.isArray((doc as any).strikes)
        ? (doc as any).strikes.map((r: any) => ({
            strike: Number(r?.strike ?? 0),
            gex_oi_raw: Number(r?.gex_oi_raw ?? 0),
            gex_vol_raw: Number(r?.gex_vol_raw ?? 0),
            ce_oi: Number(r?.ce?.oi ?? 0),
            pe_oi: Number(r?.pe?.oi ?? 0),
            ce_vol: Number(r?.ce?.volume ?? 0),
            pe_vol: Number(r?.pe?.volume ?? 0),
          }))
        : [],
      updated_at: (doc as any).updated_at,
    };

    if (points.length) {
      gexPayload.spot = points[points.length - 1].y;
    }

    const etag = `W/"${expiryISO}-${win.ymd}-${(doc as any).updated_at || "na"}-${points.length}"`;
    res.setHeader("ETag", etag);
    res.setHeader("X-GEX-Day", win.ymd);

    const inm = req.headers["if-none-match"];
    if (inm && inm === etag) {
      res.status(304).end();
      return;
    }

    // Normalize fallbackType to points_source naming
    let points_source = "none";
    if (synthesized) points_source = "synthesized";
    else if (fallbackType === "today") points_source = "today";
    else if (fallbackType === "previous_day") points_source = "previous_day";
    else if (fallbackType === "synth_from_option_chain") points_source = "previous_day_from_option_chain";
    else if (fallbackType === "previous_partial") points_source = "previous_partial";

    return res.json({
      day: win.ymd,
      gex: gexPayload,
      ticks: {
        from: win.startUTC.toISOString(),
        to: win.endUTC.toISOString(),
        points,
        count: points.length,
        points_source,
        fallback_count,
        prev_day_ymd,
      },
    });
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error("[getNiftyGexBulk]", e?.message || e);
    return res.status(500).json({ error: "GEX_BULK_FAILED", detail: String(e?.message || e) });
  }
};
