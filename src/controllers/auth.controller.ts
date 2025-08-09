// server/src/controllers/auth.controller.ts
import { Request, Response, RequestHandler } from "express";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { Db, ObjectId } from "mongodb";

// ===== Database wiring =====
let db: Db;
export const setDatabase = (database: Db) => {
  db = database;
};

// ===== JWT =====
const generateToken = (userId: string) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not defined in .env");
  return jwt.sign({ id: userId }, secret, { expiresIn: "30d" });
};

// ===== Env / Utils =====
const IS_DEV = process.env.NODE_ENV !== "production";
const FORCE_LOG_OTP = process.env.SMS_DEBUG_FORCE_LOG === "true";

// Normalize Indian numbers to 91XXXXXXXXXX
function normalizePhone(raw: string) {
  if (!raw) return raw;
  let p = raw.replace(/\D/g, "");
  if (p.startsWith("91") && p.length === 12) return p;
  if (p.length === 10) return `91${p}`;
  return p;
}

// ===== SMS (SMSGatewayHub) =====
// Uses Node 18+ global fetch (no node-fetch needed)
async function sendOtpSMS(phone: string, otp: string) {
  const API_KEY = process.env.SMS_API_KEY;
  const SENDER_ID = process.env.SMS_SENDER_ID || "UPOHTC"; // exactly 6 chars
  const ROUTE_ID = process.env.SMS_ROUTE_ID || "1"; // you use 1
  const number = normalizePhone(phone);

  const text = `Dear Customer, your OTP for free call demo is ${otp}. Please use this to complete your registration. Do not share this OTP with anyone. - UpholicTech`;

  if (!API_KEY) {
    console.warn("[SMS] SMS_API_KEY missing. Skipping provider call.");
    console.log(`[DEV SMS] ${number}: ${text}`);
    return;
  }
  if (IS_DEV || FORCE_LOG_OTP) {
    console.log(`[DEV SMS] ${number}: ${text}`);
  }

  try {
    const qs = new URLSearchParams({
      APIKey: API_KEY,
      senderid: SENDER_ID,
      channel: "2", // transactional
      DCS: "0",
      flashsms: "0",
      number,
      text, // URLSearchParams handles encoding
      route: ROUTE_ID,
    });

    const url = `https://www.smsgatewayhub.com/api/mt/SendSMS?${qs.toString()}`;
    const resp = await fetch(url, { method: "GET" });
    const body = await resp.text();
    console.log("[SMS Response]", resp.status, body);

    if (!resp.ok) {
      console.error("[SMS ERROR] Non-200 status returned by provider.");
    }
  } catch (e) {
    console.error("[SMS ERROR] Exception:", e);
  }
}

// Optional email channel (stub)
async function sendOtpEmail(email: string, otp: string) {
  const text = `Your password reset OTP is ${otp}. It expires in 10 minutes.`;
  if (IS_DEV || FORCE_LOG_OTP) {
    console.log(`[DEV EMAIL] ${email}: ${text}`);
  }
  // TODO: integrate email provider if you want email delivery
}

// ======================================================================
// =============== SIGNUP INTENT FLOW (no user created yet) =============
// ======================================================================

/**
 * POST /api/auth/register-intent
 * body: {
 *  name, email, password, phone,
 *  initialProductId?, initialVariantId?, brokerConfig?
 * }
 * returns: { signupIntentId }
 */
export const registerIntent = async (req: Request, res: Response) => {
  try {
    const {
      name,
      email,
      password,
      phone,
      initialProductId,
      initialVariantId,
      brokerConfig,
    } = req.body as {
      name: string;
      email: string;
      password: string;
      phone: string;
      initialProductId?: string;
      initialVariantId?: string;
      brokerConfig?: Record<string, string>;
    };

    if (!name || !email || !password || !phone) {
      res.status(400).json({ message: "All fields are required" });
      return;
    }

    // Ensure user does not already exist
    const existingUser = await db.collection("users").findOne({
      $or: [{ email }, { phone }],
    });
    if (existingUser) {
      res
        .status(400)
        .json({ message: "User already exists with this email or phone" });
      return;
    }

    // Validate product/variant if provided (optional)
    let productId: ObjectId | null = null;
    let variantId: ObjectId | null = null;

    if (initialProductId) {
      const product = await db.collection("products").findOne({
        _id: new ObjectId(initialProductId),
        isActive: true,
      });

      if (!product) {
        res
          .status(400)
          .json({ message: "Selected product not found or inactive" });
        return;
      }

      productId = product._id as ObjectId;

      if ((product as any).hasVariants) {
        if (!initialVariantId) {
          res
            .status(400)
            .json({ message: "Please select a plan for the chosen product." });
          return;
        }

        const variant = await db.collection("product_variants").findOne({
          _id: new ObjectId(initialVariantId),
          productId,
          isActive: true,
        });

        if (!variant) {
          res
            .status(400)
            .json({ message: "Selected plan is invalid or inactive." });
          return;
        }

        variantId = (variant as any)._id as ObjectId;
      }
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Create signup intent (no user yet)
    const intent = await db.collection("signup_intents").insertOne({
      name,
      email,
      phone,
      passwordHash,
      productId,
      variantId,
      brokerConfig: brokerConfig || null,
      status: "created", // created | completed | cancelled | expired
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    res.status(201).json({ signupIntentId: intent.insertedId });
  } catch (err) {
    console.error("registerIntent error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * POST /api/auth/finalize-signup
 * body: { signupIntentId }
 * Creates user (and user_products if product exists) for FREE/NO-PAYMENT flows.
 * For paid flows, the user is created in /payments/verify after signature check.
 */
export const finalizeSignup = async (req: Request, res: Response) => {
  try {
    const { signupIntentId } = req.body as { signupIntentId: string };
    if (!signupIntentId) {
      res.status(400).json({ message: "signupIntentId is required" });
      return;
    }

    const intent = await db.collection("signup_intents").findOne({
      _id: new ObjectId(signupIntentId),
    });
    if (!intent) {
      res.status(404).json({ message: "Signup intent not found" });
      return;
    }
    if ((intent as any).status !== "created") {
      res
        .status(400)
        .json({ message: "Signup intent is not in a finalizable state" });
      return;
    }

    // Double-check duplicates
    const dup = await db.collection("users").findOne({
      $or: [{ email: (intent as any).email }, { phone: (intent as any).phone }],
    });
    if (dup) {
      res.status(400).json({ message: "User already exists" });
      return;
    }

    // Create user
    const userIns = await db.collection("users").insertOne({
      name: (intent as any).name,
      email: (intent as any).email,
      phone: (intent as any).phone,
      password: (intent as any).passwordHash,
      role: "customer",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // If product selected, attach as active (free/no-payment case)
    if ((intent as any).productId) {
      await db.collection("user_products").insertOne({
        userId: userIns.insertedId,
        productId: (intent as any).productId,
        variantId: (intent as any).variantId || null,
        status: "active",
        startedAt: new Date(),
        endsAt: null,
        meta: { source: "signup_free", interval: "monthly" },
      });

      // Broker config if ALGO and present
      const product = await db
        .collection("products")
        .findOne({ _id: (intent as any).productId });
      if (
        (product as any)?.key === "algo_simulator" &&
        (intent as any).variantId &&
        (intent as any).brokerConfig
      ) {
        await db.collection("broker_configs").insertOne({
          userId: userIns.insertedId,
          productId: (intent as any).productId,
          variantId: (intent as any).variantId,
          brokerName: (intent as any).brokerConfig?.brokerName,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...((intent as any).brokerConfig || {}),
        });
      }
    }

    // Mark intent complete
    await db.collection("signup_intents").updateOne(
      { _id: new ObjectId(signupIntentId) },
      {
        $set: {
          status: "completed",
          userId: userIns.insertedId,
          updatedAt: new Date(),
        },
      }
    );

    const token = generateToken(userIns.insertedId.toString());
    res.json({
      token,
      user: {
        id: userIns.insertedId,
        name: (intent as any).name,
        email: (intent as any).email,
        phone: (intent as any).phone,
      },
    });
  } catch (err) {
    console.error("finalizeSignup error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ======================================================================
// ============================== LOGIN =================================
// ======================================================================

export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body as {
      email: string;
      password: string;
    };

    const user = await db.collection("users").findOne({ email });
    if (!user || !(await bcrypt.compare(password, (user as any).password))) {
      res.status(400).json({ message: "Invalid credentials" });
      return;
    }

    const token = generateToken((user as any)._id.toString());

    console.log(
      "[auth.login] JWT issued for user",
      (user as any)._id.toString(),
      token
    );

    res.status(200).json({
      token,
      user: {
        id: (user as any)._id,
        name: (user as any).name,
        email: (user as any).email,
        phone: (user as any).phone,
      },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ======================================================================
// ========================= FORGOT / RESET OTP =========================
// ======================================================================

/**
 * POST /api/auth/forgot-password
 * body: { emailOrPhone: string }
 * returns: { resetId, message }
 */
export const forgotPassword = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { emailOrPhone } = req.body as { emailOrPhone: string };
    if (!emailOrPhone) {
      res.status(400).json({ message: "emailOrPhone is required" });
      return;
    }

    const user = await db.collection("users").findOne({
      $or: [{ email: emailOrPhone }, { phone: emailOrPhone }],
    });

    // Always 200 to avoid user enumeration
    if (!user) {
      res
        .status(200)
        .json({ message: "If the account exists, an OTP has been sent." });
      return;
    }

    // Create a 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otpHash = await bcrypt.hash(otp, 10);

    // Invalidate older resets for this user
    await db.collection("password_resets").updateMany(
      { userId: (user as any)._id, used: { $ne: true } },
      { $set: { used: true, invalidatedAt: new Date() } }
    );

    // Store reset request. In dev, also store otpPlain to simplify testing.
    const resetInsert = await db.collection("password_resets").insertOne({
      userId: (user as any)._id,
      otpHash,
      otpPlain: IS_DEV ? otp : undefined, // DEV ONLY, never in prod
      channel: (user as any).phone ? "sms" : "email",
      attempts: 0,
      used: false,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
    });

    if ((user as any).phone) {
      await sendOtpSMS((user as any).phone, otp);
    } else {
      await sendOtpEmail((user as any).email, otp);
    }

    res.status(200).json({
      resetId: resetInsert.insertedId,
      message: "If the account exists, an OTP has been sent.",
    });
  } catch (err) {
    console.error("forgotPassword error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * POST /api/auth/reset-password
 * body: { resetId: string, otp: string, newPassword: string }
 */
export const resetPassword = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { resetId, otp, newPassword } = req.body as {
      resetId: string;
      otp: string;
      newPassword: string;
    };

    if (!resetId || !otp || !newPassword) {
      res
        .status(400)
        .json({ message: "resetId, otp and newPassword are required" });
      return;
    }

    const resetDoc = await db
      .collection("password_resets")
      .findOne({ _id: new ObjectId(resetId) });
    if (!resetDoc) {
      res.status(400).json({ message: "Invalid or expired reset request" });
      return;
    }

    if ((resetDoc as any).used) {
      res.status(400).json({ message: "This reset request is already used" });
      return;
    }

    if (new Date((resetDoc as any).expiresAt).getTime() < Date.now()) {
      res.status(400).json({ message: "OTP expired" });
      return;
    }

    // Limit attempts
    if ((resetDoc as any).attempts >= 5) {
      res.status(400).json({ message: "Too many attempts, request a new OTP" });
      return;
    }

    const isMatch = await bcrypt.compare(otp, (resetDoc as any).otpHash);
    if (!isMatch) {
      await db.collection("password_resets").updateOne(
        { _id: (resetDoc as any)._id },
        { $inc: { attempts: 1 }, $set: { lastAttemptAt: new Date() } }
      );
      res.status(400).json({ message: "Invalid OTP" });
      return;
    }

    // Update user password
    const hashed = await bcrypt.hash(newPassword, 10);
    await db.collection("users").updateOne(
      { _id: (resetDoc as any).userId },
      { $set: { password: hashed, updatedAt: new Date() } }
    );

    // Mark reset as used
    await db.collection("password_resets").updateOne(
      { _id: (resetDoc as any)._id },
      { $set: { used: true, usedAt: new Date() } }
    );

    res
      .status(200)
      .json({ message: "Password updated successfully. You can now log in." });
  } catch (err) {
    console.error("resetPassword error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// ===== DEV ONLY: fetch last OTP for a user (so you can test without SMS) =====
export const devGetLastOtp: RequestHandler = async (
  req: Request,
  res: Response
) => {
  if (process.env.NODE_ENV === "production") {
    res.status(403).json({ message: "Not available in production" });
    return;
  }

  const emailOrPhone = (req.query.emailOrPhone as string) || "";
  if (!emailOrPhone) {
    res.status(400).json({ message: "emailOrPhone is required" });
    return;
  }

  const user = await db.collection("users").findOne(
    { $or: [{ email: emailOrPhone }, { phone: emailOrPhone }] },
    { projection: { _id: 1 } }
  );

  if (!user) {
    res.status(404).json({ message: "User not found" });
    return;
  }

  const pr = await db
    .collection("password_resets")
    .find({ userId: (user as any)._id })
    .sort({ createdAt: -1 })
    .limit(1)
    .toArray();

  if (!pr.length) {
    res.status(404).json({ message: "No reset record found" });
    return;
  }

  const last = pr[0] as any;
  res.json({
    resetId: last._id,
    otpPlain: last.otpPlain || "(not stored)",
    expiresAt: last.expiresAt,
    used: !!last.used,
    attempts: last.attempts || 0,
  });
};
