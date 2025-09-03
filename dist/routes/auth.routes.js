"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_controller_1 = require("../controllers/auth.controller");
const router = (0, express_1.Router)();
/**
 * Helpful guard: if something accidentally does a GET to this path,
 * respond with 405 to make the mistake obvious in the browser.
 */
router.get("/register-intent", (_req, res) => {
    res.status(405).send("Use POST /api/auth/register-intent");
});
router.post("/register-intent", auth_controller_1.registerIntent);
router.post("/finalize-signup", auth_controller_1.finalizeSignup);
router.post("/login", auth_controller_1.login);
router.post("/forgot-password", auth_controller_1.forgotPassword);
router.post("/reset-password", auth_controller_1.resetPassword);
if (process.env.NODE_ENV !== "production") {
    router.get("/dev/last-otp", auth_controller_1.devGetLastOtp);
}
exports.default = router;
