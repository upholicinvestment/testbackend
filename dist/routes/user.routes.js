"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const user_controller_1 = require("../controllers/user.controller");
// import { authenticate } from "../middleware/auth.middleware"; // optional
const router = (0, express_1.Router)();
// Public-friendly; add `authenticate` if you want strict auth
router.get("/me", /* authenticate, */ user_controller_1.getProfile);
router.put("/me", /* authenticate, */ user_controller_1.updateProfile);
router.get("/me/products", /* authenticate, */ user_controller_1.getMyProducts);
exports.default = router;
