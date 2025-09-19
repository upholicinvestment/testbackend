
import multer from "multer";
import csvParser from "csv-parser";
import fs from "fs";

/* =========================
   Types
========================= */
export interface Trade {
  Date: string;
  Time?: string;
  Symbol: string;
  Direction: "Buy" | "Sell";
  Quantity: number;
  Price: number;
  PnL: number;
  Charges?: number;
  NetPnL: number;
  stopDistance?: number;
  executed?: boolean;
  Demon?: string;
  DemonArr?: string[];
  GoodPractice?: string;
  GoodPracticeArr?: string[];
  isBadTrade?: boolean;
  isGoodTrade?: boolean;

  // internal helpers
  _fullQty?: number;
  buyPriceRaw?: number;
  sellPriceRaw?: number;
}

export interface RoundTrip {
  symbol: string;
  entry: Trade;
  exit: Trade;
  legs: Trade[];
  PnL: number;
  NetPnL: number;
  holdingMinutes: number;
  Demon?: string;
  DemonArr?: string[];
  GoodPractice?: string;
  GoodPracticeArr?: string[];
  isBadTrade?: boolean;
  isGoodTrade?: boolean;
}

export interface ScripSummaryRow {
  symbol: string;
  quantity: number;
  avgBuy: number;
  avgSell: number;
  charges: number;
  netRealized: number;
}

export interface OpenPosition {
  symbol: string;
  side: "Buy" | "Sell";
  quantity: number;
  /** weighted avg entry price of the remaining (unpaired) legs on that side */
  avgPrice?: number;
}

export interface Stats {
  netPnl: number;
  pnlBasis: "PAIRED_RAW";
  totalsCheck?: { netPnlFromScrips: number; chargesFromScrips: number };

  tradeWinPercent: number;
  profitFactor: number;
  dayWinPercent: number;
  avgWinLoss: { avgWin: number; avgLoss: number };
  upholicScore: number;
  upholicPointers: {
    patience: number;
    demonFinder: string[];   // top-3 “reasons” derived from trades
    planOfAction: string[];  // (kept for compatibility; UI won’t use “actions”)
  };

  trades: RoundTrip[];
  tradeDates: string[];
  empty: boolean;
  totalBadTradeCost: number;
  totalGoodTradeProfit: number;
  badTradeCounts: Record<string, { count: number; totalCost: number }>;
  goodTradeCounts: Record<string, { count: number; totalProfit: number }>;
  standardDemons: string[];
  standardGood: string[];
  enteredTooSoonCount: number;

  scripSummary: ScripSummaryRow[];

  pairedTotals: {
    buyQty: number;
    sellQty: number;
    avgBuy: number;
    avgSell: number;
    charges: number;
    netPnl: number;
  };

  openPositions?: OpenPosition[];
}

export const standardDemons = [
  "POOR RISK/REWARD TRADE",
  "HELD LOSS TOO LONG",
  "PREMATURE EXIT",
  "REVENGE TRADING",
  "OVERTRADING",
  "WRONG POSITION SIZE",
  "CHASED ENTRY",
  "MISSED STOP LOSS",
];

export const standardGood = [
  "GOOD RISK/REWARD",
  "PROPER ENTRY",
  "PROPER EXIT",
  "FOLLOWED PLAN",
  "STOP LOSS RESPECTED",
  "HELD FOR TARGET",
  "DISCIPLINED",
];

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export const tradeJournalUpload = multer({ dest: "uploads/" });

/* =========================
   Date normalize
========================= */
function normalizeTradeDate(dateStr: string | undefined | null): string {
  if (!dateStr) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return dateStr.slice(0, 10);

  const mdy = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); // MM/DD/YYYY
  if (mdy) {
    const [, m, d, y] = mdy;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const dmy = dateStr.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/); // DD/MM/YYYY or DD-MM-YYYY
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const dMonY = dateStr.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/); // 09-Sep-2025
  if (dMonY) {
    const [, d, mon, y] = dMonY;
    const idx = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(mon.toLowerCase());
    if (idx >= 0) return `${y}-${String(idx+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  }

  return dateStr.slice(0, 10);
}

/* =========================
   CSV Parser (universal)
========================= */
function findTradeTableHeaderIndex(lines: string[]): number {
  const possibleHeaders = [
    "Scrip/Contract,Buy/Sell,Buy Price",
    "symbol,isin,trade_date",
    "Scrip Name,Trade Type,Trade Date",
  ];
  return lines.findIndex((line) =>
    possibleHeaders.some((header) =>
      line.replace(/\s/g, "").toLowerCase().startsWith(header.replace(/\s/g, "").toLowerCase())
    )
  );
}

export async function parseUniversalTradebook(filePath: string): Promise<Trade[]> {
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split(/\r?\n/);
  const headerIdx = findTradeTableHeaderIndex(lines);
  if (headerIdx === -1) throw new Error("No recognizable trade table found!");
  const tradeTable = lines.slice(headerIdx).join("\n");
  const tempCsv = filePath + ".parsed.csv";
  fs.writeFileSync(tempCsv, tradeTable);

  return new Promise((resolve, reject) => {
    const trades: Trade[] = [];
    fs.createReadStream(tempCsv)
      .pipe(csvParser())
      .on("data", (row: any) => {
        // Zerodha-like
        if (row["symbol"]) {
          let date = row["trade_date"] || "";
          let time = "";
          if (row["order_execution_time"]) {
            if (row["order_execution_time"].includes("T")) {
              const [d, t] = row["order_execution_time"].split("T");
              date = d; time = t;
            } else if (row["order_execution_time"].includes(" ")) {
              const [d, t] = row["order_execution_time"].split(" ");
              date = d; time = t;
            }
          } else if (row["trade_time"]) time = row["trade_time"];

          const qty = parseInt(row["quantity"]) || 0;
          trades.push({
            Date: normalizeTradeDate(date),
            Time: time,
            Symbol: row["symbol"],
            Direction: row["trade_type"]?.toLowerCase() === "buy" ? "Buy" : "Sell",
            Price: parseFloat(row["price"]) || 0,
            Quantity: qty,
            _fullQty: qty,
            PnL: 0,
            Charges: 0,
            NetPnL: 0,
          });
        }
        // Angel/Upstox/ICICI-like
        else if (row["Scrip/Contract"]) {
          const side = row["Buy/Sell"]?.toLowerCase();
          const buyRaw  = parseFloat(row["Buy Price"])  || 0;
          const sellRaw = parseFloat(row["Sell Price"]) || 0;
          const price = side === "buy" ? buyRaw : sellRaw;

          let date = row["Date"] || row["Trade Date"] || "";
          let time =
            row["Time"] ||
            row["Trade Time"] ||
            row["Order Time"] ||
            row["TradeDateTime"] ||
            "";
          if (typeof time === "string" && time.includes(" ")) {
            const [d, t] = time.split(" "); date = d; time = t;
          }
          if (typeof time === "string" && !/\d{2}:\d{2}/.test(time)) time = "";

          const exchangeTurnover =
            (parseFloat(row["Exchange Turnover Charges"]) || 0) ||
            (parseFloat(row["Exchange Turnover"]) || 0);

          const chargeFields = [
            "Brokerage","GST","STT","Sebi Tax","Stamp Duty","Other Charges","IPFT Charges",
          ];
          const baseCharges = chargeFields.reduce((s, k) => s + (parseFloat(row[k]) || 0), 0);
          const charges = baseCharges + (exchangeTurnover || 0);

          const qty = parseInt(row["Quantity"]) || 0;

          trades.push({
            Date: normalizeTradeDate(date),
            Time: time,
            Symbol: row["Scrip/Contract"],
            Direction: side === "buy" ? "Buy" : "Sell",
            Price: price,
            Quantity: qty,
            _fullQty: qty,
            PnL: 0,
            Charges: charges,
            NetPnL: 0,
            buyPriceRaw: buyRaw || undefined,
            sellPriceRaw: sellRaw || undefined,
          });
        }
      })
      .on("end", () => { try { fs.unlinkSync(tempCsv); } catch {} resolve(trades); })
      .on("error", (err) => { try { fs.unlinkSync(tempCsv); } catch {} reject(err); });
  });
}

/* =========================
   Pairing (FIFO) & open legs
========================= */
function pairRoundTripsAndOpen(trades: Trade[]): {
  roundTrips: RoundTrip[];
  openLegsBySymbol: Record<string, Trade[]>;
} {
  const sorted = trades
    .filter(t => t.Symbol && t.Direction && t.Quantity && t.Price !== undefined)
    .sort((a, b) =>
      new Date(`${a.Date}T${a.Time || "00:00"}`).getTime() -
      new Date(`${b.Date}T${b.Time || "00:00"}`).getTime()
    );

  const roundTrips: RoundTrip[] = [];
  const openPositions: Record<string, Trade[]> = {};

  const prorate = (charges: number | undefined, usedQty: number, fullQty?: number) => {
    const c = charges || 0;
    const f = fullQty && fullQty > 0 ? fullQty : usedQty;
    if (f <= 0) return 0;
    return c * (usedQty / f);
  };

  for (const trade of sorted) {
    const symbol = trade.Symbol!;
    if (!openPositions[symbol]) openPositions[symbol] = [];
    const openLegs = openPositions[symbol];

    if (openLegs.length > 0 && trade.Direction !== openLegs[0].Direction) {
      let qtyToClose = trade.Quantity!;
      while (openLegs.length && qtyToClose > 0) {
        const entryLeg = openLegs[0];
        const closeQty = Math.min(qtyToClose, entryLeg.Quantity!);

        const entryLegUsed: Trade = {
          ...entryLeg,
          Quantity: closeQty,
          Charges: prorate(entryLeg.Charges, closeQty, entryLeg._fullQty),
          _fullQty: entryLeg._fullQty
        };

        if (entryLeg.Quantity! > closeQty) entryLeg.Quantity! -= closeQty;
        else openLegs.shift();

        const exitLeg: Trade = {
          ...trade,
          Quantity: closeQty,
          Charges: prorate(trade.Charges, closeQty, trade._fullQty),
          _fullQty: trade._fullQty
        };

        const gross =
          entryLegUsed.Direction === "Buy"
            ? (exitLeg.Price! - entryLegUsed.Price!) * closeQty
            : (entryLegUsed.Price! - exitLeg.Price!) * closeQty;

        const sliceCharges = (entryLegUsed.Charges || 0) + (exitLeg.Charges || 0);
        const pnl = gross - sliceCharges;

        const entryDT = new Date(`${entryLegUsed.Date}T${entryLegUsed.Time || "00:00"}`);
        const exitDT = new Date(`${exitLeg.Date}T${exitLeg.Time || "00:00"}`);
        const holdingMinutes = Math.round((exitDT.getTime() - entryDT.getTime()) / 60000);

        roundTrips.push({
          symbol,
          entry: entryLegUsed,
          exit: exitLeg,
          legs: [entryLegUsed, exitLeg],
          PnL: pnl,
          NetPnL: pnl,
          holdingMinutes,
        });

        qtyToClose -= closeQty;
      }
      if (qtyToClose > 0) {
        const remainder: Trade = {
          ...trade,
          Quantity: qtyToClose,
          _fullQty: trade._fullQty,
          Charges: prorate(trade.Charges, qtyToClose, trade._fullQty)
        };
        openPositions[symbol].push(remainder);
      }
    } else {
      openLegs.push({ ...trade, _fullQty: trade._fullQty ?? trade.Quantity });
    }
  }

  return { roundTrips, openLegsBySymbol: openPositions };
}

/* =========================
   RAW headline & tables
========================= */
function computePairedHeadlineFromRawSymbolFilter(trades: Trade[]) {
  const withBuy = new Set<string>();
  const withSell = new Set<string>();
  for (const t of trades) {
    if (!t.Symbol) continue;
    if (t.Direction === "Buy") withBuy.add(t.Symbol);
    else if (t.Direction === "Sell") withSell.add(t.Symbol);
  }
  const pairedSymbols = new Set<string>([...withBuy].filter(s => withSell.has(s)));

  let buyQty = 0, sellQty = 0, buyNotional = 0, sellNotional = 0, totalCharges = 0;

  for (const t of trades) {
    if (!t.Symbol || !pairedSymbols.has(t.Symbol)) continue;
    const q = t.Quantity || 0;
    const price =
      t.Direction === "Buy"
        ? (t.buyPriceRaw ?? t.Price ?? 0)
        : (t.sellPriceRaw ?? t.Price ?? 0);

    if (t.Direction === "Buy") { buyQty += q; buyNotional += price * q; }
    else                        { sellQty += q; sellNotional += price * q; }

    totalCharges += t.Charges || 0; // FULL row charges
  }

  const avgBuy  = buyQty  ? buyNotional  / buyQty  : 0;
  const avgSell = sellQty ? sellNotional / sellQty : 0;
  const netPnl  = (sellNotional - buyNotional) - totalCharges;

  return {
    buyQty,
    sellQty,
    avgBuy: r2(avgBuy),
    avgSell: r2(avgSell),
    charges: r2(totalCharges),
    netPnl: r2(netPnl),
    pairedSymbols
  } as const;
}

function buildRawScripSummary(trades: Trade[], pairedSymbols: Set<string>): ScripSummaryRow[] {
  type Agg = { buyQty: number; sellQty: number; buyNotional: number; sellNotional: number; charges: number; };
  const per = new Map<string, Agg>();

  for (const t of trades) {
    if (!t.Symbol || !pairedSymbols.has(t.Symbol)) continue;

    const a = per.get(t.Symbol) ?? { buyQty: 0, sellQty: 0, buyNotional: 0, sellNotional: 0, charges: 0 };
    const q = t.Quantity || 0;
    const price =
      t.Direction === "Buy"
        ? (t.buyPriceRaw ?? t.Price ?? 0)
        : (t.sellPriceRaw ?? t.Price ?? 0);

    if (t.Direction === "Buy") { a.buyQty += q; a.buyNotional += price * q; }
    else                        { a.sellQty += q; a.sellNotional += price * q; }

    a.charges += t.Charges || 0;
    per.set(t.Symbol, a);
  }

  const rows: ScripSummaryRow[] = [];
  for (const [symbol, a] of per) {
    const qty = Math.min(a.buyQty, a.sellQty);
    const avgBuy  = a.buyQty  ? a.buyNotional  / a.buyQty  : 0;
    const avgSell = a.sellQty ? a.sellNotional / a.sellQty : 0;
    const net = (a.sellNotional - a.buyNotional) - a.charges;

    rows.push({
      symbol,
      quantity: qty,
      avgBuy: r2(avgBuy),
      avgSell: r2(avgSell),
      charges: r2(a.charges),
      netRealized: r2(net),
    });
  }

  rows.sort((x, y) => y.netRealized - x.netRealized);
  return rows;
}

/** Build open positions with precise avg price from FIFO leftovers */
function buildOpenPositionsFromOpenLegs(openLegsBySymbol: Record<string, Trade[]>): OpenPosition[] {
  const out: OpenPosition[] = [];
  for (const [symbol, legs] of Object.entries(openLegsBySymbol)) {
    if (!legs?.length) continue;

    // Net side and total qty
    let qty = 0;
    for (const l of legs) qty += l.Direction === "Buy" ? l.Quantity || 0 : -(l.Quantity || 0);
    if (qty === 0) continue;

    const side: "Buy" | "Sell" = qty > 0 ? "Buy" : "Sell";
    const remainingQty = Math.abs(qty);

    // Only consider legs that match the net side; compute weighted avg using RAW price when available
    let wNotional = 0, wQty = 0;
    for (const l of legs) {
      if (l.Direction !== side) continue;
      const q = l.Quantity || 0;
      if (!q) continue;
      const rawPrice = side === "Buy" ? (l.buyPriceRaw ?? l.Price ?? 0) : (l.sellPriceRaw ?? l.Price ?? 0);
      wNotional += rawPrice * q;
      wQty += q;
    }
    const avgPrice = wQty ? wNotional / wQty : 0;

    out.push({ symbol, side, quantity: remainingQty, avgPrice: r2(avgPrice) });
  }
  // sort for stable UI
  out.sort((a,b) => a.symbol.localeCompare(b.symbol));
  return out;
}

/* =========================
   Main processor
========================= */
export function processTrades(trades: Trade[]): Stats {
  // FIFO pairing for behavior analytics + we also keep the open legs map
  const { roundTrips, openLegsBySymbol } = pairRoundTripsAndOpen(trades);

  // RAW paired-only headline & scrip table
  const pairedRaw = computePairedHeadlineFromRawSymbolFilter(trades);
  const netPnl = pairedRaw.netPnl;
  const scripSummary = buildRawScripSummary(trades, pairedRaw.pairedSymbols);

  // precise open positions (with avgPrice)
  const openPositions = buildOpenPositionsFromOpenLegs(openLegsBySymbol);

  // === KPIs (from roundTrips for behavior analysis) ===
  let wins = 0, losses = 0, profitSum = 0, lossSum = 0;
  const pnlByDate: Record<string, number> = {};
  const tradeDates: string[] = [];

  for (const rt of roundTrips) {
    const d = rt.exit.Date;
    pnlByDate[d] = (pnlByDate[d] || 0) + rt.PnL;
    if (!tradeDates.includes(d)) tradeDates.push(d);
    if (rt.PnL > 0) { wins++; profitSum += rt.PnL; }
    else if (rt.PnL < 0) { losses++; lossSum += Math.abs(rt.PnL); }
  }

  const avgWin = wins ? profitSum / wins : 0;
  const avgLoss = losses ? lossSum / losses : 0;
  const tradeWinPercent = roundTrips.length ? (wins / roundTrips.length) * 100 : 0;
  const profitFactor = lossSum === 0 ? (profitSum > 0 ? Infinity : 0) : profitSum / lossSum;
  const dayWinPercent = tradeDates.length
    ? (Object.values(pnlByDate).filter(v => v > 0).length / tradeDates.length) * 100
    : 0;

  // === Demon / Good practice tagging ===
  const minGoodRR = 1.2, maxRiskPercent = 2.0, overtradeLimit = 5;
  const earlyEntryCutoff = "09:20", revengeWindowMins = 15, SLTolerance = 1.3;

  const badTagSummary: Record<string, { count: number, totalCost: number }> = {};
  const goodTagSummary: Record<string, { count: number, totalProfit: number }> = {};
  standardDemons.forEach(t => badTagSummary[t] = { count: 0, totalCost: 0 });
  standardGood.forEach(t => goodTagSummary[t] = { count: 0, totalProfit: 0 });

  let totalBadTradeCost = 0;
  let totalGoodTradeProfit = 0;
  let enteredTooSoonCount = 0;
  const capital = 100000;
  let prevLossExitTime: Date | null = null;
  let prevLossDirection: "Buy" | "Sell" | null = null;
  const dayOrdinal: Record<string, number> = {};

  for (const t of roundTrips) {
    const demons: string[] = [];
    const good: string[] = [];

    const day = t.exit.Date;
    dayOrdinal[day] = (dayOrdinal[day] || 0) + 1;
    const tradeNumberToday = dayOrdinal[day];

    if (t.PnL > 0 && t.entry.stopDistance && t.entry.stopDistance > 0) {
      const riskAmt = (t.entry.stopDistance) * (t.entry.Quantity || 1);
      const rr = riskAmt > 0 ? t.PnL / riskAmt : 0;
      if (rr < minGoodRR) demons.push("POOR RISK/REWARD TRADE");
    }
    if (t.PnL < 0 && t.holdingMinutes > 90) demons.push("HELD LOSS TOO LONG");
    if (t.PnL > 0 && t.holdingMinutes < 8 && t.PnL < avgWin * 0.8) demons.push("PREMATURE EXIT");
    if (t.PnL < 0 && Math.abs(t.PnL) > Math.abs(avgLoss * SLTolerance)) demons.push("MISSED STOP LOSS");

    if (t.entry.Time && t.entry.Time < earlyEntryCutoff) { demons.push("CHASED ENTRY"); enteredTooSoonCount++; }

    const riskAmtApprox = Math.abs((t.entry.Price - t.exit.Price) * (t.entry.Quantity || 1));
    if (riskAmtApprox > (capital * maxRiskPercent) / 100 || (avgLoss > 0 && riskAmtApprox > avgLoss * 2.5)) {
      demons.push("WRONG POSITION SIZE");
    }
    if (tradeNumberToday > overtradeLimit) demons.push("OVERTRADING");

    if (prevLossExitTime && t.entry.Time && t.PnL < 0 && prevLossDirection === t.entry.Direction) {
      const entryDT = new Date(`${t.entry.Date}T${t.entry.Time}`);
      const minsDiff = Math.round((entryDT.getTime() - prevLossExitTime.getTime()) / 60000);
      if (minsDiff >= 0 && minsDiff <= revengeWindowMins) demons.push("REVENGE TRADING");
    }
    if (t.PnL < 0) { prevLossExitTime = new Date(`${t.exit.Date}T${t.exit.Time || "00:00"}`); prevLossDirection = t.entry.Direction; }

    // Good tags
    if (t.PnL > 0 && avgLoss > 0 && t.PnL >= Math.abs(avgLoss * 1.2)) good.push("GOOD RISK/REWARD");
    const notEarly = !t.entry.Time || t.entry.Time >= earlyEntryCutoff;
    const respectedSL = (t.PnL <= 0 && Math.abs(t.PnL) <= Math.abs(avgLoss * SLTolerance)) || t.PnL > 0;
    if (!demons.includes("CHASED ENTRY") && notEarly && respectedSL) good.push("PROPER ENTRY");
    if (!demons.includes("PREMATURE EXIT") && !demons.includes("MISSED STOP LOSS")) good.push("PROPER EXIT");
    if (t.PnL < 0 && Math.abs(t.PnL) <= Math.abs(avgLoss * SLTolerance)) good.push("STOP LOSS RESPECTED");
    if (t.PnL > 0 && t.holdingMinutes > 12 && t.PnL > Math.abs(avgLoss * 1.2)) good.push("HELD FOR TARGET");
    if (demons.length === 0 && good.length >= 2) good.push("DISCIPLINED");

    t.DemonArr = Array.from(new Set(demons));
    t.GoodPracticeArr = Array.from(new Set(good));
    t.Demon = t.DemonArr.join(", ");
    t.GoodPractice = t.GoodPracticeArr.join(", ");

    t.isBadTrade = t.DemonArr.length > 0 && t.PnL < 0;
    t.isGoodTrade = t.GoodPracticeArr.length >= 2 && t.DemonArr.length === 0 && (t.PnL > 0 || t.GoodPracticeArr.includes("STOP LOSS RESPECTED"));

    if (t.isBadTrade && t.PnL < 0) {
      totalBadTradeCost += Math.abs(t.PnL);
      const main = t.DemonArr[0]; if (main) { (badTagSummary[main] ||= { count: 0, totalCost: 0 }).count++; badTagSummary[main].totalCost += Math.abs(t.PnL); }
    }
    if (t.isGoodTrade && t.PnL > 0) {
      totalGoodTradeProfit += t.PnL;
      const main = t.GoodPracticeArr[0]; if (main) { (goodTagSummary[main] ||= { count: 0, totalProfit: 0 }).count++; goodTagSummary[main].totalProfit += t.PnL; }
    }
  }

  const demonFinder = Object.entries(badTagSummary).sort((a,b) => b[1].count - a[1].count).slice(0,3).map(([d]) => d);

  const planOfAction: string[] = []; // kept for compatibility; UI shows “What went wrong”
// keep field for compatibility (UI now shows “What went wrong”, not actions)
  const upholicScore = Math.min(100, (80 * 0.4) + (tradeWinPercent * 0.3) + (dayWinPercent * 0.3));

  const totalsCheck = {
    netPnlFromScrips: r2(scripSummary.reduce((s, r) => s + (r.netRealized || 0), 0)),
    chargesFromScrips: r2(scripSummary.reduce((s, r) => s + (r.charges || 0), 0)),
  };

  return {
    netPnl: r2(netPnl),
    pnlBasis: "PAIRED_RAW",
    totalsCheck,

    tradeWinPercent: r2(tradeWinPercent),
    profitFactor,
    dayWinPercent: r2(dayWinPercent),
    avgWinLoss: { avgWin: r2(avgWin), avgLoss: r2(avgLoss) },
    upholicScore: Math.max(0, Math.round(upholicScore)),
    upholicPointers: { patience: 80, demonFinder, planOfAction },

    trades: roundTrips,
    tradeDates,
    empty: roundTrips.length === 0,

    totalBadTradeCost: r2(totalBadTradeCost),
    totalGoodTradeProfit: r2(totalGoodTradeProfit),
    badTradeCounts: badTagSummary,
    goodTradeCounts: goodTagSummary,
    standardDemons,
    standardGood,
    enteredTooSoonCount,

    scripSummary,

    pairedTotals: {
      buyQty: pairedRaw.buyQty,
      sellQty: pairedRaw.sellQty,
      avgBuy: pairedRaw.avgBuy,
      avgSell: pairedRaw.avgSell,
      charges: pairedRaw.charges,
      netPnl: pairedRaw.netPnl,
    },

    openPositions,
  };
}
