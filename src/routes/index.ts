// src/routes/index.ts
import { Router, type RequestHandler } from "express";
import authRoutes from "./auth.routes";
import userRoutes from "./user.routes";
import dataRoutes from "./data.routes";
import otpRoutes from "./otp.routes";

const router = Router();

/** Explicitly typed handlers avoid the Application overload */
const healthHandler: RequestHandler = (_req, res) => {
  res.json({ ok: true });
};

const registerIntentGetGuard: RequestHandler = (_req, res) => {
  res.status(405).send("Use POST /api/auth/register-intent");
};

/** Health check */
router.get("/health", healthHandler);

/** Guard for accidental GET (optional; you can delete this route entirely) */
router.get("/auth/register-intent", registerIntentGetGuard);

/** Public routes */
router.use("/auth", authRoutes);
router.use("/users", userRoutes);
router.use("/data", dataRoutes);
router.use("/otp", otpRoutes);

export default router;