// src/api/advdec.ts
import { Express, Request, Response } from "express";
import { Db } from "mongodb";
import crypto from "crypto";

/* ---------- Helpers ---------- */

// Label in IST for chart
function labelIST(d: Date): string {
  return d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });
}

// YYYY-MM-DD (IST)
function dayISTString(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// Today’s trading window in IST (returns UTC instants)
function istTradingBounds(d = new Date()) {
  const day = dayISTString(d);
  const start = new Date(`${day}T09:15:00+05:30`);
  const end   = new Date(`${day}T15:30:00+05:30`);
  return { start, end, day };
}

/** Build an ETag string from a simple identity summary */
function buildETag(identity: unknown) {
  const basis = JSON.stringify(identity);
  return `"advdec-${crypto.createHash("md5").update(basis).digest("hex")}"`;
}

/**
 * Aggregate one series for a given bin within [start,end) (UTC instants), IST truncation.
 * - Filters only today’s session window by received_at.
 * - Truncates to IST slots via $dateTrunc with binSize.
 * - Keeps latest per (slot, security_id), then counts adv/dec.
 */
async function fetchSeriesForBin(
  db: Db,
  binSize: number,
  start: Date,
  end: Date,
  expiry?: string
) {
  const baseMatch: Record<string, any> = {
    instrument_type: "FUTSTK",
    exchange: "NSE_FNO",
    received_at: { $gte: start, $lt: end },
  };
  if (expiry) baseMatch.expiry_date = expiry;

  const pipeline: any[] = [
    { $match: baseMatch },
    {
      $addFields: {
        slot: {
          $dateTrunc: {
            date: "$received_at",
            unit: "minute",
            binSize,
            timezone: "Asia/Kolkata",
          },
        },
      },
    },
    { $sort: { received_at: -1 } },
    {
      $group: {
        _id: { slot: "$slot", security_id: "$security_id" },
        latest: { $first: "$$ROOT" },
      },
    },
    {
      $group: {
        _id: "$_id.slot",
        stocks: {
          $push: {
            LTP: "$latest.LTP",
            close: "$latest.close",
          },
        },
      },
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 1,
        advances: {
          $size: {
            $filter: {
              input: "$stocks",
              as: "s",
              cond: { $gt: [{ $toDouble: "$$s.LTP" }, { $toDouble: "$$s.close" }] },
            },
          },
        },
        declines: {
          $size: {
            $filter: {
              input: "$stocks",
              as: "s",
              cond: { $lt: [{ $toDouble: "$$s.LTP" }, { $toDouble: "$$s.close" }] },
            },
          },
        },
      },
    },
  ];

  const docs = await db
    .collection("nse_futstk_ticks")
    .aggregate(pipeline, { allowDiskUse: true })
    .toArray();

  const series = docs.map((d) => {
    const ts = new Date(d._id);
    return {
      timestamp: ts.toISOString(),
      time: labelIST(ts),
      advances: Number(d.advances || 0),
      declines: Number(d.declines || 0),
      total: Number(d.advances || 0) + Number(d.declines || 0),
    };
  });

  const latest = series.at(-1) || null;
  const current = latest
    ? { advances: latest.advances, declines: latest.declines, total: latest.total }
    : { advances: 0, declines: 0, total: 0 };

  return { series, current, lastSlotISO: latest?.timestamp || null };
}

/* ========================================================================== */
/*                                   ROUTES                                   */
/* ========================================================================== */

export function AdvDec(app: Express, db: Db) {
  /**
   * Legacy/simple endpoint (compat):
   * GET /api/advdec?bin=5&expiry=YYYY-MM-DD
   * NEW default: clamps to *today’s IST trading window*.
   * You may opt-out with ?scope=since&sinceMin=1440 (kept for rare use).
   */
  app.get("/api/advdec", async (req: Request, res: Response): Promise<void> => {
    try {
      const binSize = Math.max(1, Number(req.query.bin) || 5);
      const expiryParam =
        typeof req.query.expiry === "string" && req.query.expiry.trim()
          ? req.query.expiry.trim()
          : undefined;

      const scope = String(req.query.scope || "today"); // "today" (default) | "since"
      let start: Date, end: Date, day: string;

      if (scope === "since") {
        // opt-out path: rolling window (kept for debugging; not recommended for UI)
        const sinceMin = Math.max(1, Number(req.query.sinceMin) || 1440);
        start = new Date(Date.now() - sinceMin * 60_000);
        end = new Date();
        day = dayISTString(); // just a label; may cross midnight
      } else {
        const b = istTradingBounds();
        start = b.start; end = b.end; day = b.day;
      }

      const { series, current } = await fetchSeriesForBin(db, binSize, start, end, expiryParam);

      res.setHeader("X-AdvDec-Day", day);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        day,
        current,
        chartData: series.map(({ time, advances, declines, timestamp, total }) => ({
          ts: timestamp,
          time,
          advances,
          declines,
          total,
        })),
      });
    } catch (err) {
      console.error("Error in /api/advdec:", err);
      res.status(500).json({
        error: "Internal Server Error",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });

  /**
   * Bulk + ETag + today’s session window by default
   * GET /api/advdec/bulk?intervals=3,5,15,30&expiry=YYYY-MM-DD
   * Opt-out window with ?scope=since&sinceMin=1440
   */
  app.get("/api/advdec/bulk", async (req: Request, res: Response): Promise<void> => {
    try {
      const raw = String(req.query.intervals ?? "3,5,15,30")
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((n) => [1, 3, 5, 10, 15, 30, 60].includes(n));
      const intervals = raw.length ? Array.from(new Set(raw)).sort((a, b) => a - b) : [5];

      const expiryParam =
        typeof req.query.expiry === "string" && req.query.expiry.trim()
          ? req.query.expiry.trim()
          : undefined;

      const scope = String(req.query.scope || "today"); // "today" (default) | "since"
      let start: Date, end: Date, day: string;

      if (scope === "since") {
        const sinceMin = Math.max(1, Number(req.query.sinceMin) || 1440);
        start = new Date(Date.now() - sinceMin * 60_000);
        end = new Date();
        day = dayISTString();
      } else {
        const b = istTradingBounds();
        start = b.start; end = b.end; day = b.day;
      }

      const rows: Record<
        string,
        Array<{ timestamp: string; time: string; advances: number; declines: number; total: number }>
      > = {};
      let lastISO: string | null = null;
      let current = { advances: 0, declines: 0, total: 0 };

      for (const m of intervals) {
        const { series, current: cur, lastSlotISO } = await fetchSeriesForBin(
          db, m, start, end, expiryParam
        );
        rows[String(m)] = series;
        if (!lastISO || (lastSlotISO && lastSlotISO > lastISO)) lastISO = lastSlotISO;
        if (m === Math.min(...intervals)) current = cur;
      }

      // Build ETag including day + sizes + last slot
      const identity = {
        day,
        lastISO,
        keys: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.length])),
        cur: current,
        expiry: expiryParam || null,
        scope,
      };
      const etag = buildETag(identity);

      const ifNoneMatch = req.headers["if-none-match"];
      if (ifNoneMatch && ifNoneMatch === etag) {
        res.status(304).end();
        return;
      }

      res.setHeader("ETag", etag);
      res.setHeader("X-AdvDec-Day", day);
      res.setHeader("Cache-Control", "no-store");
      res.json({ day, current, rows, lastISO });
    } catch (err) {
      console.error("Error in /api/advdec/bulk:", err);
      res.status(500).json({
        error: "Internal Server Error",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });
}
