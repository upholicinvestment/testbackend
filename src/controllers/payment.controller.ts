// server/src/controllers/payment.controller.ts
import { Request, Response, RequestHandler } from "express";
import crypto from "crypto";
import { Db, ObjectId } from "mongodb";
import { razorpay } from "../services/razorpay.service";
import jwt from "jsonwebtoken";

let db: Db;
export const setPaymentDatabase = (database: Db) => { db = database; };

const generateToken = (userId: string) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not defined in .env");
  return jwt.sign({ id: userId }, secret, { expiresIn: "30d" });
};

// Create order for a signup intent (no user yet)
export const createOrder: RequestHandler = async (req: Request, res: Response) => {
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
      res.status(400).json({ message: "Signup intent not in a payable state" });
      return;
    }
    if (!(intent as any).productId) {
      res.status(400).json({ message: "No product selected for payment" });
      return;
    }

    const product = await db.collection("products").findOne({
      _id: (intent as any).productId,
      isActive: true,
    });
    if (!product) {
      res.status(400).json({ message: "Invalid product" });
      return;
    }

    let amountPaise = 0;
    let displayName = (product as any).name;

    if ((product as any).hasVariants) {
      const variantId = (intent as any).variantId;
      if (!variantId) {
        res.status(400).json({ message: "variantId required for this product" });
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
        res.status(204).send(); // free
        return;
      }
      amountPaise = Math.round(priceMonthly * 100);
      displayName = `${(product as any).name} - ${(variant as any).name}`;
    } else {
      const priceMonthly = (product as any).priceMonthly;
      if (!priceMonthly || typeof priceMonthly !== "number") {
        res.status(204).send(); // free
        return;
      }
      amountPaise = Math.round(priceMonthly * 100);
    }

    const order = await razorpay.orders.create({
      amount: amountPaise,
      currency: process.env.CURRENCY || "INR",
      receipt: `rcpt_${Date.now()}`,
      notes: {
        signupIntentId: signupIntentId,
      },
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

// Verify payment → create user now, mark products, return token+user
export const verifyPayment: RequestHandler = async (req: Request, res: Response) => {
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

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !intentId) {
      res.status(400).json({ message: "Missing payment verification fields" });
      return;
    }

    const pIntent = await db.collection("payment_intents").findOne({
      _id: new ObjectId(intentId),
    });
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
        { $set: { status: "failed", updatedAt: new Date(), razorpay_order_id, razorpay_payment_id, razorpay_signature } }
      );
      res.status(400).json({ message: "Invalid signature" });
      return;
    }

    // Load signup intent
    const sIntent = await db.collection("signup_intents").findOne({
      _id: (pIntent as any).signupIntentId,
    });
    if (!sIntent) {
      res.status(404).json({ message: "Signup intent not found" });
      return;
    }
    if ((sIntent as any).status !== "created") {
      res.status(400).json({ message: "Signup intent already finalized" });
      return;
    }

    // Create user now (only on success)
    const existing = await db.collection("users").findOne({
      $or: [{ email: (sIntent as any).email }, { phone: (sIntent as any).phone }],
    });
    if (existing) {
      // Edge case: if user already created (shouldn't happen), just link
      await db.collection("signup_intents").updateOne(
        { _id: (sIntent as any)._id },
        { $set: { status: "completed", userId: (existing as any)._id, updatedAt: new Date() } }
      );
      await db.collection("payment_intents").updateOne(
        { _id: new ObjectId(intentId) },
        { $set: { status: "paid", updatedAt: new Date(), razorpay_order_id, razorpay_payment_id, razorpay_signature } }
      );
      const token = generateToken((existing as any)._id.toString());
      res.json({
        success: true,
        token,
        user: { id: (existing as any)._id, name: (existing as any).name, email: (existing as any).email, phone: (existing as any).phone },
      });
      return;
    }

    const userIns = await db.collection("users").insertOne({
      name: (sIntent as any).name,
      email: (sIntent as any).email,
      phone: (sIntent as any).phone,
      password: (sIntent as any).passwordHash,
      role: "customer",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create/activate product mapping
    if ((sIntent as any).productId) {
      await db.collection("user_products").updateOne(
        {
          userId: userIns.insertedId,
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

      // Broker config if ALGO with brokerConfig present
      const product = await db.collection("products").findOne({ _id: (sIntent as any).productId });
      if ((product as any)?.key === "algo_simulator" && (sIntent as any).variantId && (sIntent as any).brokerConfig) {
        await db.collection("broker_configs").insertOne({
          userId: userIns.insertedId,
          productId: (sIntent as any).productId,
          variantId: (sIntent as any).variantId,
          brokerName: (sIntent as any).brokerConfig?.brokerName,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...((sIntent as any).brokerConfig || {}),
        });
      }
    }

    // Mark both intents
    await db.collection("signup_intents").updateOne(
      { _id: (sIntent as any)._id },
      { $set: { status: "completed", userId: userIns.insertedId, updatedAt: new Date() } }
    );
    await db.collection("payment_intents").updateOne(
      { _id: new ObjectId(intentId) },
      { $set: { status: "paid", updatedAt: new Date(), razorpay_order_id, razorpay_payment_id, razorpay_signature } }
    );

    const token = generateToken(userIns.insertedId.toString());
    res.json({
      success: true,
      token,
      user: { id: userIns.insertedId, name: (sIntent as any).name, email: (sIntent as any).email, phone: (sIntent as any).phone },
    });
  } catch (err) {
    console.error("verifyPayment error:", err);
    res.status(500).json({ message: "Verification failed" });
  }
};
