import { Router } from "express";
import { getProfile, updateProfile, getMyProducts } from "../controllers/user.controller";
// import { authenticate } from "../middleware/auth.middleware"; // optional

const router = Router();

// Public-friendly; add `authenticate` if you want strict auth
router.get("/me", /* authenticate, */ getProfile);
router.put("/me", /* authenticate, */ updateProfile);
router.get("/me/products", /* authenticate, */ getMyProducts);

export default router;
