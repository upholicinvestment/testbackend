// server/src/controllers/gex_cache.controller.ts
import type { Request, Response } from "express";
import type { Db, WithId, Document, Collection } from "mongodb";
import crypto from "crypto";
import { computeGexFromCachedDoc } from "../utils/gex_from_cache";

let db: Db | undefined;
export const setGexCacheDb = (database: Db) => { db = database; };
const requireDb = (): Db => { if (!db) throw new Error("DB not set"); return db; };

const envInt = (k: string, def: number) => {
  const v = process.env[k];
  const n = v ? parseInt(v, 10) : def;
  return Number.isFinite(n) ? n : def;
};
const clean = (s: string) => (s || "").trim();

/* ───────── expiry & matching helpers ───────── */
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
  const symContains = new RegExp("NIFTY", "i"); // allow NIFTY / NIFTY-50 / NIFTY50 etc
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

async function getLotSize(db: Db, securityId: number, seg: string): Promise<number> {
  const d = await db.collection("instruments").findOne(
    {
      $and: [
        { $or: [{ SECURITY_ID: securityId }, { SECURITY_ID: String(securityId) }] },
        { $or: [{ SEGMENT: seg }, { SEGMENT: new RegExp(`^${clean(seg)}\\s*$`, "i") }] },
      ],
    },
    { projection: { LOT_SIZE: 1, LOT_SIZE_UNITS: 1 } }
  );
  const lot = (d as any)?.LOT_SIZE ?? (d as any)?.LOT_SIZE_UNITS;
  return typeof lot === "number" && lot > 0
    ? lot
    : (parseInt(process.env.NIFTY_LOT_SIZE || "75", 10) || 50);
}

/* ───────── live spot from ticks (latest) ───────── */
async function fetchSpotFromTicks(
  _db: Db,
  securityId: number,
  seg: string,
  symbol: string,
  expiryISO: string
): Promise<{ spot: number | null; ts?: Date | string }> {
  const ticks = _db.collection("option_chain_ticks");
  const filter = {
    $and: [
      looseByIdSegSym(securityId, seg, symbol),
      expiryClause(expiryISO),
    ],
  };

  const doc = await ticks.findOne(
    filter,
    { sort: { ts: -1, updated_at: -1, _id: -1 }, projection: { last_price: 1, ts: 1, updated_at: 1 } }
  );

  if (!doc) return { spot: null };
  const price = Number((doc as any).last_price);
  if (!Number.isFinite(price)) return { spot: null };
  const ts = (doc as any).ts || (doc as any).updated_at;
  return { spot: price, ts };
}

/* ───────── build IST session window (today) ───────── */
function istTodayBoundsUTC() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const ymd = fmt.format(new Date()); // "YYYY-MM-DD" in IST context
  const [y, m, d] = ymd.split("-").map(Number);

  // 09:00 IST => 03:30 UTC; 15:30 IST => 10:00 UTC
  const startUTC = new Date(Date.UTC(y, m - 1, d, 3, 30, 0, 0));
  const endUTCMarket = new Date(Date.UTC(y, m - 1, d, 10, 0, 0));
  const nowUTC = new Date();
  const endUTC = new Date(Math.min(endUTCMarket.getTime(), nowUTC.getTime()));
  return { startUTC, endUTC, ymd };
}

/* helper: today or "since X minutes" */
function istTodayBoundsUTC_orSince(scope: string, sinceMin: number) {
  if (scope === "since") {
    const endUTC = new Date();
    const startUTC = new Date(endUTC.getTime() - Math.max(1, sinceMin) * 60_000);
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const ymd = fmt.format(new Date());
    return { startUTC, endUTC, ymd };
  }
  return istTodayBoundsUTC();
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

/* ────────────────────────────────────────────────────────────
 *  GET /api/gex/nifty/cache?expiry=YYYY-MM-DD
 *  → GEX payload; spot comes from option_chain_ticks (latest) when available
 * ──────────────────────────────────────────────────────────── */
export const getNiftyGexFromCache: any = async (req: Request, res: Response) => {
  try {
    const securityId = envInt("NIFTY_SECURITY_ID", 13);
    const seg = process.env.NIFTY_UNDERLYING_SEG || "IDX_I";
    const symbol = process.env.NIFTY_SYMBOL || "NIFTY";

    const coll: Collection<Document> = requireDb().collection("option_chain");
    const requested = (req.query.expiry as string | undefined)?.slice(0, 10) || null;

    const loose = looseByIdSegSym(securityId, seg, symbol);
    const sortLatest = { updated_at: -1 as const, _id: -1 as const };

    let doc: WithId<Document> | null = null;

    if (requested) {
      const f = { $and: [loose, expiryClause(requested)] };
      doc = await coll.findOne(f, { sort: sortLatest });
    }

    let chosenExpiry = requested;
    if (!doc && !requested) {
      const exps = await listDistinctExpiries(coll, loose);
      const todayISO = new Date().toISOString().slice(0, 10);
      chosenExpiry = pickNearestOrLatest(exps, todayISO);
      if (chosenExpiry) {
        const f2 = { $and: [loose, expiryClause(chosenExpiry)] };
        doc = await coll.findOne(f2, { sort: sortLatest });
      }
    }

    if (!doc) {
      doc = await coll.findOne(loose, {
        sort: sortLatest,
        projection: {
          underlying_security_id: 1,
          underlying_segment: 1,
          underlying_symbol: 1,
          expiry: 1,
          updated_at: 1,
          last_price: 1,
        },
      });
      if (doc?._id) {
        const full = await coll.findOne({ _id: doc._id });
        if (full) doc = full;
      }
    }

    if (!doc) {
      const count = await coll.estimatedDocumentCount();
      const anyExp = await listDistinctExpiries(coll, {}); // across whole coll
      return res.status(404).json({
        error: "NO_OPTION_CHAIN_DOC",
        hint: "No matching NIFTY chain found in this DB. See available expiries and verify DB name/collection.",
        collection_count: count,
        available_expiries: anyExp,
        tried: { securityId, seg, symbol, requestedExpiry: requested },
      });
    }

    const docExpiryISO =
      typeof (doc as any).expiry === "string"
        ? (doc as any).expiry.slice(0, 10)
        : new Date((doc as any).expiry).toISOString().slice(0, 10);

    const live = await fetchSpotFromTicks(requireDb(), securityId, seg, symbol, chosenExpiry || docExpiryISO);
    if (live.spot !== null) {
      (doc as any).last_price = live.spot; // override for compute consistency
    }

    const lot = await getLotSize(requireDb(), securityId, seg);
    const computed = computeGexFromCachedDoc(doc as any, lot);

    return res.json({
      symbol: (doc as any).underlying_symbol || "NIFTY",
      underlying_security_id: (doc as any).underlying_security_id,
      underlying_segment: (doc as any).underlying_segment,
      expiry: docExpiryISO,
      spot: live.spot !== null ? live.spot : computed.spot,
      spot_source: live.spot !== null ? "option_chain_ticks.last_price" : "option_chain.last_price",
      spot_ts: live.ts || (doc as any).updated_at,
      lot_size: computed.lot_size,
      total_gex_oi: computed.total_gex_oi,
      total_gex_vol: computed.total_gex_vol,
      total_gex_oi_raw: computed.total_gex_oi_raw,
      total_gex_vol_raw: computed.total_gex_vol_raw,
      zero_gamma_oi: computed.zero_gamma_oi,
      zero_gamma_vol: computed.zero_gamma_vol,
      rows: computed.rows,
      updated_at: (doc as any).updated_at,
      source: "mongo:option_chain",
    });
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error("[getNiftyGexFromCache]", e?.message || e);
    return res.status(500).json({ error: "GEX_CACHE_FAILED", detail: String(e?.message || e) });
  }
};

/* ────────────────────────────────────────────────────────────
 *  GET /api/gex/nifty/ticks?expiry=YYYY-MM-DD[&fmt=candles&tf=1m]
 * ──────────────────────────────────────────────────────────── */
export const getNiftyTicksToday: any = async (req: Request, res: Response) => {
  try {
    const securityId = envInt("NIFTY_SECURITY_ID", 13);
    const seg = process.env.NIFTY_UNDERLYING_SEG || "IDX_I";
    const symbol = process.env.NIFTY_SYMBOL || "NIFTY";

    // Resolve expiry similar to cache endpoint
    const collOC = requireDb().collection("option_chain");
    const loose = looseByIdSegSym(securityId, seg, symbol);
    const requested = (req.query.expiry as string | undefined)?.slice(0, 10) || null;

    let expiryISO = requested;
    if (!expiryISO) {
      const exps = await listDistinctExpiries(collOC, loose);
      const todayISO = new Date().toISOString().slice(0, 10);
      const picked = pickNearestOrLatest(exps, todayISO);
      if (!picked) return res.status(404).json({ error: "NO_EXPIRY_AVAILABLE" });
      expiryISO = picked;
    }

    const { startUTC, endUTC, ymd } = istTodayBoundsUTC();

    const ticksColl = requireDb().collection("option_chain_ticks");
    const filter = ticksFilter(securityId, seg, symbol, expiryISO!, startUTC, endUTC);

    const fmt = String(req.query.fmt || "line");   // "line" | "candles"
    const tf = String(req.query.tf || "1m");       // for candles: only 1m supported here

    const raw = await ticksColl.find(filter, {
      sort: { ts: 1, _id: 1 },
      projection: { last_price: 1, ts: 1 },
    }).toArray();

    if (raw.length === 0) {
      return res.json({
        symbol,
        expiry: expiryISO,
        trading_day_ist: ymd,
        from: startUTC.toISOString(),
        to: endUTC.toISOString(),
        points: [],
        count: 0,
      });
    }

    if (fmt === "candles") {
      if (tf !== "1m") return res.status(400).json({ error: "ONLY_1M_SUPPORTED" });
      const bucketMs = 60_000;
      const map = new Map<number, { o: number; h: number; l: number; c: number }>();
      for (const t of raw) {
        const x = Math.floor(new Date(t.ts as any as string).getTime() / bucketMs) * bucketMs;
        const p = Number((t as any).last_price);
        if (!Number.isFinite(p)) continue;
        const row = map.get(x);
        if (!row) map.set(x, { o: p, h: p, l: p, c: p });
        else {
          row.h = Math.max(row.h, p);
          row.l = Math.min(row.l, p);
          row.c = p;
        }
      }
      const candles = Array.from(map.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([x, v]) => ({ x, y: [v.o, v.h, v.l, v.c] as [number, number, number, number] }));

      return res.json({
        symbol,
        expiry: expiryISO,
        trading_day_ist: ymd,
        from: startUTC.toISOString(),
        to: endUTC.toISOString(),
        tf: "1m",
        candles,
        count: candles.length,
      });
    }

    const points = raw
      .map((r) => ({ x: new Date(r.ts as any as string).getTime(), y: Number((r as any).last_price) }))
      .filter((p) => Number.isFinite(p.y));

    return res.json({
      symbol,
      expiry: expiryISO,
      trading_day_ist: ymd,
      from: startUTC.toISOString(),
      to: endUTC.toISOString(),
      points,
      count: points.length,
    });
  } catch (e: any) {
    console.error("[getNiftyTicksToday]", e?.message || e);
    return res.status(500).json({ error: "TICKS_FETCH_FAILED", detail: String(e?.message || e) });
  }
};

/* ────────────────────────────────────────────────────────────
 *  GET /api/gex/nifty/cache/expiries
 * ──────────────────────────────────────────────────────────── */
export const listNiftyCacheExpiries: any = async (_req: Request, res: Response) => {
  try {
    const securityId = envInt("NIFTY_SECURITY_ID", 13);
    const seg = process.env.NIFTY_UNDERLYING_SEG || "IDX_I";
    const symbol = process.env.NIFTY_SYMBOL || "NIFTY";
    const coll: Collection<Document> = requireDb().collection("option_chain");
    const expiries = await listDistinctExpiries(coll, looseByIdSegSym(securityId, seg, symbol));
    return res.json({ symbol, securityId, seg, expiries });
  } catch (e: any) {
    return res.status(500).json({ error: "EXPIRIES_LIST_FAILED", detail: String(e?.message || e) });
  }
};

/* ────────────────────────────────────────────────────────────
 *  Debug
 * ──────────────────────────────────────────────────────────── */
export const optionChainDebugSummary: any = async (_req: Request, res: Response) => {
  try {
    const coll: Collection<Document> = requireDb().collection("option_chain");
    const [count, sample] = await Promise.all([
      coll.estimatedDocumentCount(),
      coll
        .find({})
        .project({
          underlying_security_id: 1,
          underlying_segment: 1,
          underlying_symbol: 1,
          expiry: 1,
          updated_at: 1,
        })
        .sort({ updated_at: -1, _id: -1 })
        .limit(3)
        .toArray(),
    ]);

    const variants = await coll
      .aggregate([
        {
          $group: {
            _id: {
              id: "$underlying_security_id",
              seg: "$underlying_segment",
              sym: "$underlying_symbol",
              expStr: {
                $cond: [
                  { $eq: [{ $type: "$expiry" }, "string"] },
                  { $substrCP: ["$expiry", 0, 10] },
                  { $dateToString: { format: "%Y-%m-%d", date: "$expiry" } },
                ],
              },
            },
            n: { $sum: 1 },
          },
        },
        { $sort: { "_id.expStr": 1 } },
        { $limit: 50 },
      ])
      .toArray();

    return res.json({ collection_count: count, latest_samples: sample, variants });
  } catch (e: any) {
    return res.status(500).json({ error: "OC_DEBUG_FAILED", detail: String(e?.message || e) });
  }
};

/* ────────────────────────────────────────────────────────────
 *  NEW: GET /api/gex/nifty/bulk?expiry=YYYY-MM-DD&scope=today
 *       opt: &scope=since&sinceMin=1440
 *  → returns { day, gex:{...rows...}, ticks:{...points...} } with ETag
 * ──────────────────────────────────────────────────────────── */
type OcRowsCacheDoc = {
  key: string;
  symbol: string;
  expiry: string;
  rows: ReturnType<typeof computeGexFromCachedDoc>["rows"];
  lot_size: number;
  total_gex_oi_raw: number;
  total_gex_vol_raw: number;
  total_gex_oi: number;
  total_gex_vol: number;
  zero_gamma_oi: number | null;
  zero_gamma_vol: number | null;
  source_updated_at?: Date | string;
  updated_at: Date;
};

function buildETag(identity: unknown) {
  const b = JSON.stringify(identity);
  return `"gexbulk-${crypto.createHash("md5").update(b).digest("hex")}"`;
}

async function getOrBuildOcRowsCache(
  _db: Db,
  securityId: number,
  seg: string,
  symbol: string,
  expiryISO: string
) {
  const cache = _db.collection<OcRowsCacheDoc>("oc_rows_cache");
  const oc = _db.collection("option_chain");

  const key = `${symbol}|${expiryISO}`;

  const latestSrc = await oc.findOne(
    { $and: [looseByIdSegSym(securityId, seg, symbol), expiryClause(expiryISO)] },
    { sort: { updated_at: -1, _id: -1 }, projection: { updated_at: 1 } }
  );
  const srcUpdatedAt = (latestSrc as any)?.updated_at;

  const cached = await cache.findOne({ key });

  const cacheStale =
    !cached ||
    (srcUpdatedAt &&
      new Date(cached.source_updated_at as any).getTime() <
        new Date(srcUpdatedAt as any).getTime());

  if (!cacheStale) {
    return { cached, rebuilt: false };
  }

  const collOC = oc;
  const loose = looseByIdSegSym(securityId, seg, symbol);
  const full = await collOC.findOne(
    { $and: [loose, expiryClause(expiryISO)] },
    { sort: { updated_at: -1, _id: -1 } }
  );
  if (!full) return { cached: null, rebuilt: false };

  const lot = await getLotSize(_db, securityId, seg);
  const computed = computeGexFromCachedDoc(full as any, lot);

  const doc: OcRowsCacheDoc = {
    key,
    symbol,
    expiry: expiryISO,
    rows: computed.rows,
    lot_size: computed.lot_size,
    total_gex_oi_raw: computed.total_gex_oi_raw,
    total_gex_vol_raw: computed.total_gex_vol_raw,
    total_gex_oi: computed.total_gex_oi,
    total_gex_vol: computed.total_gex_vol,
    zero_gamma_oi: computed.zero_gamma_oi,
    zero_gamma_vol: computed.zero_gamma_vol,
    source_updated_at: (full as any).updated_at,
    updated_at: new Date(),
  };

  await cache.updateOne({ key }, { $set: doc }, { upsert: true });
  return { cached: doc, rebuilt: true };
}

export const getNiftyGexBulk: any = async (req: Request, res: Response) => {
  try {
    const securityId = envInt("NIFTY_SECURITY_ID", 13);
    const seg = process.env.NIFTY_UNDERLYING_SEG || "IDX_I";
    const symbol = process.env.NIFTY_SYMBOL || "NIFTY";
    const expiryReq = (req.query.expiry as string | undefined)?.slice(0, 10) || null;

    const collOC = requireDb().collection("option_chain");
    const loose = looseByIdSegSym(securityId, seg, symbol);

    let expiryISO = expiryReq;
    if (!expiryISO) {
      const exps = await listDistinctExpiries(collOC, loose);
      const todayISO = new Date().toISOString().slice(0, 10);
      const picked = pickNearestOrLatest(exps, todayISO);
      if (!picked) return res.status(404).json({ error: "NO_EXPIRY_AVAILABLE" });
      expiryISO = picked;
    }

    const scope = String(req.query.scope || "today");
    const sinceMin = Math.max(1, parseInt(String(req.query.sinceMin || "1440"), 10) || 1440);
    const { startUTC, endUTC, ymd } = istTodayBoundsUTC_orSince(scope, sinceMin);

    // rows (via oc_rows_cache)
    const { cached } = await getOrBuildOcRowsCache(requireDb(), securityId, seg, symbol, expiryISO!);
    if (!cached) return res.status(404).json({ error: "ROWS_CACHE_EMPTY" });

    // spot (latest)
    const live = await fetchSpotFromTicks(requireDb(), securityId, seg, symbol, expiryISO!);
    const spot = live.spot ?? 0;

    // ticks within window
    const ticksColl = requireDb().collection("option_chain_ticks");
    const filter = ticksFilter(securityId, seg, symbol, expiryISO!, startUTC, endUTC);
    const rawTicks = await ticksColl
      .find(filter, { sort: { ts: 1, _id: 1 }, projection: { last_price: 1, ts: 1 } })
      .toArray();
    const points = rawTicks
      .map((r) => ({ x: new Date((r as any).ts).getTime(), y: Number((r as any).last_price) }))
      .filter((p) => Number.isFinite(p.y));

    const gexPayload = {
      symbol,
      expiry: expiryISO,
      spot: spot || 0,
      rows: cached.rows,
      updated_at: cached.source_updated_at,
      lot_size: cached.lot_size,
      totals: {
        gex_oi_raw: cached.total_gex_oi_raw,
        gex_vol_raw: cached.total_gex_vol_raw,
        gex_oi: cached.total_gex_oi,
        gex_vol: cached.total_gex_vol,
      },
      zero_gamma_oi: cached.zero_gamma_oi,
      zero_gamma_vol: cached.zero_gamma_vol,
    };

    const ticksPayload = {
      symbol,
      expiry: expiryISO,
      trading_day_ist: ymd,
      from: startUTC.toISOString(),
      to: endUTC.toISOString(),
      points,
      count: points.length,
    };

    const lastTick = points.length ? points[points.length - 1].x : 0;
    const identity = {
      day: ymd,
      expiry: expiryISO,
      rowsN: cached.rows.length,
      rowsU: cached.updated_at,
      tickN: points.length,
      lastTick,
      spot,
    };
    const etag = buildETag(identity);

    const inm = req.headers["if-none-match"];
    if (inm && inm === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader("ETag", etag);
    res.setHeader("X-GEX-Day", ymd);
    res.setHeader("Cache-Control", "no-store");
    res.json({ day: ymd, gex: gexPayload, ticks: ticksPayload });
  } catch (e: any) {
    console.error("[getNiftyGexBulk]", e?.message || e);
    return res.status(500).json({ error: "GEX_BULK_FAILED", detail: String(e?.message || e) });
  }
};
