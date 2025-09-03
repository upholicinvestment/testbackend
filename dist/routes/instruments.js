"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// instruments.ts
const express_1 = require("express");
const csv_parser_1 = __importDefault(require("csv-parser"));
const cors_1 = __importDefault(require("cors"));
const node_fetch_1 = __importDefault(require("node-fetch"));
const stream_1 = require("stream");
const CSV_URL = "https://images.dhan.co/api-data/api-scrip-master.csv";
let instruments = [];
let loaded = false;
// --- Helpers for the classic SEM_* CSV ---
// Normalize: "26-03-2026 15:30" -> "2026-03-26"
function normalizeDhanDate(d) {
    if (!d)
        return "";
    const justDate = d.split(" ")[0]; // remove time if present
    // DD-MM-YYYY
    if (/^\d{2}-\d{2}-\d{4}$/.test(justDate)) {
        const [dd, mm, yyyy] = justDate.split("-");
        return `${yyyy}-${mm}-${dd}`;
    }
    // already ISO
    if (/^\d{4}-\d{2}-\d{2}$/.test(justDate))
        return justDate;
    // fallback
    const parsed = new Date(justDate);
    return isNaN(parsed.getTime()) ? justDate : parsed.toISOString().slice(0, 10);
}
function parseISODate(d) {
    if (!d)
        return null;
    const iso = normalizeDhanDate(d);
    const dt = new Date(iso);
    return isNaN(dt.getTime()) ? null : dt;
}
// Keep signature used elsewhere
function cleanExpiryDate(dateString) {
    return normalizeDhanDate(dateString);
}
// Extract index/underlying (BANKNIFTY, NIFTY, SENSEX, BANKEX, etc.)
function deriveUnderlyingSymbol(instr) {
    const t = (instr.SEM_TRADING_SYMBOL || "").toUpperCase();
    if (t.includes("-"))
        return t.split("-")[0];
    const c = (instr.SEM_CUSTOM_SYMBOL || "").toUpperCase();
    if (c)
        return c.split(" ")[0]; // first token from display name
    const n = (instr.SEM_SYMBOL_NAME || "").toUpperCase();
    if (n.includes(" "))
        return n.split(" ")[0];
    return n || t || "";
}
function smartFormatInput(input, currentExpiries = []) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthRegex = new RegExp(`(${months.join("|")})`, "i");
    let parts = input
        .trim()
        .split(/(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])|(?=[A-Za-z])(?=Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)|[\s-]+/i)
        .map(p => p.trim())
        .filter(Boolean);
    if (parts.length === 1) {
        const match = parts[0].match(monthRegex);
        if (match && match.index && match.index > 0) {
            parts = [parts[0].substring(0, match.index).toUpperCase(), match[0]];
        }
    }
    else {
        parts = parts.map((p, i) => i === 0 || !months.some(m => m.toLowerCase() === p.toLowerCase()) ? p.toUpperCase() : p);
    }
    let [sym] = parts;
    let symbol = sym || "";
    let strikePrice = parts.find(x => /^\d+$/.test(x)) || "";
    let otype = (parts.find(x => x === "CE" || x === "PE") || "").toUpperCase();
    let rest = parts.filter(x => x !== symbol && x !== strikePrice && x !== otype);
    let expiry = "";
    if (rest.length && currentExpiries.length) {
        const monthPart = rest.find(x => months.some(m => m.toLowerCase() === x.toLowerCase()));
        if (monthPart) {
            expiry = currentExpiries.find(date => date.toLowerCase().includes(monthPart.toLowerCase())) || "";
        }
    }
    return { symbol, strikePrice, optionType: otype, expiry };
}
async function loadCSVFromURL() {
    if (loaded && instruments.length)
        return;
    instruments = [];
    const response = await (0, node_fetch_1.default)(CSV_URL);
    const csvText = await response.text();
    await new Promise((resolve, reject) => {
        stream_1.Readable.from(csvText)
            .pipe((0, csv_parser_1.default)())
            .on("data", (row) => instruments.push(row))
            .on("end", resolve)
            .on("error", reject);
    });
    loaded = true;
}
loadCSVFromURL();
const router = (0, express_1.Router)();
router.use((0, cors_1.default)());
/**
 * Get unique underlyings (index names) for Exchange + Instrument (e.g., NSE + OPTIDX)
 * GET /underlyings?exchange=NSE&instrument=OPTIDX
 */
router.get("/underlyings", (req, res) => {
    const exchange = (req.query.exchange || "").trim().toUpperCase();
    const instrument = (req.query.instrument || req.query.instrumentType || "").trim().toUpperCase();
    let matches = instruments.filter(instr => {
        return ((!exchange || (instr.SEM_EXM_EXCH_ID || "").toUpperCase() === exchange) &&
            (!instrument || (instr.SEM_INSTRUMENT_NAME || "").toUpperCase() === instrument));
    });
    const list = Array.from(new Set(matches.map(x => deriveUnderlyingSymbol(x)).filter(Boolean))).sort();
    res.json({ underlyings: list });
});
/**
 * Expiry dates for a given (optional) symbol/underlying/exchange/instrument/optionType
 * Adds robust date parsing for weekly/monthly filtering.
 */
router.get("/expiries", (req, res) => {
    const symbol = (req.query.symbol || "").trim().toUpperCase();
    const exchange = (req.query.exchange || "").trim().toUpperCase();
    const instrumentType = (req.query.instrumentType || "").trim().toUpperCase();
    const optionType = (req.query.optionType || "").trim().toUpperCase();
    const underlying = (req.query.underlying || "").trim().toUpperCase();
    const expiryType = (req.query.expiryType || "").toLowerCase();
    let matches = instruments.filter(instr => {
        const sym = (instr.SEM_TRADING_SYMBOL || "").toUpperCase();
        const exch = (instr.SEM_EXM_EXCH_ID || "").toUpperCase();
        const instrName = (instr.SEM_INSTRUMENT_NAME || "").toUpperCase();
        const otype = (instr.SEM_OPTION_TYPE || "").toUpperCase();
        const und = deriveUnderlyingSymbol(instr);
        return ((!symbol || sym.startsWith(symbol)) &&
            (!exchange || exch === exchange) &&
            (!instrumentType || instrName === instrumentType) &&
            (!optionType || otype === optionType) &&
            (!underlying || und === underlying));
    });
    let expiryDates = [...new Set(matches.map(x => cleanExpiryDate(x.SEM_EXPIRY_DATE)).filter(Boolean))].sort();
    let filterFunc = (date) => true;
    if (expiryType === "weekly") {
        filterFunc = (date) => {
            const d = parseISODate(date);
            if (!d)
                return false;
            return d.getDay() === 4 && d.getDate() < 25; // Thu and not last week
        };
    }
    else if (expiryType === "monthly") {
        filterFunc = (date) => {
            const d = parseISODate(date);
            if (!d)
                return false;
            const temp = new Date(d);
            temp.setDate(d.getDate() + 7);
            return d.getDay() === 4 && temp.getMonth() !== d.getMonth();
        };
    }
    expiryDates = expiryDates.filter(filterFunc);
    res.json({ expiryDates });
});
/**
 * Symbol smart suggestions API for SEM_* CSV.
 * Supports query, exchange, instrumentType, optionType, expiry, underlying.
 */
const searchHandler = (req, res) => {
    let query = (req.query.query || "").trim().toUpperCase();
    const exchange = (req.query.exchange || "").trim().toUpperCase();
    const instrumentType = (req.query.instrumentType || "").trim().toUpperCase();
    const optionType = (req.query.optionType || "").trim().toUpperCase();
    const strikePrice = (req.query.strikePrice || "").trim();
    const expiry = (req.query.expiry || "").trim();
    const underlying = (req.query.underlying || "").trim().toUpperCase();
    if (!query && !strikePrice && !optionType && !underlying) {
        res.json([]);
        return;
    }
    let formatted = smartFormatInput(query);
    let symbolMatch = formatted.symbol || query;
    let strikeMatch = strikePrice || formatted.strikePrice;
    let otypeMatch = optionType || formatted.optionType;
    let matches = instruments.filter(instr => {
        const trading = (instr.SEM_TRADING_SYMBOL || "").toUpperCase();
        const symbolName = (instr.SEM_SYMBOL_NAME || "").toUpperCase();
        const instrumentName = (instr.SEM_INSTRUMENT_NAME || "").toUpperCase();
        const und = deriveUnderlyingSymbol(instr);
        let match = trading.includes(symbolMatch) ||
            symbolName.includes(symbolMatch) ||
            instrumentName.includes(symbolMatch);
        if (strikeMatch)
            match = match && (instr.SEM_STRIKE_PRICE && instr.SEM_STRIKE_PRICE.toString().includes(strikeMatch));
        if (otypeMatch)
            match = match && (instr.SEM_OPTION_TYPE && instr.SEM_OPTION_TYPE.toUpperCase() === otypeMatch);
        if (exchange)
            match = match && (instr.SEM_EXM_EXCH_ID && instr.SEM_EXM_EXCH_ID.toUpperCase() === exchange);
        if (instrumentType)
            match = match && (instr.SEM_INSTRUMENT_NAME && instr.SEM_INSTRUMENT_NAME.toUpperCase() === instrumentType);
        if (expiry)
            match = match && (cleanExpiryDate(instr.SEM_EXPIRY_DATE) === expiry);
        if (underlying)
            match = match && und === underlying;
        return match;
    });
    matches = matches.sort((a, b) => {
        const aSym = (a.SEM_TRADING_SYMBOL || a.SEM_SYMBOL_NAME || "").toUpperCase();
        const bSym = (b.SEM_TRADING_SYMBOL || b.SEM_SYMBOL_NAME || "").toUpperCase();
        const aStarts = aSym.startsWith(symbolMatch) ? 0 : 1;
        const bStarts = bSym.startsWith(symbolMatch) ? 0 : 1;
        if (aStarts !== bStarts)
            return aStarts - bStarts;
        return aSym.localeCompare(bSym);
    });
    res.json(matches.slice(0, 300).map(instr => ({
        symbol: instr.SEM_TRADING_SYMBOL || instr.SEM_SYMBOL_NAME || "",
        exchangeId: instr.SEM_EXM_EXCH_ID,
        instrumentType: instr.SEM_INSTRUMENT_NAME || "",
        optionType: instr.SEM_OPTION_TYPE || "",
        strikePrice: instr.SEM_STRIKE_PRICE || "",
        instrumentName: instr.SEM_SYMBOL_NAME || instr.SEM_CUSTOM_SYMBOL || instr.SEM_INSTRUMENT_NAME || "",
        segment: instr.SEM_SEGMENT || "",
        lotSize: Number(instr.SEM_LOT_UNITS) || "",
        expiry: cleanExpiryDate(instr.SEM_EXPIRY_DATE) || "",
        underlyingSymbol: deriveUnderlyingSymbol(instr) || ""
    })));
};
router.get("/search", searchHandler);
exports.default = router;
