"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authorize = exports.authenticate = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const user_model_1 = require("../models/user.model");
const authenticate = async (req, res, next) => {
    if (process.env.PUBLIC_MODE === "true") {
        next();
        return;
    }
    let token;
    if (req.headers.authorization?.startsWith("Bearer ")) {
        token = req.headers.authorization.split(" ")[1];
    }
    if (!token) {
        res.status(401).json({ message: "Not authorized, no token provided" });
        return;
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        const user = await user_model_1.User.findById(decoded.id).select("-password");
        if (!user) {
            res.status(401).json({ message: "No user found with this token" });
            return;
        }
        req.user = { id: user._id.toString(), role: user.role };
        next();
    }
    catch (err) {
        console.error("Authentication error:", err);
        res.status(401).json({ message: "Not authorized, token failed" });
    }
};
exports.authenticate = authenticate;
const authorize = (...roles) => (req, res, next) => {
    if (process.env.PUBLIC_MODE === "true") {
        next();
        return;
    }
    if (!req.user || !roles.includes(req.user.role)) {
        res.status(403).json({ message: "Not authorized to access this route" });
        return;
    }
    next();
};
exports.authorize = authorize;
