// server/src/utils/gex_from_cache.ts
import { bsGamma } from "./bs";
import { timeToExpiryYears } from "./time";

/* ───────── Types ───────── */
type Leg = {
  greeks?: { gamma?: number; implied_volatility?: number };
  last_price?: number;
  oi?: number;
  volume?: number;
  top_ask_price?: number;
  top_bid_price?: number;
};

type StrikeRow = { strike?: number; ce?: Leg; pe?: Leg; };

type OCached = {
  underlying_security_id: number;
  underlying_segment: string;
  underlying_symbol?: string;
  last_price: number;
  expiry: string;              // YYYY-MM-DD or ISO
  strikes: StrikeRow[];
  updated_at?: string;         // ISO
};

export type GexOutRow = {
  strike: number;

  // RAW (dimensionless → bind these in your UI)
  gex_oi_raw: number;          // Γ × (CE_OI − PE_OI)
  gex_vol_raw: number;         // Γ × (CE_VOL − PE_VOL)

  // ₹ per 1% underlying move (optional for other views)
  gex_oi: number;              // gex_oi_raw × (Lot × S² × 0.01)
  gex_vol: number;             // gex_vol_raw × (Lot × S² × 0.01)

  ce_oi: number; pe_oi: number; tot_oi: number;
  ce_vol: number; pe_vol: number; tot_vol: number;
  ce_mid: number | null; pe_mid: number | null;
};

export type GexComputed = {
  spot: number;
  lot_size: number;
  move_pct: number;       // 0.01
  scale_used: number;     // Lot × S² × 0.01
  rows: GexOutRow[];
  total_gex_oi_raw: number;
  total_gex_vol_raw: number;
  total_gex_oi: number;
  total_gex_vol: number;
  zero_gamma_oi: number | null;
  zero_gamma_vol: number | null;
};

/* ───────── helpers ───────── */
const num = (x: any): number => {
  if (typeof x === "string") {
    const y = x.replace?.(/[, ]/g, "");
    const n = Number(y);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

function normalizeIV(v: unknown): number {
  const x = Number(v);
  if (!Number.isFinite(x) || x <= 0) return 0;
  return x > 1 ? x / 100 : x; // 12.3 -> 0.123
}

function sigmaFromIVs(ce?: Leg, pe?: Leg): number {
  const ivCE = normalizeIV(ce?.greeks?.implied_volatility);
  const ivPE = normalizeIV(pe?.greeks?.implied_volatility);
  return ivCE && ivPE ? 0.5 * (ivCE + ivPE) : (ivCE || ivPE || 0);
}

function mid(b?: number, a?: number, last?: number): number | null {
  const hasB = Number.isFinite(b);
  const hasA = Number.isFinite(a);
  const hasL = Number.isFinite(last);
  if (hasB && hasA && (a as number) >= (b as number) && (a as number) > 0) return (((b as number) + (a as number)) / 2);
  if (hasL) return last as number;
  if (hasB) return b as number;
  if (hasA) return a as number;
  return null;
}

/** One gamma per strike with vendor↔BS blending.
 *  - Both vendor gammas → average (symmetry).
 *  - Exactly one vendor gamma → blend vendor with BS gamma from IV (default 50/50, tunable via env).
 *  - Neither → BS gamma if possible, else 0.
 */
function strikeGamma(
  S: number, K: number, T: number, r: number, q: number, ce?: Leg, pe?: Leg
): number {
  const gCE = num(ce?.greeks?.gamma);
  const gPE = num(pe?.greeks?.gamma);
  const ceOK = Number.isFinite(gCE) && gCE > 0;
  const peOK = Number.isFinite(gPE) && gPE > 0;

  // Black–Scholes gamma from IVs as a symmetric reference
  const sigma = sigmaFromIVs(ce, pe);
  const gBS = (sigma > 0 && T > 0) ? bsGamma(S, K, T, r, sigma, q) : NaN;
  const bsOK = Number.isFinite(gBS) && (gBS as number) > 0;

  // 1) both present → average
  if (ceOK && peOK) return (gCE + gPE) / 2;

  // 2) exactly one present → blend vendor with BS
  if ((ceOK || peOK) && bsOK) {
    const wRaw = Number(process.env.GEX_VENDOR_GAMMA_WEIGHT ?? "0.5");
    const w = Number.isFinite(wRaw) ? Math.min(1, Math.max(0, wRaw)) : 0.5; // clamp [0,1]
    const gVendor = ceOK ? gCE : gPE;
    return w * gVendor + (1 - w) * (gBS as number);
  }

  // 3) only vendor, no BS
  if (ceOK) return gCE;
  if (peOK) return gPE;

  // 4) vendor missing → BS or 0
  return bsOK ? (gBS as number) : 0;
}

function zeroGammaFromCumulative(rows: { strike: number; val: number }[]): number | null {
  let cum = 0;
  for (let i = 0; i < rows.length; i++) {
    const prev = cum;
    cum += rows[i].val;
    if (i === 0) continue;
    if ((prev < 0) !== (cum < 0)) {
      const aS = rows[i - 1].strike, bS = rows[i].strike;
      const w = Math.abs(prev) / (Math.abs(prev) + Math.abs(cum));
      return aS * (1 - w) + bS * w;
    }
  }
  return null;
}

/* ───────── main ───────── */
export function computeGexFromCachedDoc(
  doc: OCached,
  lotSize: number,
  rAnnual = Number(process.env.RISK_FREE_RATE ?? "0.07"),
  qAnnual = Number(process.env.DIVIDEND_YIELD ?? "0")
): GexComputed {
  const S = num(doc.last_price);
  const T = timeToExpiryYears(doc.expiry, doc.updated_at);
  const r = Math.max(0, rAnnual);
  const q = Math.max(0, qAnnual);

  // Per 1% move scaling
  const MOVE = Number(process.env.GEX_MOVE_PCT ?? "0.01");
  const scale = lotSize * (S ** 2) * MOVE;

  const rows: GexOutRow[] = [];

  for (const row of (doc.strikes || [])) {
    const K = num(row.strike);
    if (!Number.isFinite(K)) continue;

    const ce = row.ce || {};
    const pe = row.pe || {};

    // → unified gamma for this strike
    const G = strikeGamma(S, K, T, r, q, ce, pe);

    // inputs
    const ceOI  = num(ce.oi);
    const peOI  = num(pe.oi);
    const ceVol = num(ce.volume);
    const peVol = num(pe.volume);

    const ceMid = mid(ce.top_bid_price, ce.top_ask_price, ce.last_price);
    const peMid = mid(pe.top_bid_price, pe.top_ask_price, pe.last_price);

    // RAW (dimensionless) — bind these in your table
    const gex_oi_raw  = G * (ceOI  - peOI);
    const gex_vol_raw = G * (ceVol - peVol);

    // ₹ per 1% move (optional)
    const gex_oi  = gex_oi_raw  * scale;
    const gex_vol = gex_vol_raw * scale;

    rows.push({
      strike: K,
      gex_oi_raw,
      gex_vol_raw,
      gex_oi,
      gex_vol,
      ce_oi: ceOI, pe_oi: peOI, tot_oi: ceOI + peOI,
      ce_vol: ceVol, pe_vol: peVol, tot_vol: ceVol + peVol,
      ce_mid: ceMid, pe_mid: peMid,
    });

    // Optional: gated debug for a specific strike (e.g., 25000)
    if (process.env.GEX_DEBUG === "true" && K === 25000) {
      // eslint-disable-next-line no-console
      console.log("[GEX DEBUG 25000]", {
        ceOI, peOI, dOI: ceOI - peOI,
        gCE: num(ce?.greeks?.gamma),
        gPE: num(pe?.greeks?.gamma),
        sigma: sigmaFromIVs(ce, pe),
        G_used: G,
        gex_oi_raw
      });
    }
  }

  rows.sort((a, b) => a.strike - b.strike);

  const total_gex_oi_raw  = rows.reduce((s, r) => s + r.gex_oi_raw, 0);
  const total_gex_vol_raw = rows.reduce((s, r) => s + r.gex_vol_raw, 0);
  const total_gex_oi      = rows.reduce((s, r) => s + r.gex_oi, 0);
  const total_gex_vol     = rows.reduce((s, r) => s + r.gex_vol, 0);

  // zero-gamma on RAW (scale>0 so sign profile identical)
  const zero_gamma_oi  = zeroGammaFromCumulative(rows.map(r => ({ strike: r.strike, val: r.gex_oi_raw })));
  const zero_gamma_vol = zeroGammaFromCumulative(rows.map(r => ({ strike: r.strike, val: r.gex_vol_raw })));

  return {
    spot: S,
    lot_size: lotSize,
    move_pct: MOVE,
    scale_used: scale,
    rows,
    total_gex_oi_raw,
    total_gex_vol_raw,
    total_gex_oi,
    total_gex_vol,
    zero_gamma_oi,
    zero_gamma_vol
  };
}
