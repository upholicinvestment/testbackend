import multer from "multer";
import csvParser from "csv-parser";
import fs from "fs";
import path from "path";

// ----------- TYPES -----------
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
  stopDistance?: number; // per-unit stop distance if available
  executed?: boolean;
  Demon?: string;
  DemonArr?: string[];
  GoodPractice?: string;
  GoodPracticeArr?: string[];
  isBadTrade?: boolean;
  isGoodTrade?: boolean;
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

export interface Stats {
  netPnl: number;
  tradeWinPercent: number;
  profitFactor: number;
  dayWinPercent: number;
  avgWinLoss: { avgWin: number; avgLoss: number };
  upholicScore: number;
  upholicPointers: {
    patience: number;
    demonFinder: string[];
    planOfAction: string[];
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
}

// ----------- CONSTANTS -----------
export const standardDemons = [
  "POOR RISK/REWARD TRADE", "HELD LOSS TOO LONG", "PREMATURE EXIT",
  "REVENGE TRADING", "OVERTRADING", "WRONG POSITION SIZE",
  "CHASED ENTRY", "MISSED STOP LOSS"
];

export const standardGood = [
  "GOOD RISK/REWARD", "PROPER ENTRY", "PROPER EXIT",
  "FOLLOWED PLAN", "STOP LOSS RESPECTED", "HELD FOR TARGET", "DISCIPLINED"
];

// ----------- MULTER UPLOAD -----------
export const tradeJournalUpload = multer({ dest: "uploads/" });

// ----------- DATE NORMALIZER -----------
function normalizeTradeDate(dateStr: string | undefined | null): string {
  if (!dateStr) return "";
  // ISO: "2025-06-13"
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return dateStr.slice(0, 10);
  // MM/DD/YYYY or M/D/YYYY
  let mdy = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mdy) {
    let [_, m, d, y] = mdy;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // DD/MM/YYYY
  let dmy = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) {
    let [_, d, m, y] = dmy;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // fallback
  return dateStr.slice(0, 10);
}

// ----------- CSV PARSER -----------
function findTradeTableHeaderIndex(lines: string[]): number {
  const possibleHeaders = [
    "Scrip/Contract,Buy/Sell,Buy Price",
    "symbol,isin,trade_date",
    "Scrip Name,Trade Type,Trade Date"
  ];
  return lines.findIndex(line =>
    possibleHeaders.some(header =>
      line.replace(/\s/g, '').toLowerCase().startsWith(header.replace(/\s/g, '').toLowerCase())
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
              const parts = row["order_execution_time"].split("T");
              if (parts.length === 2) {
                date = parts[0];
                time = parts[1];
              }
            } else if (row["order_execution_time"].includes(" ")) {
              const parts = row["order_execution_time"].split(" ");
              if (parts.length === 2) {
                date = parts[0];
                time = parts[1];
              }
            }
          } else if (row["trade_time"]) {
            time = row["trade_time"];
          }
          trades.push({
            Date: normalizeTradeDate(date),
            Time: time,
            Symbol: row["symbol"],
            Direction: row["trade_type"]?.toLowerCase() === "buy" ? "Buy" : "Sell",
            Price: parseFloat(row["price"]) || 0,
            Quantity: parseInt(row["quantity"]) || 0,
            PnL: 0,
            Charges: 0,
            NetPnL: 0,
          });
        }
        // Angel/Upstox/ICICI-like
        else if (row["Scrip/Contract"]) {
          let price = 0;
          if (row["Buy/Sell"]?.toLowerCase() === "buy")
            price = parseFloat(row["Buy Price"]) || 0;
          else
            price = parseFloat(row["Sell Price"]) || 0;

          let date = row["Date"] || row["Trade Date"] || "";
          let time = row["Time"] || row["Trade Time"] || row["Order Time"] || row["TradeDateTime"] || "";
          if (typeof time === "string" && time.includes(" ")) {
            const parts = time.split(" ");
            if (parts.length === 2) {
              date = parts[0];
              time = parts[1];
            }
          }
          if (typeof time === "string" && !/\d{2}:\d{2}/.test(time)) time = "";

          const chargeFields = [
            "Brokerage", "GST", "STT", "Sebi Tax", "Exchange Turnover Charges",
            "Stamp Duty", "Other Charges", "IPFT Charges"
          ];
          const charges = chargeFields.reduce(
            (sum, key) => sum + (parseFloat(row[key]) || 0), 0
          );

          trades.push({
            Date: normalizeTradeDate(date),
            Time: time,
            Symbol: row["Scrip/Contract"],
            Direction: row["Buy/Sell"]?.toLowerCase() === "buy" ? "Buy" : "Sell",
            Price: price,
            Quantity: parseInt(row["Quantity"]) || 0,
            PnL: 0,
            Charges: charges,
            NetPnL: 0,
          });
        }
      })
      .on("end", () => {
        fs.unlinkSync(tempCsv);
        resolve(trades);
      })
      .on("error", (err) => {
        fs.unlinkSync(tempCsv);
        reject(err);
      });
  });
}

// ----------- ROUND TRIP PAIRING -----------
function pairRoundTrips(trades: Trade[]): RoundTrip[] {
  const sorted = trades
    .filter(t => t.Symbol && t.Direction && t.Quantity && t.Price)
    .sort((a, b) => {
      const aTime = new Date(`${a.Date}T${a.Time || "00:00"}`);
      const bTime = new Date(`${b.Date}T${b.Time || "00:00"}`);
      return aTime.getTime() - bTime.getTime();
    });

  const roundTrips: RoundTrip[] = [];
  const openPositions: { [symbol: string]: Trade[] } = {};

  for (const trade of sorted) {
    const symbol = trade.Symbol!;
    if (!openPositions[symbol]) openPositions[symbol] = [];
    const openLegs = openPositions[symbol];
    if (
      openLegs.length > 0 &&
      trade.Direction !== openLegs[0].Direction
    ) {
      let qtyToClose = trade.Quantity!;
      while (openLegs.length && qtyToClose > 0) {
        const entryLeg = openLegs[0];
        const closeQty = Math.min(qtyToClose, entryLeg.Quantity!);
        const entryLegUsed: Trade = { ...entryLeg, Quantity: closeQty };
        if (entryLeg.Quantity! > closeQty) {
          entryLeg.Quantity! -= closeQty;
        } else {
          openLegs.shift();
        }
        const exitLeg: Trade = { ...trade, Quantity: closeQty };
        const pnl =
          entryLegUsed.Direction === "Buy"
            ? (exitLeg.Price! - entryLegUsed.Price!) * closeQty - (entryLegUsed.Charges || 0) - (exitLeg.Charges || 0)
            : (entryLegUsed.Price! - exitLeg.Price!) * closeQty - (entryLegUsed.Charges || 0) - (exitLeg.Charges || 0);

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
    } else {
      openLegs.push({ ...trade });
    }
  }
  return roundTrips;
}

// ----------- ANALYSIS: PROCESS ROUND-TRIP TRADES -----------
export function processTrades(trades: Trade[]): Stats {
  // --- Parameters ---
  const minGoodRR = 1.2;
  const maxRiskPercent = 2.0;
  const overtradeLimit = 5; // IMPORTANT: used by UI too
  const earlyEntryCutoff = "09:20";
  const revengeWindowMins = 15;
  const SLTolerance = 1.3;

  const roundTrips = pairRoundTrips(trades);

  let netPnl = 0, wins = 0, losses = 0, profitSum = 0, lossSum = 0;
  let pnlByDate: Record<string, number> = {};
  let patienceScore = 80;
  const tradeDates: string[] = [];

  const capital = 100000; // Replace with your tracked capital if needed

  // Track last loss for revenge logic
  let prevLossExitTime: Date | null = null;
  let prevLossDirection: "Buy" | "Sell" | null = null;

  for (const rt of roundTrips) {
    netPnl += rt.PnL;
    const tradeDate = rt.exit.Date;
    pnlByDate[tradeDate] = (pnlByDate[tradeDate] || 0) + rt.PnL;
    if (!tradeDates.includes(tradeDate)) tradeDates.push(tradeDate);

    if (rt.PnL > 0) { wins++; profitSum += rt.PnL; }
    else if (rt.PnL < 0) { losses++; lossSum += Math.abs(rt.PnL); }
  }

  const avgWin = wins ? profitSum / wins : 0;
  const avgLoss = losses ? lossSum / losses : 0;

  // Demon & Good tracking: per-tag unique aggregation
  const badTagSummary: Record<string, { count: number, totalCost: number }> = {};
  const goodTagSummary: Record<string, { count: number, totalProfit: number }> = {};
  standardDemons.forEach(tag => badTagSummary[tag] = { count: 0, totalCost: 0 });
  standardGood.forEach(tag => goodTagSummary[tag] = { count: 0, totalProfit: 0 });

  let totalBadTradeCost = 0;
  let totalGoodTradeProfit = 0;
  let enteredTooSoonCount = 0;

  // Track per-day ordinal to tag ONLY trades beyond the limit as "OVERTRADING"
  const dayOrdinal: Record<string, number> = {};

  // Tagging logic (robust)
  for (let i = 0; i < roundTrips.length; i++) {
    const t: RoundTrip = roundTrips[i];
    const demons: string[] = [];
    const goodPractices: string[] = [];
    t.isBadTrade = false;
    t.isGoodTrade = false;

    // Per-day ordinal (chronological order preserved by pairing)
    const day = t.exit.Date;
    dayOrdinal[day] = (dayOrdinal[day] || 0) + 1;
    const tradeNumberToday = dayOrdinal[day];

    // BAD tags

    // POOR R/R only when we know the actual stop distance (avoid false positives)
    if (t.PnL > 0 && t.entry.stopDistance && t.entry.stopDistance > 0) {
      const riskAmt = (t.entry.stopDistance) * (t.entry.Quantity || 1);
      const rr = riskAmt > 0 ? t.PnL / riskAmt : 0;
      if (rr < minGoodRR) demons.push("POOR RISK/REWARD TRADE");
    }

    if (t.PnL < 0 && t.holdingMinutes > 90) demons.push("HELD LOSS TOO LONG");
    if (t.PnL > 0 && t.holdingMinutes < 8 && t.PnL < avgWin * 0.8) demons.push("PREMATURE EXIT");
    if (t.PnL < 0 && Math.abs(t.PnL) > Math.abs(avgLoss * SLTolerance)) demons.push("MISSED STOP LOSS");

    // Entered too early / chased
    if (t.entry.Time && t.entry.Time < earlyEntryCutoff) {
      demons.push("CHASED ENTRY");
      enteredTooSoonCount++;
    }

    // Position size sanity (approx)
    const riskAmtApprox = Math.abs((t.entry.Price - t.exit.Price) * (t.entry.Quantity || 1));
    if (riskAmtApprox > (capital * maxRiskPercent) / 100 || (avgLoss > 0 && riskAmtApprox > avgLoss * 2.5)) {
      demons.push("WRONG POSITION SIZE");
    }

    // Only mark trades BEYOND the limit as overtrades (not every trade on a busy day)
    if (tradeNumberToday > overtradeLimit) demons.push("OVERTRADING");

    // Revenge trading detection
    if (
      prevLossExitTime &&
      t.entry.Time && t.PnL < 0 &&
      prevLossDirection === t.entry.Direction
    ) {
      const entryDT = new Date(`${t.entry.Date}T${t.entry.Time}`);
      const minsDiff = Math.round((entryDT.getTime() - prevLossExitTime.getTime()) / 60000);
      if (minsDiff >= 0 && minsDiff <= revengeWindowMins) {
        demons.push("REVENGE TRADING");
      }
    }
    if (t.PnL < 0) {
      prevLossExitTime = new Date(`${t.exit.Date}T${t.exit.Time || "00:00"}`);
      prevLossDirection = t.entry.Direction;
    }

    // GOOD tags
    if (t.PnL > 0 && avgLoss > 0 && t.PnL >= Math.abs(avgLoss * minGoodRR)) {
      goodPractices.push("GOOD RISK/REWARD");
    }

    const notEarly = !t.entry.Time || t.entry.Time >= earlyEntryCutoff;
    const respectedSL = (t.PnL <= 0 && Math.abs(t.PnL) <= Math.abs(avgLoss * SLTolerance)) || t.PnL > 0;

    // Make PROPER ENTRY selective to avoid matching Overtrading counts
    if (!demons.includes("CHASED ENTRY") && notEarly && respectedSL) {
      goodPractices.push("PROPER ENTRY");
    }

    if (!demons.includes("PREMATURE EXIT") && !demons.includes("MISSED STOP LOSS")) {
      goodPractices.push("PROPER EXIT");
    }

    if (t.PnL < 0 && Math.abs(t.PnL) <= Math.abs(avgLoss * SLTolerance)) {
      goodPractices.push("STOP LOSS RESPECTED");
    }

    if (t.PnL > 0 && t.holdingMinutes > 12 && t.PnL > Math.abs(avgLoss * 1.2)) {
      goodPractices.push("HELD FOR TARGET");
    }

    if (demons.length === 0 && goodPractices.length >= 2) {
      goodPractices.push("DISCIPLINED");
    }

    // --- Mark trade ---
    t.DemonArr = Array.from(new Set(demons));
    t.Demon = t.DemonArr.join(", ");
    t.GoodPracticeArr = Array.from(new Set(goodPractices));
    t.GoodPractice = t.GoodPracticeArr.join(", ");

    // Good/Bad trade logic
    t.isBadTrade = t.DemonArr.length > 0 && t.PnL < 0;
    t.isGoodTrade =
      t.GoodPracticeArr.length >= 2 &&
      t.DemonArr.length === 0 &&
      ((t.PnL > 0) || (t.PnL <= 0 && t.GoodPracticeArr.includes("STOP LOSS RESPECTED")));

    // Tag summary aggregation (primary tag only)
    if (t.isBadTrade && t.PnL < 0) {
      totalBadTradeCost += Math.abs(t.PnL);
      if (t.DemonArr.length > 0) {
        const mainTag = t.DemonArr[0];
        badTagSummary[mainTag].count += 1;
        badTagSummary[mainTag].totalCost += Math.abs(t.PnL);
      }
    }
    if (t.isGoodTrade && t.PnL > 0) {
      totalGoodTradeProfit += t.PnL;
      if (t.GoodPracticeArr.length > 0) {
        const mainTag = t.GoodPracticeArr[0];
        goodTagSummary[mainTag].count += 1;
        goodTagSummary[mainTag].totalProfit += t.PnL;
      }
    }
  }

  // Demon Finder and Plan of Action (TOP-3 only, always present)
  const demonFinder = Object.entries(badTagSummary)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 3)
    .map(([demon]) => demon);

  const actionableByDemon: Record<string, string> = {
    "POOR RISK/REWARD TRADE": "Only take setups with ≥1.5R potential; predefine targets and partial exits.",
    "HELD LOSS TOO LONG": "Use hard SL and exit immediately when hit—no averaging down or hoping.",
    "PREMATURE EXIT": "Trail stops using structure; take partial at 1R and let the rest run.",
    "REVENGE TRADING": "After a loss, enforce a 15–30 min cooldown—skip the very next signal.",
    "OVERTRADING": "Cap to 5 trades/day; stop after 2 consecutive losses for the session.",
    "WRONG POSITION SIZE": "Risk ≤2% per trade; size via calculator using stop distance.",
    "CHASED ENTRY": "Avoid early entries; wait for retest/limit fill and skip first 5 minutes.",
    "MISSED STOP LOSS": "Place OCO protective stops with the entry and never cancel them."
  };

  const candidateActions: string[] = [];
  demonFinder.forEach(d => {
    const a = actionableByDemon[d];
    if (a) candidateActions.push(a);
  });

  const totalTrades = roundTrips.length;
  const tradeWinPercent = totalTrades ? (wins / totalTrades) * 100 : 0;
  const profitFactor = lossSum === 0 ? (profitSum > 0 ? Infinity : 0) : profitSum / lossSum;
  const dayWinPercent = Object.keys(pnlByDate).length
    ? (Object.values(pnlByDate).filter(v => v > 0).length / Object.keys(pnlByDate).length * 100)
    : 0;

  // Metric-derived actions (fillers to reach exactly 3)
  if (tradeWinPercent < 40) candidateActions.push("Trade only A+ setups for a week; skip marginal conditions.");
  if (!Number.isFinite(profitFactor) || profitFactor < 1) candidateActions.push("Tighten losses and let winners run using R-based take-profits.");
  if (enteredTooSoonCount > 0) candidateActions.push("No entries before 09:20—let structure form before engaging.");

  // De-dup and clamp to EXACTLY 3
  const planOfAction = Array.from(new Set(candidateActions)).slice(0, 3);
  while (planOfAction.length < 3) {
    // add sensible generic fillers if needed
    const fillers = [
      "Journal screenshots of entries/exits daily to review execution quality.",
      "Set alerts at key levels and avoid impulse market orders.",
      "Pre-define max daily loss; stop trading when it hits."
    ];
    const next = fillers.find(f => !planOfAction.includes(f));
    if (!next) break;
    planOfAction.push(next);
  }

  if (tradeWinPercent < 40 && !planOfAction.includes("Focus on higher probability setups.")) {
    // already addressed by A+ setups filler; skip adding the old one
  }
  if (profitFactor < 1) {
    // covered above; avoid duplication
  }
  if (dayWinPercent < 50 && planOfAction.length < 3) {
    planOfAction.push("Aim for consistency: take fewer, higher-quality trades per day.");
  }

  const upholicScore = Math.min(
    100,
    (patienceScore * 0.4) + (tradeWinPercent * 0.3) + (dayWinPercent * 0.3)
  );

  return {
    netPnl,
    tradeWinPercent,
    profitFactor,
    dayWinPercent,
    avgWinLoss: { avgWin, avgLoss },
    upholicScore: Math.max(0, Math.round(upholicScore)),
    upholicPointers: {
      patience: patienceScore,
      demonFinder,
      planOfAction // exactly 3 now
    },
    trades: roundTrips,
    tradeDates,
    empty: roundTrips.length === 0,
    totalBadTradeCost,
    totalGoodTradeProfit,
    badTradeCounts: badTagSummary,
    goodTradeCounts: goodTagSummary,
    standardDemons,
    standardGood,
    enteredTooSoonCount
  };
}
