"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const data_controller_1 = require("../controllers/data.controller");
// import { authenticate } from '../middleware/auth.middleware'; // Commented out for now
const router = (0, express_1.Router)();
// Public routes (no authentication needed)
router.get('/public', data_controller_1.getData);
// router.get('/public/latest', getLatestData);
// Make all data routes public temporarily by removing authenticate middleware
// router.get('/', getData); // Removed: authenticate
// router.post('/', createData); // Removed: authenticate
exports.default = router;
