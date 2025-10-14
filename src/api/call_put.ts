import type { Express, Request, Response, RequestHandler } from "express";
import type { Db } from "mongodb";

/* ----------------------------- Types ------------------------------ */
type Leg = { oi?: number | null };

type StrikeRow = {
  strike: number;
  ce?: Leg | null;
  pe?: Leg | null;
};

type TickDoc = {
  underlying_security_id: number;
  underlying_segment: string;
  expiry: string;           // ISO yyyy-mm-dd
  ts: Date;                 // tick timestamp (UTC)
  last_price: number;       // underlying LTP
  strikes: StrikeRow[];     // normalized strikes
};

/* --------------------------- Utilities ---------------------------- */
const LOG = (process.env.OC_LOG_VERBOSE ?? "true").toLowerCase() === "true";
const log = (...a: unknown[]) => { if (LOG) console.log("[OI]", ...a); };

const toISO = (d: Date | string | number) => new Date(d).toISOString();

function detectStrikeStep(rows: StrikeRow[]): number {
  const uniques = Array.from(
    new Set(rows.map(r => Number(r?.strike)).filter(Number.isFinite))
  ).sort((a, b) => a - b);

  for (let i = 1; i < uniques.length; i++) {
    const diff = Math.abs(uniques[i] - uniques[i - 1]);
    if (diff > 0) return diff;
  }
  return 50; // sensible default for NIFTY
}

const roundToStep = (px: number, step: number) => Math.round(px / step) * step;
const minutesToMs = (min: number) => Math.max(1, Math.floor(min)) * 60 * 1000;
const binKey = (ts: Date, binMs: number) => Math.floor(ts.getTime() / binMs) * binMs;

function tradingDayWindowFrom(d: Date): { dayStart: Date; dayEnd: Date } {
  // UTC midnight → next midnight (matches stored ts)
  const dayStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  return { dayStart, dayEnd };
}

/* --------------------------- Route impls -------------------------- */
export default function registerNiftyRoutes(app: Express, db: Db) {
  // Strongly typed collection handle
  const ticksCol = db.collection<TickDoc>("option_chain_ticks");

  /**
   * GET /api/nifty/atm?interval=3
   * "Fixed ATM" — locks to the latest ATM strike at fetch time,
   * then returns CE/PE OI for THAT SAME strike across the whole day window.
   */
  const atmHandler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const intervalMin = Math.max(1, parseInt(String(req.query.interval || "3"), 10));
      const id = Number(process.env.OC_UNDERLYING_ID ?? 13);
      const seg = String(process.env.OC_SEGMENT ?? "IDX_I");

      // 1) Latest tick → detect expiry + day window
      const latestArr = await ticksCol
        .find({ underlying_security_id: id, underlying_segment: seg })
        .sort({ ts: -1 })
        .limit(1)
        .toArray();

      if (!latestArr.length) {
        res.status(404).json({ error: "No option_chain_ticks for underlying/segment." });
        return;
      }
      const latest = latestArr[0];
      const { dayStart, dayEnd } = tradingDayWindowFrom(latest.ts);

      // 2) Load all ticks for the same expiry/day
      const docs = await ticksCol
        .find(
          {
            underlying_security_id: id,
            underlying_segment: seg,
            expiry: latest.expiry,
            ts: { $gte: dayStart, $lt: dayEnd },
          },
          { projection: { ts: 1, last_price: 1, strikes: 1, expiry: 1 } as const }
        )
        .sort({ ts: 1 })
        .toArray();

      if (!docs.length) {
        res.status(404).json({ error: "No ticks found in the date window." });
        return;
      }

      // 3) Determine strike step, then FIX the ATM strike from the *latest* LTP
      let step = 50;
      for (const d of docs) {
        if (Array.isArray(d.strikes) && d.strikes.length) { step = detectStrikeStep(d.strikes); break; }
      }
      const fixedAtm = roundToStep(latest.last_price, step);
      log("ATM window (fixed)", { expiry: latest.expiry, step, fixedAtm, start: toISO(dayStart), end: toISO(dayEnd) });

      // 4) Bin by interval; take latest tick’s OI for the *fixedAtm*.
      //    Carry forward last known OI if the fixed strike row is briefly missing.
      const binMs = minutesToMs(intervalMin);
      type AtmBin = { ts: Date; callOI: number; putOI: number };
      const bins = new Map<number, AtmBin>();

      let lastCE = 0;
      let lastPE = 0;

      for (const doc of docs) {
        const key = binKey(new Date(doc.ts), binMs);

        let ceOI = lastCE;
        let peOI = lastPE;

        if (Array.isArray(doc.strikes)) {
          const row = (doc.strikes as StrikeRow[]).find(r => r?.strike === fixedAtm);
          if (row) {
            const c = Number(row?.ce?.oi ?? NaN);
            const p = Number(row?.pe?.oi ?? NaN);
            if (Number.isFinite(c)) ceOI = c;
            if (Number.isFinite(p)) peOI = p;
          }
        }

        lastCE = ceOI;
        lastPE = peOI;
        bins.set(key, { ts: new Date(key), callOI: ceOI, putOI: peOI });
      }

      const series = Array.from(bins.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({
          timestamp: v.ts.toISOString(),
          atmStrike: fixedAtm,     // constant across the series
          callOI: v.callOI,
          putOI: v.putOI,
        }));

      res.json({ expiry: latest.expiry, step, atmStrike: fixedAtm, series });
    } catch (e: any) {
      console.error("ATM handler error:", e?.message || e);
      res.status(500).json({ error: "Internal server error" });
    }
  };

  /**
   * GET /api/nifty/overall?interval=3
   * Sum CE/PE OI across ALL strikes (same expiry/day), per time bin.
   */
  const overallHandler: RequestHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const intervalMin = Math.max(1, parseInt(String(req.query.interval || "3"), 10));
      const id = Number(process.env.OC_UNDERLYING_ID ?? 13);
      const seg = String(process.env.OC_SEGMENT ?? "IDX_I");

      // 1) Latest tick → detect expiry + day window
      const latestArr = await ticksCol
        .find({ underlying_security_id: id, underlying_segment: seg })
        .sort({ ts: -1 })
        .limit(1)
        .toArray();

      if (!latestArr.length) {
        res.status(404).json({ error: "No option_chain_ticks for underlying/segment." });
        return;
      }
      const latest = latestArr[0];
      const { dayStart, dayEnd } = tradingDayWindowFrom(latest.ts);

      // 2) Load all ticks for that expiry/day
      const docs = await ticksCol
        .find(
          {
            underlying_security_id: id,
            underlying_segment: seg,
            expiry: latest.expiry,
            ts: { $gte: dayStart, $lt: dayEnd },
          },
          { projection: { ts: 1, strikes: 1, expiry: 1 } as const }
        )
        .sort({ ts: 1 })
        .toArray();

      if (!docs.length) {
        res.status(404).json({ error: "No ticks found in the date window." });
        return;
      }

      // 3) Bin total CE/PE OI (sum across all strikes)
      const binMs = minutesToMs(intervalMin);
      type TotalBin = { ts: Date; callOI: number; putOI: number };
      const bins = new Map<number, TotalBin>();

      for (const doc of docs) {
        const key = binKey(new Date(doc.ts), binMs);
        const strikes = Array.isArray(doc.strikes) ? (doc.strikes as StrikeRow[]) : [];
        const sumCE = strikes.reduce<number>((acc, r) => acc + (Number(r?.ce?.oi ?? 0) || 0), 0);
        const sumPE = strikes.reduce<number>((acc, r) => acc + (Number(r?.pe?.oi ?? 0) || 0), 0);
        bins.set(key, { ts: new Date(key), callOI: sumCE, putOI: sumPE });
      }

      const step = (() => {
        for (const d of docs) if (Array.isArray(d.strikes) && d.strikes.length) return detectStrikeStep(d.strikes);
        return 50;
      })();

      const series = Array.from(bins.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, v]) => ({
          timestamp: v.ts.toISOString(),
          callOI: v.callOI,
          putOI: v.putOI,
        }));

      res.json({ expiry: latest.expiry, step, series });
    } catch (e: any) {
      console.error("OVERALL handler error:", e?.message || e);
      res.status(500).json({ error: "Internal server error" });
    }
  };

  app.get("/api/nifty/atm", atmHandler);
  app.get("/api/nifty/overall", overallHandler);
}
