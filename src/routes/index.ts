import { Router } from 'express';
import authRoutes from './auth.routes';
import userRoutes from './user.routes';
import dataRoutes from './data.routes';
import otpRoutes from './otp.routes';

const router = Router();

// All routes will be accessible without authentication
router.use('/auth', authRoutes); // Note: Login/register won't be needed
router.use('/users', userRoutes); // Now public
router.use('/data', dataRoutes); // Now public
router.use('/otp', otpRoutes);

export default router;