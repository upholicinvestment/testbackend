import { Express, Request, Response } from "express";
import { Db } from "mongodb";

function todayISTString(): string {
  // Returns YYYY-MM-DD for the current day in Asia/Kolkata
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function AdvDec(app: Express, db: Db) {
  app.get("/api/advdec", async (req: Request, res: Response): Promise<void> => {
    try {
      const binSize = Math.max(1, Number(req.query.bin) || 5); // minutes per bar
      const todayIST = todayISTString();
      const expiryParam =
        typeof req.query.expiry === "string" && req.query.expiry.trim()
          ? req.query.expiry.trim()
          : undefined;

      // Base match: we only want FUTSTK from the NSE_FNO feed
      const baseMatch: Record<string, any> = {
        instrument_type: "FUTSTK",
        exchange: "NSE_FNO",
      };
      if (expiryParam) {
        baseMatch.expiry_date = expiryParam; // restrict to one expiry if asked
      }

      const pipeline: any[] = [
        { $match: baseMatch },
        // Keep only docs from "today" in IST (no dependency on server tz)
        {
          $addFields: {
            istDate: {
              $dateToString: {
                date: "$received_at",
                format: "%Y-%m-%d",
                timezone: "Asia/Kolkata",
              },
            },
          },
        },
        { $match: { istDate: todayIST } },

        // Build a 5-min (configurable) slot in IST
        {
          $addFields: {
            slot: {
              $dateTrunc: {
                date: "$received_at",
                unit: "minute",
                binSize: binSize,
                timezone: "Asia/Kolkata",
              },
            },
          },
        },

        // Sort newest first, then keep the latest tick per (slot, security_id)
        { $sort: { received_at: -1 } },
        {
          $group: {
            _id: { slot: "$slot", security_id: "$security_id" },
            latest: { $first: "$$ROOT" },
          },
        },
        // Group by slot for charting
        {
          $group: {
            _id: "$_id.slot",
            stocks: { $push: "$latest" },
          },
        },
        { $sort: { _id: 1 } },

        // Keep only the fields we need for counting
        {
          $project: {
            _id: 1,
            stocks: {
              $map: {
                input: "$stocks",
                as: "s",
                in: {
                  security_id: "$$s.security_id",
                  LTP: "$$s.LTP",
                  close: "$$s.close",
                },
              },
            },
          },
        },
      ];

      const result = await db
        .collection("nse_futstk_ticks")
        .aggregate(pipeline, { allowDiskUse: true })
        .toArray();

      // Build the UI payload
      const now = new Date();
      const chartData = result
        .filter((slot) => new Date(slot._id) <= now)
        .map((slot) => {
          const time = new Date(slot._id).toLocaleTimeString("en-IN", {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
            timeZone: "Asia/Kolkata",
          });

          let advances = 0;
          let declines = 0;

          for (const s of slot.stocks as Array<{ LTP: any; close: any }>) {
            const ltp = Number(s.LTP) || 0;
            const close = Number(s.close) || 0;
            if (ltp > close) advances++;
            else if (ltp < close) declines++;
          }

          return { time, advances, declines };
        });

      const latest = chartData.at(-1);
      const current = {
        advances: latest?.advances ?? 0,
        declines: latest?.declines ?? 0,
        total: (latest?.advances ?? 0) + (latest?.declines ?? 0),
      };

      res.json({ current, chartData });
    } catch (err) {
      console.error("Error in /api/advdec:", err);
      res.status(500).json({
        error: "Internal Server Error",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  });
}