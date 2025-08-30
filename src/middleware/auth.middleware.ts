// server/src/middleware/auth.middleware.ts
import { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { User } from "../models/user.model";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role: string;
      };
    }
  }
}

export const authenticate: RequestHandler = async (req, res, next): Promise<void> => {
  if (process.env.PUBLIC_MODE === "true") {
    next();
    return;
  }

  let token: string | undefined;
  if (req.headers.authorization?.startsWith("Bearer ")) {
    token = req.headers.authorization.split(" ")[1];
  }

  if (!token) {
    res.status(401).json({ message: "Not authorized, no token provided" });
    return;
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { id: string };
    const user = await User.findById(decoded.id).select("-password");

    if (!user) {
      res.status(401).json({ message: "No user found with this token" });
      return;
    }

    req.user = { id: user._id.toString(), role: user.role };
    next();
  } catch (err) {
    console.error("Authentication error:", err);
    res.status(401).json({ message: "Not authorized, token failed" });
  }
};

export const authorize =
  (...roles: string[]): RequestHandler =>
  (req, res, next): void => {
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
