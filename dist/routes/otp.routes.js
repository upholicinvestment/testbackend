"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// routes/otp.routes.ts
const express_1 = require("express");
const otp_send_controller_1 = require("../controllers/otp_send.controller");
const otp_verify_controller_1 = require("../controllers/otp_verify.controller");
const router = (0, express_1.Router)();
router.post('/send-otp', otp_send_controller_1.sendOtp);
router.post('/verify-otp', otp_verify_controller_1.verifyOtp);
exports.default = router;
