// src/api/futstk_ohlc.api.ts
import type { Express, RequestHandler } from "express";
import {
  fetchAndSaveFutstkOhlc,
  refreshAndUpsertFutstkOhlc,
  fetchOhlc,
} from "../services/quote.service";

export default function registerFutstkOhlcRoutes(app: Express, fnoDb: unknown) {
  /**
   * INSERT endpoint (one-shot):
   * GET /api/futstk/ohlc?expiry=2025-10-28
   * Also accepts: 28-10-2025 or 28-10-2025 14:30:00
   * Writes NEW rows to `nse_futstk_ohlc` (no upsert) and appends ticks to `nse_futstk_ticks`.
   */
  const insertHandler: RequestHandler = async (req, res) => {
    const expiryParam = req.query.expiry;
    const forceZeroParam = String(req.query.forceZero || "").toLowerCase();
    const forceZero = forceZeroParam === "true";

    if (!expiryParam || typeof expiryParam !== "string" || !expiryParam.trim()) {
      res.status(400).json({
        error: "Query param 'expiry' is required. Example: /api/futstk/ohlc?expiry=2025-10-28",
      });
      return;
    }

    try {
      const summary = await fetchAndSaveFutstkOhlc(expiryParam, forceZero);
      res.json({ expiry: expiryParam, forceZero, ...summary });
    } catch (err: any) {
      console.error("FUTSTK OHLC (insert) route error:", err?.message || err);
      res.status(500).json({ error: "Internal server error" });
    }
  };

  /**
   * REFRESH/UPSERT endpoint (recommended):
   * GET /api/futstk/ohlc/refresh?expiry=2025-10-28&forceZero=false
   * - Upserts in place on {security_id, expiry_date}
   * - Keeps a single doc per contract+expiry and updates its fields
   * - Appends the same snapshot as a tick in `nse_futstk_ticks`
   */
  const refreshHandler: RequestHandler = async (req, res) => {
    const expiryParam = req.query.expiry;
    const forceZeroParam = String(req.query.forceZero || "").toLowerCase();
    const forceZero = forceZeroParam === "true";

    if (!expiryParam || typeof expiryParam !== "string" || !expiryParam.trim()) {
      res.status(400).json({
        error:
          "Query param 'expiry' is required. Example: /api/futstk/ohlc/refresh?expiry=2025-10-28",
      });
      return;
    }

    try {
      const summary = await refreshAndUpsertFutstkOhlc(expiryParam, forceZero);
      res.json({ expiry: expiryParam, forceZero, ...summary });
    } catch (err: any) {
      console.error("FUTSTK OHLC (refresh) route error:", err?.message || err);
      res.status(500).json({ error: "Internal server error" });
    }
  };

  /**
   * Debug single SID quickly:
   * GET /api/futstk/ohlc/debug?sid=52509
   */
  const debugHandler: RequestHandler = async (req, res) => {
    const sidParam = req.query.sid;
    const sid = Number(sidParam);
    if (!sid || !Number.isFinite(sid)) {
      res.status(400).json({ error: "Pass a numeric sid, e.g. /api/futstk/ohlc/debug?sid=52509" });
      return;
    }
    try {
      const data = await fetchOhlc([sid]);
      res.json({
        sid,
        hasData: !!data && Object.keys(data).length > 0,
        data: (data as any)?.[sid] ?? null,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || String(err) });
    }
  };

  app.get("/api/futstk/ohlc", insertHandler);          // one-shot insert (legacy + ticks)
  app.get("/api/futstk/ohlc/refresh", refreshHandler); // upsert/refresh (+ ticks)
  app.get("/api/futstk/ohlc/debug", debugHandler);
}
