"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = registerDailyJournalRoutes;
// dailyJournal.routes.ts
const express_1 = __importDefault(require("express"));
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
function parseFnOSymbol(sym) {
    let zerodha = sym.match(/^([A-Z]+)-([A-Za-z]{3,})\s?(\d{4})-(\d+)-([A-Z]{2,})$/);
    if (zerodha) {
        return {
            symbol: zerodha[1].replace(/[\W_]/g, ""),
            expiryMonth: zerodha[2].slice(0, 3).toUpperCase(),
            expiryYear: zerodha[3],
            strike: parseFloat(zerodha[4]),
            optionType: zerodha[5].slice(0, 2).toUpperCase(),
            base: zerodha[1].replace(/[\W_]/g, ""),
            raw: sym
        };
    }
    let angel = sym.match(/^(?:OPTIDX|OPTSTK|FUTIDX|FUTSTK|BSXOPT|BSXFUT)? ?([A-Z]+)\s+([A-Za-z]{3,})\s+(\d{1,2})?\s?(\d{4})\s+([\d.]+)\s+([A-Z]{2,})(?:\s?\(.*\))?$/);
    if (angel) {
        return {
            symbol: angel[1].replace(/[\W_]/g, ""),
            expiryMonth: angel[2].slice(0, 3).toUpperCase(),
            expiryDay: angel[3] ? parseInt(angel[3]) : undefined,
            expiryYear: angel[4],
            strike: parseFloat(angel[5]),
            optionType: angel[6].slice(0, 2).toUpperCase(),
            base: angel[1].replace(/[\W_]/g, ""),
            raw: sym
        };
    }
    let nifty = sym.match(/^([A-Z]+)(\d{2})([A-Z])(\d{1,2})(\d+)([A-Z]{2})$/);
    if (nifty) {
        return {
            symbol: nifty[1],
            expiryYear: "20" + nifty[2],
            expiryMonth: monthFromCode(nifty[3]),
            expiryDay: parseInt(nifty[4]),
            strike: parseFloat(nifty[5]),
            optionType: nifty[6],
            base: nifty[1],
            raw: sym
        };
    }
    return { symbol: sym.replace(/[\W_]/g, ""), raw: sym };
}
function monthFromCode(code) {
    const map = { F: "JAN", G: "FEB", H: "MAR", J: "APR", K: "MAY", M: "JUN", N: "JUL", Q: "AUG", U: "SEP", V: "OCT", X: "NOV", Z: "DEC", O: "OCT" };
    return map[code.toUpperCase()] || code.toUpperCase();
}
function expiryFuzzyMatch(p1, p2) {
    if (!p1 || !p2)
        return false;
    return (p1.symbol === p2.symbol &&
        (p1.strike === p2.strike || (p1.strike && p2.strike && Math.abs(Number(p1.strike) - Number(p2.strike)) < 0.01)) &&
        p1.optionType === p2.optionType &&
        p1.expiryMonth === p2.expiryMonth &&
        String(p1.expiryYear) === String(p2.expiryYear));
}
function tradeObjMatch(planned, executed) {
    const p1 = parseFnOSymbol(planned.symbol);
    const p2 = parseFnOSymbol(executed.symbol);
    return (expiryFuzzyMatch(p1, p2) &&
        planned.tradeType === executed.tradeType &&
        (planned.quantity === executed.quantity || !planned.quantity || !executed.quantity) &&
        Math.abs(Number(planned.entry) - Number(executed.entry)) < 1.0);
}
function asyncHandler(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
function groupBy(arr, key) {
    const out = {};
    arr.forEach(t => {
        const k = key(t);
        if (!out[k])
            out[k] = [];
        out[k].push(t);
    });
    return out;
}
function registerDailyJournalRoutes(db) {
    const router = express_1.default.Router();
    // GET plan for a date
    router.get("/plan", asyncHandler(async (req, res) => {
        const { date } = req.query;
        if (!date || typeof date !== "string") {
            return res.status(400).json({ error: "Date query param required (YYYY-MM-DD)" });
        }
        const normDate = normalizeTradeDate(date);
        const plan = (await db.collection("daily_journal").findOne({ date: normDate }) || {});
        res.json(plan || {});
    }));
    // POST plan for a date
    router.post("/plan", asyncHandler(async (req, res) => {
        const { date, planNotes, plannedTrades, confidenceLevel, stressLevel, distractions, sleepHours, mood, focus, energy } = req.body;
        if (!date || !Array.isArray(plannedTrades)) {
            return res.status(400).json({ error: "Missing date or plannedTrades" });
        }
        const now = new Date();
        const normDate = normalizeTradeDate(date);
        plannedTrades.forEach((t) => {
            if (typeof t.lotSize === "undefined")
                t.lotSize = "";
        });
        const result = await db.collection("daily_journal").updateOne({ date: normDate }, {
            $set: {
                planNotes, plannedTrades,
                confidenceLevel, stressLevel, distractions, sleepHours, mood, focus, energy,
                updatedAt: now,
            },
            $setOnInsert: { createdAt: now }
        }, { upsert: true });
        res.json({ success: true, result });
    }));
    // GET executed trades for a date
    router.get("/executed", asyncHandler(async (req, res) => {
        const { date } = req.query;
        if (!date || typeof date !== "string") {
            return res.status(400).json({ error: "Date query param required" });
        }
        const normDate = normalizeTradeDate(date);
        const trades = await db.collection("executed_trades").find({ date: normDate }).toArray();
        res.json({ trades });
    }));
    // GET /comparison endpoint with pointer-based summary
    router.get("/comparison", asyncHandler(async (req, res) => {
        const { date } = req.query;
        if (!date || typeof date !== "string") {
            return res.status(400).json({ error: "Date query param required" });
        }
        const normDate = normalizeTradeDate(date);
        const plan = (await db.collection("daily_journal").findOne({ date: normDate }) || {});
        const plannedTrades = plan.plannedTrades || [];
        const executedDocs = await db.collection("executed_trades").find({ date: normDate }).toArray();
        const executed = executedDocs.map(doc => ({
            date: doc.date,
            symbol: doc.symbol,
            quantity: doc.quantity,
            entry: doc.entry,
            exit: doc.exit,
            tradeType: doc.tradeType,
            PnL: doc.PnL,
            exchangeId: doc.exchangeId,
            instrumentType: doc.instrumentType,
            instrumentName: doc.instrumentName,
            segment: doc.segment,
            lotSize: doc.lotSize,
            expiry: doc.expiry,
            optionType: doc.optionType,
            strikePrice: doc.strikePrice,
            underlyingSymbol: doc.underlyingSymbol,
        }));
        if (executed.length === 0) {
            return res.json({
                status: "no-executions",
                planned: plannedTrades,
                insights: [],
                whatWentWrong: [],
                matched: 0,
                matchedTrades: [],
                missedTrades: [],
                extraTrades: [],
                totalPlanned: plannedTrades.length,
                executionPercent: 0,
                badge: "NO DATA",
                confidenceLevel: plan.confidenceLevel ?? 5,
                stressLevel: plan.stressLevel ?? 5,
                distractions: plan.distractions ?? "",
                sleepHours: plan.sleepHours ?? 7,
                mood: plan.mood ?? "",
                focus: plan.focus ?? 5,
                energy: plan.energy ?? 5,
            });
        }
        const matchedTrades = [];
        const missedTrades = [];
        const matchedExecutedIndexes = new Set();
        plannedTrades.forEach(pt => {
            const idx = executed.findIndex((et, i) => tradeObjMatch(pt, et) && !matchedExecutedIndexes.has(i));
            if (idx !== -1) {
                matchedTrades.push(executed[idx]);
                matchedExecutedIndexes.add(idx);
            }
            else {
                missedTrades.push(pt);
            }
        });
        const extraTrades = executed.filter((_, i) => !matchedExecutedIndexes.has(i));
        const groupedExtras = groupBy(extraTrades, t => `${t.symbol}__${t.tradeType}__${t.expiry || ""}__${t.strikePrice || ""}__${t.optionType || ""}`);
        let insights = [];
        let whatWentWrong = [];
        const totalPlanned = plannedTrades.length;
        const executionPercent = totalPlanned ? Math.round((matchedTrades.length / totalPlanned) * 100) : 0;
        if (matchedTrades.length) {
            insights.push(`Executed ${matchedTrades.length} of ${totalPlanned} planned trades (${executionPercent}%)`);
        }
        if (matchedTrades.length && matchedTrades.some(t => t.PnL && Math.abs(t.PnL) > 0.01)) {
            const bestMatch = matchedTrades.reduce((a, b) => ((a.PnL || 0) > (b.PnL || 0) ? a : b));
            insights.push(`Best trade: ${bestMatch.symbol} (${bestMatch.tradeType}) @ ₹${bestMatch.entry} (P&L: ₹${bestMatch.PnL})`);
            const avgPnL = matchedTrades.reduce((sum, t) => sum + (t.PnL || 0), 0) / matchedTrades.length;
            if (Math.abs(avgPnL) > 0.01)
                insights.push(`Average P&L (matched): ₹${avgPnL.toFixed(2)}`);
        }
        if (extraTrades.length) {
            insights.push(`You took ${extraTrades.length} unplanned trades (overtrading).`);
        }
        if (missedTrades.length) {
            whatWentWrong.push(`You missed ${missedTrades.length} planned trade${missedTrades.length > 1 ? "s" : ""}.`);
        }
        if (extraTrades.length) {
            let typeCount = {};
            extraTrades.forEach(t => {
                const key = `${t.symbol} ${t.tradeType}`;
                typeCount[key] = (typeCount[key] || 0) + 1;
            });
            const most = Object.entries(typeCount).sort((a, b) => b[1] - a[1])[0];
            if (most && most[1] > 1) {
                whatWentWrong.push(`Most common unplanned trade: ${most[0]} (${most[1]} times)`);
            }
            whatWentWrong.push(`Try to stick to your plan and avoid impulsive/unplanned trades.`);
        }
        if (!missedTrades.length && !extraTrades.length) {
            whatWentWrong.push("Great job! You stuck to your plan. Keep it up.");
        }
        if (plan.confidenceLevel !== undefined) {
            if (plan.confidenceLevel < 4)
                insights.push("Low confidence—review setups before market open.");
            if (plan.confidenceLevel > 7)
                insights.push("High confidence—be wary of overtrading.");
        }
        if (plan.stressLevel !== undefined && plan.stressLevel > 6) {
            whatWentWrong.push("High stress—reduce position size or number of trades.");
        }
        if (plan.sleepHours !== undefined && plan.sleepHours < 6) {
            whatWentWrong.push("Low sleep may have impacted your trading decisions.");
        }
        function getBadge(executionPercent) {
            if (executionPercent >= 90)
                return "MASTER";
            if (executionPercent >= 75)
                return "EXPERT";
            if (executionPercent >= 60)
                return "SKILLED";
            return "LEARNING";
        }
        res.json({
            status: "ok",
            matched: matchedTrades.length,
            totalPlanned,
            executionPercent,
            badge: getBadge(executionPercent),
            matchedTrades,
            missedTrades,
            extraTrades: Object.values(groupedExtras).flat(),
            groupedExtras,
            insights,
            whatWentWrong,
            confidenceLevel: plan.confidenceLevel ?? 5,
            stressLevel: plan.stressLevel ?? 5,
            distractions: plan.distractions ?? "",
            sleepHours: plan.sleepHours ?? 7,
            mood: plan.mood ?? "",
            focus: plan.focus ?? 5,
            energy: plan.energy ?? 5,
        });
    }));
    return router;
}
