
import { Db, ObjectId } from "mongodb";
import crypto from "crypto";

/* ---------- Types (aligned to journal stack) ---------- */
type Trade = {
  Date: string;
  Time?: string;
  Symbol: string;
  Direction: "Buy" | "Sell";
  Quantity: number;
  Price: number;
  PnL: number;
  Charges?: number;
  NetPnL: number;
};

export type RoundTrip = {
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
};

export type DaySnapshotDoc = {
  _id?: ObjectId;
  userId: string | null;
  tradingDate: string;        // YYYY-MM-DD
  sourceId: ObjectId;
  broker?: string | null;
  version: number;
  isSuperseded: boolean;
  frozenAt: Date;

  tradeCount: number;         // completed round-trips (by exit date)
  netPnl: number;             // PAIRED_RAW basis
  grossProfit: number;
  grossLoss: number;
  wins: number;               // per-trade (round-trip) wins
  losses: number;             // per-trade losses
  winRate: number;
  profitFactor: number;       // Infinity when gp>0 & gl=0
  bestTradePnl: number;
  worstTradePnl: number;
  fees: number;               // full charges (rows)

  symbolCount: number;
  longCount: number;          // legs count (rows) classified as long/short
  shortCount: number;
};

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;

export function md5(buf: Buffer | string) {
  return crypto.createHash("md5").update(buf).digest("hex");
}

function normalizeDate10(d: string | undefined) {
  if (!d) return "";
  const s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // DD/MM/YYYY or MM/DD/YYYY (assume DD/MM when ambiguous)
  const m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m1) {
    const [, a, b, y] = m1;
    const day = Number(a) > 12 ? a : b;
    const mon = Number(a) > 12 ? b : a;
    return `${y}-${mon.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  // DD-MM-YYYY
  const m2 = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m2) {
    const [, d2, m2o, y] = m2;
    return `${y}-${m2o.padStart(2, "0")}-${d2.padStart(2, "0")}`;
  }

  return s.slice(0, 10);
}

/* ---------- Index bootstrap ---------- */
export async function ensureCalendarIndexes(db: Db) {
  // orderbooks: unique (userId, fileHash)
  const ob = db.collection("orderbooks");
  try {
    const idxs = await ob.listIndexes().toArray().catch(() => []);
    for (const i of idxs) {
      const key = (i.key ?? {}) as Record<string, 1 | -1>;
      const legacy = key.fileHash === 1 && !("userId" in key);
      if (i.name !== "_id_" && legacy) {
        try { await ob.dropIndex(i.name); } catch {}
      }
    }
  } catch {}
  try {
    const have = await ob.listIndexes().toArray().catch(() => []);
    const exists = have.some((i: any) => i.unique && i.key?.userId === 1 && i.key?.fileHash === 1);
    if (!exists) await ob.createIndex({ userId: 1, fileHash: 1 }, { unique: true, background: true, name: "uniq_user_fileHash" });
  } catch (e: any) { if (e?.code !== 85) throw e; }

  // journal_day_stats: read + partial unique on active
  const jds = db.collection("journal_day_stats");
  try {
    await jds.createIndex({ userId: 1, tradingDate: 1, isSuperseded: 1 }, { background: true, name: "stats_user_date_activeflag" });
  } catch {}
  try {
    const jIdx = await jds.listIndexes().toArray().catch(() => []);
    const has = jIdx.some((i: any) =>
      i.unique && i.key?.userId === 1 && i.key?.tradingDate === 1 && i.partialFilterExpression?.isSuperseded === false
    );
    if (!has) {
      await jds.createIndex(
        { userId: 1, tradingDate: 1 },
        { unique: true, partialFilterExpression: { isSuperseded: false }, background: true, name: "uniq_user_date_active" }
      );
    }
  } catch (e: any) { if (e?.code !== 85) throw e; }
}

/**
 * Legacy: freeze from roundTrips only (kept for compatibility).
 */
export async function freezeDaySnapshotsFromRoundTrips(
  db: Db,
  opts: { userId?: string | null; sourceId: ObjectId; broker?: string | null; roundTrips: RoundTrip[] }
) {
  const userIdStr: string | null = opts.userId ?? null;
  const col = db.collection<DaySnapshotDoc>("journal_day_stats");

  const byDate = new Map<string, RoundTrip[]>();
  for (const rt of opts.roundTrips) {
    const d = normalizeDate10(rt.exit?.Date);
    if (!d) continue;
    (byDate.get(d) ?? byDate.set(d, []).get(d)!).push(rt);
  }

  for (const [tradingDate, rts] of byDate) {
    let tradeCount = rts.length;
    let netPnl = 0, gp = 0, gl = 0, wins = 0, losses = 0;
    let best = -Infinity, worst = Infinity;
    let longCount = 0, shortCount = 0;
    const symbols = new Set<string>();

    for (const rt of rts) {
      symbols.add(rt.symbol);
      if (rt.entry?.Direction === "Buy") longCount++; else shortCount++;
      const p = Number(rt.PnL || 0);
      netPnl += p;
      if (p > 0) { wins++; gp += p; }
      else if (p < 0) { losses++; gl += Math.abs(p); }
      if (p > best) best = p;
      if (p < worst) worst = p;
    }

    const pf = gl ? gp / gl : (gp > 0 ? Infinity : 0);
    await col.updateMany({ userId: userIdStr, tradingDate, isSuperseded: false }, { $set: { isSuperseded: true } });
    const doc: DaySnapshotDoc = {
      userId: userIdStr,
      tradingDate,
      sourceId: opts.sourceId,
      broker: opts.broker ?? null,
      version: 1,
      isSuperseded: false,
      frozenAt: new Date(),
      tradeCount,
      netPnl: r2(netPnl),
      grossProfit: r2(gp),
      grossLoss: r2(gl),
      wins,
      losses,
      winRate: r4((wins + losses) ? wins / (wins + losses) : 0),
      profitFactor: Number.isFinite(pf) ? r2(pf) : Infinity,
      bestTradePnl: isFinite(best) ? r2(best) : 0,
      worstTradePnl: isFinite(worst) ? r2(worst) : 0,
      fees: 0,
      symbolCount: symbols.size,
      longCount,
      shortCount,
    };
    await col.insertOne(doc);
  }
}

/**
 * NEW: freeze daily snapshots from trades **and** roundTrips.
 * - P&L basis: **PAIRED_RAW** from rows (paired symbols only, raw prices, full charges).
 * - Metadata + PF (gp/gl/wins/losses/best/worst): from **roundTrips** by exit date.
 */
export async function freezeDaySnapshotsFromTradesPairedRaw(
  db: Db,
  opts: {
    userId?: string | null;
    sourceId: ObjectId;
    broker?: string | null;
    trades: Trade[];
    roundTrips?: RoundTrip[];
  }
) {
  const userIdStr: string | null = opts.userId ?? null;
  const col = db.collection<DaySnapshotDoc>("journal_day_stats");

  // detect paired symbols
  const seen = new Map<string, { buy: boolean; sell: boolean }>();
  for (const t of opts.trades) {
    const v = seen.get(t.Symbol) ?? { buy: false, sell: false };
    if (t.Direction === "Buy") v.buy = true; else if (t.Direction === "Sell") v.sell = true;
    seen.set(t.Symbol, v);
  }
  const paired = new Set<string>();
  seen.forEach((v, s) => { if (v.buy && v.sell) paired.add(s); });

  // PAired-RAW aggregates by day (for NET P&L only)
  type DayAgg = {
    buyNotional: number; sellNotional: number; charges: number;
    legs: number; symbols: Set<string>; longLegs: number; shortLegs: number;
  };
  const perDay = new Map<string, DayAgg>();

  for (const t of opts.trades) {
    if (!t.Symbol || !paired.has(t.Symbol)) continue;
    const d = normalizeDate10(t.Date); if (!d) continue;

    const a = perDay.get(d) ?? {
      buyNotional: 0, sellNotional: 0, charges: 0,
      legs: 0, symbols: new Set<string>(), longLegs: 0, shortLegs: 0
    };

    const q = t.Quantity || 0;
    const any = t as any;
    const rawPrice =
      t.Direction === "Buy" ? (any.buyPriceRaw ?? t.Price ?? 0)
                            : (any.sellPriceRaw ?? t.Price ?? 0);

    if (t.Direction === "Buy") { a.buyNotional += rawPrice * q; a.longLegs++; }
    else { a.sellNotional += rawPrice * q; a.shortLegs++; }
    a.charges += t.Charges || 0;
    a.legs += 1;
    a.symbols.add(t.Symbol);
    perDay.set(d, a);
  }

  // Round-trips grouped by exit date (for PF & metadata)
  const rtsByDate = new Map<string, RoundTrip[]>();
  if (opts.roundTrips?.length) {
    for (const rt of opts.roundTrips) {
      if (!paired.has(rt.symbol)) continue;
      const d = normalizeDate10(rt.exit?.Date); if (!d) continue;
      (rtsByDate.get(d) ?? rtsByDate.set(d, []).get(d)!).push(rt);
    }
  }

  for (const [tradingDate, a] of perDay.entries()) {
    // Net on PAIRED_RAW basis
    const net = (a.sellNotional - a.buyNotional) - a.charges;

    // Defaults (fallback when no round-trips available)
    let tradeCount = a.legs;
    let wins = 0, losses = 0, best = 0, worst = 0;
    let gpForPF = net > 0 ? net : 0;
    let glForPF = net < 0 ? Math.abs(net) : 0;

    // If we have round-trips for this date, compute PF & metadata from them
    const rts = rtsByDate.get(tradingDate) ?? [];
    if (rts.length) {
      tradeCount = rts.length;
      let gp = 0, gl = 0, bestP = -Infinity, worstP = Infinity;
      for (const rt of rts) {
        const p = Number(rt.PnL || 0);
        if (p > 0) { wins++; gp += p; }
        else if (p < 0) { losses++; gl += Math.abs(p); }
        if (p > bestP) bestP = p;
        if (p < worstP) worstP = p;
      }
      gpForPF = gp;
      glForPF = gl;
      best = isFinite(bestP) ? r2(bestP) : 0;
      worst = isFinite(worstP) ? r2(worstP) : 0;
    }

    const pf = glForPF ? gpForPF / glForPF : (gpForPF > 0 ? Infinity : 0);
    const winRate = (wins + losses) ? wins / (wins + losses) : (gpForPF > 0 ? 1 : 0);

    await col.updateMany({ userId: userIdStr, tradingDate, isSuperseded: false }, { $set: { isSuperseded: true } });

    const doc: DaySnapshotDoc = {
      userId: userIdStr,
      tradingDate,
      sourceId: opts.sourceId,
      broker: opts.broker ?? null,
      version: 2,
      isSuperseded: false,
      frozenAt: new Date(),

      tradeCount,
      netPnl: r2(net),

      // Store the PF inputs we actually used (from RTs when available)
      grossProfit: r2(gpForPF),
      grossLoss: r2(glForPF),

      wins,
      losses,
      winRate: r4(winRate),
      profitFactor: Number.isFinite(pf) ? r2(pf) : Infinity,
      bestTradePnl: best,
      worstTradePnl: worst,
      fees: r2(a.charges),

      symbolCount: a.symbols.size,
      longCount: a.longLegs,
      shortCount: a.shortLegs,
    };

    await col.insertOne(doc);
  }
}

/** Create (or reuse) an orderbook meta doc and return its _id */
export async function upsertOrderbookMeta(
  db: Db,
  opts: { fileHash: string; sourceName?: string; size?: number; userId?: string | null; broker?: string | null }
): Promise<ObjectId> {
  const obCol = db.collection("orderbooks");
  const userId = opts.userId ?? null;

  const existing = await obCol.findOne({ userId, fileHash: opts.fileHash });
  if (existing?._id) return existing._id as ObjectId;

  const ins = await obCol.insertOne({
    userId,
    fileHash: opts.fileHash,
    sourceName: opts.sourceName || null,
    size: opts.size || null,
    broker: opts.broker || null,
    uploadedAt: new Date(),
  });
  return ins.insertedId;
}
