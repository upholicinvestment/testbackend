// src/api/advdec.ts
import { Express, Request, Response } from "express";
import { Db } from "mongodb";

/* ---------- Helpers ---------- */

// IST label for a Date
function labelIST(d: Date): string {
  return d.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });
}

function minutesAgoDate(min: number): Date {
  return new Date(Date.now() - Math.max(1, Math.floor(min)) * 60_000);
}

/**
 * Run aggregation for a single bin size. The logic:
 *  - Filter FUTSTK (optionally a single expiry)
 *  - Restrict to received_at >= cutoff
 *  - Truncate to IST "slots" using $dateTrunc with binSize
 *  - For each (slot, security_id) keep the latest tick
 *  - Group by slot to count advances/declines
 *  - Sort by slot ascending
 */
async function fetchSeriesForBin(db: Db, binSize: number, sinceMin: number, expiry?: string) {
  const cutoff = minutesAgoDate(sinceMin);

  const baseMatch: Record<string, any> = {
    instrument_type: "FUTSTK",
    exchange: "NSE_FNO",
    received_at: { $gte: cutoff },
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

  const docs = await db.collection("nse_futstk_ticks").aggregate(pipeline, { allowDiskUse: true }).toArray();

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
/*                            ROUTES (legacy single-bin)                      */
/* ========================================================================== */

export function AdvDec(app: Express, db: Db) {
  /**
   * Legacy/simple endpoint (kept for compatibility):
   * GET /api/advdec?bin=5&sinceMin=1440&expiry=YYYY-MM-DD
   * Returns { current, chartData } for ONE bin only.
   */
  app.get("/api/advdec", async (req: Request, res: Response): Promise<void> => {
    try {
      const binSize = Math.max(1, Number(req.query.bin) || 5);
      const sinceMin = Math.max(1, Number(req.query.sinceMin) || 1440); // 24h backfill by default
      const expiryParam =
        typeof req.query.expiry === "string" && req.query.expiry.trim()
          ? req.query.expiry.trim()
          : undefined;

      const { series, current } = await fetchSeriesForBin(db, binSize, sinceMin, expiryParam);

      // Keep response shape identical to previous legacy version: { current, chartData }
      res.setHeader("Cache-Control", "no-store");
      res.json({
        current,
        chartData: series.map(({ timestamp, time, advances, declines }) => ({
          timestamp,
          time,
          advances,
          declines,
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
}
