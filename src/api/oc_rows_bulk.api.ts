//oc_rowa_bulk.api.ts
import type { Express, Request, Response, NextFunction } from "express";
import type { Db } from "mongodb";
import crypto from "crypto";

/** Valid intervals we support */
const ALLOWED_INTERVALS = new Set<number>([3, 5, 15, 30]);

type CacheDoc = {
  underlying_security_id: number;
  underlying_segment: string;
  expiry: string;
  intervalMin: number;
  mode: "level" | "delta";
  unit: "bps" | "pct" | "points";
  tsBucket: Date;           // cached bucket timestamp (start or end; label is recomputed)
  time: string;             // stored human-readable (not trusted for output)
  volatility: number;
  signal: "Bullish" | "Bearish";
  spot: number;
  updated_at?: Date;
};

type RowOut = Pick<
  CacheDoc,
  "volatility" | "time" | "signal" | "spot" | "tsBucket" | "updated_at"
>;

const CACHE_COLL = "oc_rows_cache";
const TICKS_COLL = process.env.OC_SOURCE_COLL || "option_chain_ticks";

/* ---- Time helpers (IST, session anchored at 09:15) ---- */
const IST_OFFSET_MIN = 330; // +05:30
const IST_OFFSET_MS = IST_OFFSET_MIN * 60_000;
const DAY_MS = 86_400_000;
const SESSION_START_MIN = 9 * 60 + 15; // 09:15 IST

const dtfIST = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour12: false,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
function timeIST(d: Date) {
  return dtfIST.format(d) + " IST";
}

function istDayStartMs(utcMs: number) {
  const istMs = utcMs + IST_OFFSET_MS;
  return Math.floor(istMs / DAY_MS) * DAY_MS;
}
function ceilToSessionBucketEndUTC(dUTC: Date, intervalMin: number): Date {
  const intervalMs = Math.max(1, intervalMin) * 60_000;
  const utcMs = dUTC.getTime();
  const dayStartIst = istDayStartMs(utcMs);
  const sessionAnchorIst = dayStartIst + SESSION_START_MIN * 60_000;
  const istNow = utcMs + IST_OFFSET_MS;
  const k = Math.ceil((istNow - sessionAnchorIst) / intervalMs);
  const endIst = sessionAnchorIst + k * intervalMs;
  return new Date(endIst - IST_OFFSET_MS);
}

/** Resolve active expiry from latest option_chain or ticks */
async function resolveActiveExpiry(
  db: Db,
  underlying: number,
  segment: string
): Promise<string | null> {
  const snap = await db
    .collection("option_chain")
    .find({ underlying_security_id: underlying, underlying_segment: segment } as any)
    .project({ expiry: 1, updated_at: 1 })
    .sort({ updated_at: -1 })
    .limit(1)
    .toArray();

  if (snap.length && (snap[0] as any)?.expiry) {
    return String((snap[0] as any).expiry);
  }

  const tick = await db
    .collection(TICKS_COLL)
    .find({ underlying_security_id: underlying, underlying_segment: segment } as any)
    .project({ expiry: 1, ts: 1 })
    .sort({ ts: -1 })
    .limit(1)
    .toArray();

  if (tick.length && (tick[0] as any)?.expiry) {
    return String((tick[0] as any).expiry);
  }

  return null;
}

/** Build a stable ETag using counts, max ts, and identity */
function buildEtag(payload: {
  underlying: number;
  segment: string;
  expiry: string;
  mode: string;
  unit: string;
  rowsByInterval: Record<string, RowOut[]>;
}) {
  let maxTs = 0;
  let total = 0;
  for (const key of Object.keys(payload.rowsByInterval)) {
    const arr = payload.rowsByInterval[key] || [];
    total += arr.length;
    for (const d of arr) {
      const t = (d.updated_at ? new Date(d.updated_at) : new Date(d.tsBucket)).getTime();
      if (t > maxTs) maxTs = t;
    }
  }
  const basis = JSON.stringify({
    u: payload.underlying,
    s: payload.segment,
    e: payload.expiry,
    m: payload.mode,
    un: payload.unit,
    total,
    maxTs,
    keys: Object.fromEntries(
      Object.entries(payload.rowsByInterval).map(([k, v]) => [k, v.length])
    ),
  });
  return `"vi-${crypto.createHash("md5").update(basis).digest("hex")}"`;
}

/** GET /api/oc/rows/bulk */
export default function registerOcRowsBulk(app: Express, db: Db) {
  app.get(
    "/api/oc/rows/bulk",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // Query params
        const underlying = Number(req.query.underlying ?? 13);
        const segment = String(req.query.segment ?? "IDX_I");
        const mode = String(req.query.mode ?? "level") as "level" | "delta";
        const unit = String(req.query.unit ?? "bps") as "bps" | "pct" | "points";
        const sinceMin = Number(req.query.sinceMin ?? 390); // ~full trading day
        const limit = Math.max(50, Math.min(5000, Number(req.query.limit ?? 2000)));

        // Intervals
        const rawIntervals = String(req.query.intervals ?? "3,5,15,30")
          .split(",")
          .map((x) => Number(x.trim()))
          .filter((n) => ALLOWED_INTERVALS.has(n));
        const intervals = rawIntervals.length ? rawIntervals : [3];

        // Expiry
        const expiryParam = String(req.query.expiry ?? "auto").trim();
        const expiry =
          expiryParam.toLowerCase() === "auto"
            ? (await resolveActiveExpiry(db, underlying, segment)) || "NA"
            : expiryParam;

        if (!expiry || expiry === "NA") {
          res.setHeader("X-Resolved-Expiry", "NA");
          res.json({
            expiry: "NA",
            rows: Object.fromEntries(intervals.map((i) => [String(i), []])),
          });
          return;
        }

        const cutoff = new Date(Date.now() - Math.max(1, sinceMin) * 60_000);
        const coll = db.collection<CacheDoc>(CACHE_COLL);

        const byInterval: Record<string, RowOut[]> = {};

        await Promise.all(
          intervals.map(async (intervalMin) => {
            const docs = (await coll
              .find({
                underlying_security_id: underlying,
                underlying_segment: segment,
                expiry,
                intervalMin,
                mode,
                unit,
                tsBucket: { $gte: cutoff },
              } as any)
              .project({
                volatility: 1,
                time: 1,          // stored, but we recompute label below
                signal: 1,
                spot: 1,
                tsBucket: 1,      // recompute label using session-anchored end
                updated_at: 1,
                _id: 0,
              } as any)
              .sort({ tsBucket: -1 })
              .limit(limit)
              .toArray()) as unknown as RowOut[];

            byInterval[String(intervalMin)] = docs;
          })
        );

        // ETag handling
        const etag = buildEtag({
          underlying,
          segment,
          expiry,
          mode,
          unit,
          rowsByInterval: byInterval,
        });

        const ifNoneMatch = req.headers["if-none-match"];
        if (ifNoneMatch && ifNoneMatch === etag) {
          res.status(304).end();
          return;
        }

        res.setHeader("ETag", etag);
        res.setHeader("X-Resolved-Expiry", expiry);

        // Shape rows for client: label with session-anchored BUCKET END (09:15 IST anchor)
        const rows = Object.fromEntries(
          Object.entries(byInterval).map(([k, v]) => {
            const intervalMin = Number(k);
            return [
              k,
              v.map((d) => {
                const bucketEndUTC = ceilToSessionBucketEndUTC(
                  new Date(d.tsBucket as unknown as Date),
                  intervalMin
                );
                return {
                  volatility: d.volatility,
                  time: timeIST(bucketEndUTC),
                  signal: d.signal,
                  spot: d.spot,
                };
              }),
            ];
          })
        );

        res.json({ expiry, rows });
      } catch (err) {
        next(err);
      }
    }
  );
}
