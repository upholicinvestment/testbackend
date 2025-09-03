"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyOtp = void 0;
const otp_send_controller_1 = require("./otp_send.controller");
const cleanPhone = (phone) => phone.replace(/\D/g, '');
const verifyOtp = async (req, res) => {
    try {
        const phone = cleanPhone(req.body.phone || '');
        const inputOtp = parseInt(req.body.otp, 10);
        if (phone.length !== 10 || isNaN(inputOtp)) {
            res.status(400).json({ success: false, message: 'Invalid phone or OTP format.' });
            return;
        }
        const now = Math.floor(Date.now() / 1000);
        const otpData = otp_send_controller_1.otpStore[phone];
        if (!otpData) {
            res.status(404).json({ success: false, message: 'No OTP request found for this number.' });
            return;
        }
        if (otpData.expiresAt < now) {
            res.status(410).json({ success: false, message: 'OTP expired. Please request a new one.' });
            delete otp_send_controller_1.otpStore[phone];
            return;
        }
        if (otpData.attempts >= 3) {
            res.status(429).json({ success: false, message: 'Maximum verification attempts exceeded.' });
            return;
        }
        if (otpData.verified) {
            res.status(200).json({ success: true, message: 'OTP already verified.' });
            return;
        }
        otpData.attempts++;
        if (otpData.otp === inputOtp) {
            otpData.verified = true;
            res.status(200).json({ success: true, message: 'OTP verified successfully.' });
        }
        else {
            res.status(401).json({ success: false, message: 'Incorrect OTP. Please try again.' });
        }
    }
    catch (error) {
        res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
    }
};
exports.verifyOtp = verifyOtp;
