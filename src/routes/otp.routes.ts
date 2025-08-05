// routes/otp.routes.ts
import { Router } from 'express';
import { sendOtp } from '../controllers/otp_send.controller';
import { verifyOtp } from '../controllers/otp_verify.controller';

const router = Router();

router.post('/send-otp', sendOtp);
router.post('/verify-otp', verifyOtp);

export default router;
