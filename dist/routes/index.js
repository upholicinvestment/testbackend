"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/index.ts
const express_1 = require("express");
const auth_routes_1 = __importDefault(require("./auth.routes"));
const user_routes_1 = __importDefault(require("./user.routes"));
const data_routes_1 = __importDefault(require("./data.routes"));
const otp_routes_1 = __importDefault(require("./otp.routes"));
const router = (0, express_1.Router)();
/** Explicitly typed handlers avoid the Application overload */
const healthHandler = (_req, res) => {
    res.json({ ok: true });
};
const registerIntentGetGuard = (_req, res) => {
    res.status(405).send("Use POST /api/auth/register-intent");
};
/** Health check */
router.get("/health", healthHandler);
/** Guard for accidental GET (optional; you can delete this route entirely) */
router.get("/auth/register-intent", registerIntentGetGuard);
/** Public routes */
router.use("/auth", auth_routes_1.default);
router.use("/users", user_routes_1.default);
router.use("/data", data_routes_1.default);
router.use("/otp", otp_routes_1.default);
exports.default = router;
