"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = registerTradeJournalRoutes;
const express_1 = require("express");
const tradeJournal_1 = require("../services/tradeJournal");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
// --- Date Normalizer (same as backend) ---
function normalizeTradeDate(dateStr) {
    if (!dateStr)
        return "";
    if (/^\d{4}-\d{2}-\d{2}/.test(dateStr))
        return dateStr.slice(0, 10);
    let mdy = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (mdy) {
        let [_, m, d, y] = mdy;
        return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
    let dmy = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (dmy) {
        let [_, d, m, y] = dmy;
        return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
    return dateStr.slice(0, 10);
}
function registerTradeJournalRoutes(db) {
    const router = (0, express_1.Router)();
    let lastStats = null;
    router.post("/upload-orderbook", tradeJournal_1.tradeJournalUpload.single("orderbook"), async (req, res) => {
        if (!req.file) {
            res.status(400).json({ message: "No file uploaded" });
            return;
        }
        const filePath = path_1.default.resolve(req.file.path);
        try {
            const trades = await (0, tradeJournal_1.parseUniversalTradebook)(filePath);
            if (!trades.length) {
                fs_1.default.unlinkSync(filePath);
                res.status(400).json({ message: "No valid trades found in file" });
                return;
            }
            lastStats = (0, tradeJournal_1.processTrades)(trades);
            let savedCount = 0;
            for (const t of trades) {
                if (!t.Date || !t.Symbol || !t.Direction || !t.Price || !t.Quantity)
                    continue;
                const normDate = normalizeTradeDate(t.Date);
                const exists = await db.collection("executed_trades").findOne({
                    date: normDate,
                    symbol: t.Symbol,
                    entry: t.Price,
                    tradeType: t.Direction.toUpperCase(),
                    quantity: t.Quantity,
                });
                if (!exists) {
                    await db.collection("executed_trades").insertOne({
                        date: normDate,
                        symbol: t.Symbol,
                        entry: t.Price,
                        tradeType: t.Direction.toUpperCase(),
                        quantity: t.Quantity,
                    });
                    savedCount++;
                }
            }
            fs_1.default.unlinkSync(filePath);
            res.json({
                message: `Orderbook uploaded & stats calculated. ${savedCount} new executed trades saved for plan comparison.`,
            });
        }
        catch (err) {
            if (fs_1.default.existsSync(filePath))
                fs_1.default.unlinkSync(filePath);
            res.status(500).json({ message: "Error processing file", error: String(err) });
        }
    });
    router.get("/stats", (_req, res) => {
        if (!lastStats) {
            res.status(200).json({
                netPnl: 0,
                tradeWinPercent: 0,
                profitFactor: 0,
                dayWinPercent: 0,
                avgWinLoss: { avgWin: 0, avgLoss: 0 },
                upholicScore: 0,
                upholicPointers: {
                    patience: 0,
                    demonFinder: [],
                    planOfAction: []
                },
                trades: [],
                tradeDates: [],
                empty: true,
                totalBadTradeCost: 0,
                goodPracticeCounts: {}
            });
            return;
        }
        res.status(200).json(lastStats);
    });
    return router;
}
