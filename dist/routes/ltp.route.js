"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ltpRoutes = void 0;
const express_1 = require("express");
const ltp_service_1 = require("../services/ltp.service");
const ltpRoutes = (0, express_1.Router)();
exports.ltpRoutes = ltpRoutes;
/**
 * GET /api/ltp/recent
 * Fetch the most recent LTP data.
 */
ltpRoutes.get("/recent", async (req, res) => {
    try {
        const ltpData = await (0, ltp_service_1.getRecentLTPs)();
        if (!ltpData.length) {
            res.status(404).json({ message: "No LTP data found" });
            return;
        }
        res.json(ltpData);
    }
    catch (err) {
        console.error("❌ Error fetching LTP data:", err);
        res.status(500).json({ message: "Failed to fetch LTP data" });
    }
});
