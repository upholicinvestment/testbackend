// server/src/routes/gex_cache.routes.ts
import { Router } from "express";
import {
  getNiftyGexFromCache,
  listNiftyCacheExpiries,
  optionChainDebugSummary,
  getNiftyTicksToday,
  getNiftyGexBulk, // <-- added
} from "../controllers/gex_cache.controller";

const r = Router();

r.get("/gex/nifty/cache", getNiftyGexFromCache);
r.get("/gex/nifty/cache/expiries", listNiftyCacheExpiries);
r.get("/gex/cache/debug", optionChainDebugSummary);
r.get("/gex/nifty/ticks", getNiftyTicksToday);
r.get("/gex/nifty/bulk", getNiftyGexBulk); // <-- added

export default r;
