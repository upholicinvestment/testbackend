//server/src/data.routes.ts 
import { Router } from 'express';
import { getData, getLatestData, createData } from '../controllers/data.controller';
// import { authenticate } from '../middleware/auth.middleware'; // Commented out for now

const router = Router();

// Public routes (no authentication needed)
router.get('/public', getData);
// router.get('/public/latest', getLatestData);

// Make all data routes public temporarily by removing authenticate middleware
// router.get('/', getData); // Removed: authenticate
// router.post('/', createData); // Removed: authenticate

export default router;