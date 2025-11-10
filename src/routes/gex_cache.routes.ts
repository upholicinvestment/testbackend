// src/routes/gex_cache.routes.ts
import { Router } from "express";
import {
  getNiftyGexFromCache,
  getNiftyTicksToday,
  listNiftyCacheExpiries,
  optionChainDebugSummary,
  getNiftyGexVolSeries,
} from "../controllers/gex_cache.controller";

const r = Router();

/**
 * Compatibility routes:
 * - keep the old `/gex/nifty/cache` path for callers that still use it
 * - support the shorter `/gex/nifty` path for new clients
 */
r.get("/gex/nifty", getNiftyGexFromCache);
r.get("/gex/nifty/cache", getNiftyGexFromCache);

r.get("/gex/nifty/ticks", getNiftyTicksToday);

/**
 * expiries endpoint (keeps historical compatibility)
 * and a debug summary
 */
r.get("/gex/nifty/cache/expiries", listNiftyCacheExpiries);
r.get("/gex/cache/debug", optionChainDebugSummary);

// 🔹 NIFTY GEX volume/oi time series (PUBLIC)
r.get("/gex/nifty/vol_series", getNiftyGexVolSeries);

export default r;
