// Black–Scholes gamma (per underlying unit) with continuous compounding.
// If you don't use dividend yield, just pass q = 0.
export function bsGamma(
  S: number, K: number, T: number, r: number, sigma: number, q = 0
): number {
  if (S <= 0 || K <= 0 || sigma <= 0 || T <= 0) return 0;

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);

  // standard normal PDF
  const phi = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

  // gamma is same for calls & puts
  return (Math.exp(-q * T) * phi(d1)) / (S * sigma * sqrtT);
}
