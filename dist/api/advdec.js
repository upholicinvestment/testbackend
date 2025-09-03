"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdvDec = AdvDec;
function AdvDec(app, db) {
    app.get("/api/advdec", async (_req, res) => {
        try {
            const now = new Date();
            const marketOpen = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 15, 0, 0);
            const marketClose = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 15, 30, 59, 999);
            const pipeline = [
                {
                    $match: {
                        received_at: { $gte: marketOpen, $lte: marketClose },
                        type: "Full Data",
                    },
                },
                {
                    $addFields: {
                        slot: {
                            $dateTrunc: {
                                date: "$received_at",
                                unit: "minute",
                                binSize: 5,
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
                        stocks: { $push: "$latest" },
                    },
                },
                { $sort: { _id: 1 } },
            ];
            const result = await db.collection("nse_fno_stock").aggregate(pipeline).toArray();
            const chartData = result
                .filter((slotData) => new Date(slotData._id) <= now)
                .map((slotData) => {
                const time = new Date(slotData._id).toLocaleTimeString("en-IN", {
                    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata",
                });
                const stocks = slotData.stocks.slice(0, 220);
                let advances = 0;
                let declines = 0;
                for (const stock of stocks) {
                    const ltp = parseFloat(stock.LTP);
                    const close = parseFloat(stock.close);
                    if (ltp > close)
                        advances++;
                    else if (ltp < close)
                        declines++;
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
        }
        catch (err) {
            console.error("Error in /api/advdec:", err);
            res.status(500).json({
                error: "Internal Server Error",
                message: err instanceof Error ? err.message : "Unknown error",
                details: err,
            });
        }
    });
}
// app.get(
//   "/api/advdec",
//   async (req: Request, res: Response): Promise<void> => {
//     try {
//       const now = new Date();
//       const marketOpen = new Date(
//         now.getFullYear(),
//         now.getMonth(),
//         now.getDate(),
//         9,
//         15,
//         0,
//         0
//       );
//       const marketClose = new Date(
//         now.getFullYear(),
//         now.getMonth(),
//         now.getDate(),
//         15,
//         30,
//         59,
//         999
//       );
//       const pipeline = [
//         {
//           $match: {
//             received_at: { $gte: marketOpen, $lte: marketClose },
//             type: "Full Data",
//           },
//         },
//         {
//           $addFields: {
//             slot: {
//               $dateTrunc: {
//                 date: "$received_at",
//                 unit: "minute",
//                 binSize: 5,
//                 timezone: "Asia/Kolkata",
//               },
//             },
//           },
//         },
//         {
//           $sort: { received_at: -1 },
//         },
//         {
//           $group: {
//             _id: { slot: "$slot", security_id: "$security_id" },
//             latest: { $first: "$$ROOT" },
//           },
//         },
//         {
//           $group: {
//             _id: "$_id.slot",
//             stocks: { $push: "$latest" },
//           },
//         },
//         {
//           $sort: { _id: 1 },
//         },
//       ];
//       const result = await db
//         .collection("nse_fno_stock")
//         .aggregate(pipeline)
//         .toArray();
//       const chartData = result
//         .filter((slotData) => {
//           const slotTime = new Date(slotData._id);
//           return slotTime <= now;
//         })
//         .map((slotData) => {
//           const time = new Date(slotData._id).toLocaleTimeString("en-IN", {
//             hour: "2-digit",
//             minute: "2-digit",
//             hour12: false,
//             timeZone: "Asia/Kolkata",
//           });
//           const stocks = slotData.stocks.slice(0, 220);
//           let advances = 0;
//           let declines = 0;
//           for (const stock of stocks) {
//             const ltp = parseFloat(stock.LTP);
//             const close = parseFloat(stock.close);
//             if (ltp > close) advances++;
//             else if (ltp < close) declines++;
//           }
//           return {
//             time,
//             advances,
//             declines,
//           };
//         });
//       const latest = chartData.at(-1);
//       const current = {
//         advances: latest?.advances ?? 0,
//         declines: latest?.declines ?? 0,
//         total: (latest?.advances ?? 0) + (latest?.declines ?? 0),
//       };
//       res.json({ current, chartData });
//     } catch (err) {
//       console.error("Error in /api/advdec:", err);
//       res.status(500).json({
//         error: "Internal Server Error",
//         message: err instanceof Error ? err.message : "Unknown error",
//         details: err,
//       });
//     }
//   }
// );
