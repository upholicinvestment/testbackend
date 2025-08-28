// server/src/controllers/payment.controller.ts
import { Request, Response, RequestHandler } from "express";
import crypto from "crypto";
import { Db, ObjectId } from "mongodb";
import jwt from "jsonwebtoken";
import { razorpay } from "../services/razorpay.service";

let db: Db;
export const setPaymentDatabase = (database: Db) => {
  db = database;
};

const BUNDLE_SKU_KEY = "essentials_bundle";
const ALGO_SKU_KEY = "algo_simulator";
const JOURNALING_SOLO_SKU_KEY = "journaling_solo";

const generateToken = (userId: string) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not defined in .env");
  return jwt.sign({ id: userId }, secret, { expiresIn: "30d" });
};

async function getBundleComponentsSet(): Promise<Set<string>> {
  const bundle = await db
    .collection("products")
    .findOne({ key: BUNDLE_SKU_KEY, isActive: true });
  const comps = Array.isArray((bundle as any)?.components)
    ? ((bundle as any).components as string[])
    : [
        "technical_scanner",
        "fundamental_scanner",
        "fno_khazana",
        "journaling",
        "fii_dii_data",
      ];
  return new Set(comps);
}

/**
 * POST /api/payments/create-order
 * body: { signupIntentId }
 * - For bundle: uses product.priceMonthly or .env fallback
 * - For ALGO: requires variant (priceMonthly from variant)
 * - For Journaling Solo: uses product.priceMonthly
 */
export const createOrder: RequestHandler = async (
  req: Request,
  res: Response
) => {
  try {
    const { signupIntentId } = req.body as { signupIntentId: string };
    if (!signupIntentId) {
      res.status(400).json({ message: "signupIntentId is required" });
      return;
    }

    const intent = await db
      .collection("signup_intents")
      .findOne({ _id: new ObjectId(signupIntentId) });
    if (!intent) {
      res.status(404).json({ message: "Signup intent not found" });
      return;
    }
    if ((intent as any).status !== "created") {
      res.status(400).json({ message: "Signup intent not in a payable state" });
      return;
    }
    if (!(intent as any).productId) {
      res.status(400).json({ message: "No product selected for payment" });
      return;
    }

    const product = await db
      .collection("products")
      .findOne({ _id: (intent as any).productId, isActive: true });
    if (!product) {
      res.status(400).json({ message: "Invalid product" });
      return;
    }

    const productKey = (product as any).key as string;

    let amountPaise = 0;
    let displayName = (product as any).name;

    if (productKey === BUNDLE_SKU_KEY) {
      // ► Bundle (single price)
      const bundlePriceFromDb = Number((product as any).priceMonthly);
      const bundlePriceEnv = Number(process.env.BUNDLE_MONTHLY_PRICE || 4999);
      const bundlePrice =
        Number.isFinite(bundlePriceFromDb) && bundlePriceFromDb > 0
          ? bundlePriceFromDb
          : bundlePriceEnv;

      amountPaise = Math.round(bundlePrice * 100);
      displayName = "Trader Essentials Bundle (5-in-1)";
    } else if (productKey === ALGO_SKU_KEY) {
      // ► ALGO requires variant
      const variantId = (intent as any).variantId;
      if (!variantId) {
        res
          .status(400)
          .json({ message: "variantId required for this product" });
        return;
      }
      const variant = await db.collection("product_variants").findOne({
        _id: variantId,
        productId: (product as any)._id,
        isActive: true,
      });
      if (!variant) {
        res.status(400).json({ message: "Invalid or inactive variant" });
        return;
      }
      const priceMonthly = (variant as any).priceMonthly;
      if (!priceMonthly || typeof priceMonthly !== "number") {
        // Free variant possibility → no order; finalize signup directly on client
        res.status(204).send();
        return;
      }
      amountPaise = Math.round(priceMonthly * 100);
      displayName = `${(product as any).name} - ${(variant as any).name}`;
    } else if (productKey === JOURNALING_SOLO_SKU_KEY) {
      // ► Journaling Solo (flat monthly price from DB)
      const priceMonthly = Number((product as any).priceMonthly);
      if (!priceMonthly || !Number.isFinite(priceMonthly)) {
        res
          .status(400)
          .json({ message: "Invalid price for Journaling (Solo)" });
        return;
      }
      amountPaise = Math.round(priceMonthly * 100);
      displayName = (product as any).name; // "Journaling (Solo)"
    } else {
      // Not purchasable (components should never reach here)
      res.status(400).json({ message: "This product is not purchasable" });
      return;
    }

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: process.env.CURRENCY || "INR",
      receipt: `rcpt_${Date.now()}`,
      notes: { signupIntentId },
    });

    const paymentIntent = await db.collection("payment_intents").insertOne({
      signupIntentId: new ObjectId(signupIntentId),
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      status: "created",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.RAZORPAY_KEY_ID,
      name: "UpholicTech",
      description: displayName,
      intentId: paymentIntent.insertedId,
      user: {
        name: (intent as any).name,
        email: (intent as any).email,
        contact: (intent as any).phone,
      },
    });
  } catch (err) {
    console.error("createOrder error:", err);
    res.status(500).json({ message: "Failed to create order" });
  }
};

/**
 * POST /api/payments/verify
 * body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, intentId }
 * On success:
 *  - ensures user exists (creates if needed)
 *  - grants entitlements based on product
 *  - marks signup/payment intents
 *  - returns token + user
 */
export const verifyPayment: RequestHandler = async (
  req: Request,
  res: Response
) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      intentId,
    } = req.body as {
      razorpay_order_id: string;
      razorpay_payment_id: string;
      razorpay_signature: string;
      intentId: string;
    };

    if (
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature ||
      !intentId
    ) {
      res.status(400).json({ message: "Missing payment verification fields" });
      return;
    }

    const pIntent = await db
      .collection("payment_intents")
      .findOne({ _id: new ObjectId(intentId) });
    if (!pIntent) {
      res.status(404).json({ message: "Payment intent not found" });
      return;
    }

    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET as string)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expected !== razorpay_signature) {
      await db.collection("payment_intents").updateOne(
        { _id: new ObjectId(intentId) },
        {
          $set: {
            status: "failed",
            updatedAt: new Date(),
            razorpay_order_id,
            razorpay_payment_id,
            razorpay_signature,
          },
        }
      );
      res.status(400).json({ message: "Invalid signature" });
      return;
    }

    const sIntent = await db
      .collection("signup_intents")
      .findOne({ _id: (pIntent as any).signupIntentId });
    if (!sIntent) {
      res.status(404).json({ message: "Signup intent not found" });
      return;
    }
    if ((sIntent as any).status !== "created") {
      res.status(400).json({ message: "Signup intent already finalized" });
      return;
    }

    // Ensure user exists (or create)
    const existing = await db.collection("users").findOne({
      $or: [
        { email: (sIntent as any).email },
        { phone: (sIntent as any).phone },
      ],
    });
    let userId: ObjectId;
    if (existing) {
      userId = (existing as any)._id;
    } else {
      const userIns = await db.collection("users").insertOne({
        name: (sIntent as any).name,
        email: (sIntent as any).email,
        phone: (sIntent as any).phone,
        password: (sIntent as any).passwordHash,
        role: "customer",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      userId = userIns.insertedId;
    }

    // Determine purchased SKU
    const sProduct = await db
      .collection("products")
      .findOne({ _id: (sIntent as any).productId });
    const sProductKey = (sProduct as any)?.key as string | undefined;

    if (sProductKey === BUNDLE_SKU_KEY) {
      // ► Grant ALL bundle components
      const componentKeys = Array.from(await getBundleComponentsSet());
      const bundleProducts = await db
        .collection("products")
        .find({ key: { $in: componentKeys }, isActive: true })
        .toArray();

      for (const bp of bundleProducts) {
        await db.collection("user_products").updateOne(
          { userId, productId: (bp as any)._id, variantId: null },
          {
            $setOnInsert: {
              startedAt: new Date(),
              meta: { source: "payment_bundle", interval: "monthly" },
            },
            $set: {
              status: "active",
              endsAt: null,
              lastPaymentAt: new Date(),
              paymentMeta: {
                provider: "razorpay",
                orderId: razorpay_order_id,
                paymentId: razorpay_payment_id,
                amount: (pIntent as any).amount,
                currency: (pIntent as any).currency,
              },
            },
          },
          { upsert: true }
        );
      }
    } else if (sProductKey === ALGO_SKU_KEY) {
      // ► Grant ALGO (+ broker config if present)
      await db.collection("user_products").updateOne(
        {
          userId,
          productId: (sIntent as any).productId,
          variantId: (sIntent as any).variantId || null,
        },
        {
          $setOnInsert: {
            startedAt: new Date(),
            meta: { source: "payment", interval: "monthly" },
          },
          $set: {
            status: "active",
            endsAt: null,
            lastPaymentAt: new Date(),
            paymentMeta: {
              provider: "razorpay",
              orderId: razorpay_order_id,
              paymentId: razorpay_payment_id,
              amount: (pIntent as any).amount,
              currency: (pIntent as any).currency,
            },
          },
        },
        { upsert: true }
      );

      if ((sIntent as any).variantId && (sIntent as any).brokerConfig) {
        await db.collection("broker_configs").insertOne({
          userId,
          productId: (sIntent as any).productId,
          variantId: (sIntent as any).variantId,
          brokerName: (sIntent as any).brokerConfig?.brokerName,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...((sIntent as any).brokerConfig || {}),
        });
      }
    } else if (sProductKey === JOURNALING_SOLO_SKU_KEY) {
      // ► Grant Journaling (Solo)
      await db.collection("user_products").updateOne(
        {
          userId,
          productId: (sIntent as any).productId,
          variantId: null,
        },
        {
          $setOnInsert: {
            startedAt: new Date(),
            meta: { source: "payment", interval: "monthly" },
          },
          $set: {
            status: "active",
            endsAt: null,
            lastPaymentAt: new Date(),
            paymentMeta: {
              provider: "razorpay",
              orderId: razorpay_order_id,
              paymentId: razorpay_payment_id,
              amount: (pIntent as any).amount,
              currency: (pIntent as any).currency,
            },
          },
        },
        { upsert: true }
      );
    } else {
      res.status(400).json({ message: "This product is not purchasable" });
      return;
    }

    // Mark intents as completed / paid
    await db
      .collection("signup_intents")
      .updateOne(
        { _id: (sIntent as any)._id },
        { $set: { status: "completed", userId, updatedAt: new Date() } }
      );
    await db.collection("payment_intents").updateOne(
      { _id: new ObjectId(intentId) },
      {
        $set: {
          status: "paid",
          updatedAt: new Date(),
          razorpay_order_id,
          razorpay_payment_id,
          razorpay_signature,
        },
      }
    );

    const token = generateToken(userId.toString());
    const u = await db.collection("users").findOne({ _id: userId });
    res.json({
      success: true,
      token,
      user: {
        id: userId,
        name: (u as any).name,
        email: (u as any).email,
        phone: (u as any).phone,
      },
    });
  } catch (err) {
    console.error("verifyPayment error:", err);
    res.status(500).json({ message: "Verification failed" });
  }
};
