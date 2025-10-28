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
  const ymd = fmt.format(new Date()); // "YYYY-MM-DD" in IST context
  const [y, m, d] = ymd.split("-").map(Number);
  // 09:15 IST → 03:45 UTC ; 15:30 IST → 10:00 UTC (use 09:15 exact: 03:45)
  const startUTC = new Date(Date.UTC(y, m - 1, d, 3, 45, 0, 0));
  const endUTCMarket = new Date(Date.UTC(y, m - 1, d, 10, 0, 0));
  const nowUTC = new Date();
  const endUTC = new Date(Math.min(endUTCMarket.getTime(), nowUTC.getTime()));
  return { startUTC, endUTC, ymd };
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

    // Pull ticks inside window
    const ticksColl = db().collection("option_chain_ticks");
    const filter = ticksFilter(securityId, seg, symbol, expiryISO, win.startUTC, win.endUTC);
    const raw = await ticksColl
      .find(filter, { sort: { ts: 1, _id: 1 }, projection: { last_price: 1, ts: 1 } })
      .toArray();

    const points = raw
      .map((r) => ({ x: new Date(r.ts as any as string).getTime(), y: Number((r as any).last_price) }))
      .filter((p) => Number.isFinite(p.y));

    // Build GEX rows from snapshot (do not recompute here; reuse stored structure)
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

    // Prefer last tick as spot if present
    if (points.length) {
      gexPayload.spot = points[points.length - 1].y;
    }

    // ETag + Day header for cache
    const etag = `W/"${expiryISO}-${win.ymd}-${(doc as any).updated_at || "na"}-${points.length}"`;
    res.setHeader("ETag", etag);
    res.setHeader("X-GEX-Day", win.ymd);

    // 304 support
    const inm = req.headers["if-none-match"];
    if (inm && inm === etag) {
      res.status(304).end();
      return;
    }

    return res.json({
      day: win.ymd,
      gex: gexPayload,
      ticks: {
        from: win.startUTC.toISOString(),
        to: win.endUTC.toISOString(),
        points,
        count: points.length,
      },
    });
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error("[getNiftyGexBulk]", e?.message || e);
    return res.status(500).json({ error: "GEX_BULK_FAILED", detail: String(e?.message || e) });
  }
};
