"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyPayment = exports.createOrder = exports.setPaymentDatabase = void 0;
const crypto_1 = __importDefault(require("crypto"));
const mongodb_1 = require("mongodb");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const razorpay_service_1 = require("../services/razorpay.service");
let db;
const setPaymentDatabase = (database) => {
    db = database;
};
exports.setPaymentDatabase = setPaymentDatabase;
const BUNDLE_SKU_KEY = "essentials_bundle";
const ALGO_SKU_KEY = "algo_simulator";
const JOURNALING_SOLO_SKU_KEY = "journaling_solo";
const generateToken = (userId) => {
    const secret = process.env.JWT_SECRET;
    if (!secret)
        throw new Error("JWT_SECRET is not defined in .env");
    return jsonwebtoken_1.default.sign({ id: userId }, secret, { expiresIn: "30d" });
};
async function getBundleComponentsSet() {
    const bundle = await db
        .collection("products")
        .findOne({ key: BUNDLE_SKU_KEY, isActive: true });
    const comps = Array.isArray(bundle?.components)
        ? bundle.components
        : [
            "technical_scanner",
            "fundamental_scanner",
            "fno_khazana",
            "journaling",
            "fii_dii_data",
        ];
    return new Set(comps);
}
// ---------- helpers ----------
const getUserIdFromReqOrBearer = (req) => {
    const raw = req.user?.id ||
        req.user?._id ||
        req.userId ||
        null;
    if (raw) {
        try {
            return new mongodb_1.ObjectId(raw);
        }
        catch {
            /* ignore */
        }
    }
    const auth = req.headers.authorization;
    if (!auth)
        return null;
    const [scheme, token] = auth.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token)
        return null;
    try {
        const secret = process.env.JWT_SECRET;
        const decoded = jsonwebtoken_1.default.verify(token, secret);
        return decoded?.id ? new mongodb_1.ObjectId(decoded.id) : null;
    }
    catch {
        return null;
    }
};
const resolvePriceForProduct = async (product, interval, variant) => {
    const productKey = product.key;
    if (productKey === BUNDLE_SKU_KEY) {
        const pm = Number(product.priceMonthly);
        const py = Number(product.priceYearly);
        const envPM = Number(process.env.BUNDLE_MONTHLY_PRICE || 4999);
        const envPY = Number(process.env.BUNDLE_YEARLY_PRICE || envPM * 10);
        const priceRupees = interval === "yearly"
            ? Number.isFinite(py) && py > 0
                ? py
                : envPY
            : Number.isFinite(pm) && pm > 0
                ? pm
                : envPM;
        return {
            amountPaise: Math.round(priceRupees * 100),
            displayName: "Trader Essentials Bundle (5-in-1)" +
                (interval === "yearly" ? " – Yearly" : " – Monthly"),
        };
    }
    if (productKey === ALGO_SKU_KEY) {
        if (!variant) {
            const err = new Error("variantId required for this product");
            err.status = 400;
            throw err;
        }
        const priceMonthly = variant.priceMonthly;
        if (!priceMonthly || typeof priceMonthly !== "number") {
            return {
                amountPaise: 0,
                displayName: `${product.name} - ${variant.name}`,
            };
        }
        return {
            amountPaise: Math.round(priceMonthly * 100),
            displayName: `${product.name} - ${variant.name} (Monthly)`,
        };
    }
    if (productKey === JOURNALING_SOLO_SKU_KEY) {
        const pm = Number(product.priceMonthly);
        const py = Number(product.priceYearly);
        const envPM = Number(process.env.JOURNALING_SOLO_MONTHLY_PRICE || 299);
        const envPY = Number(process.env.JOURNALING_SOLO_YEARLY_PRICE || envPM * 10);
        const priceRupees = interval === "yearly"
            ? Number.isFinite(py) && py > 0
                ? py
                : envPY
            : Number.isFinite(pm) && pm > 0
                ? pm
                : envPM;
        return {
            amountPaise: Math.round(priceRupees * 100),
            displayName: product.name + (interval === "yearly" ? " (Yearly)" : " (Monthly)"),
        };
    }
    const err = new Error("This product is not purchasable");
    err.status = 400;
    throw err;
};
// ---- date helpers (expiry) ----
function addMonths(date, months) {
    const d = new Date(date);
    d.setMonth(d.getMonth() + months);
    return d;
}
function addYears(date, years) {
    const d = new Date(date);
    d.setFullYear(d.getFullYear() + years);
    return d;
}
function computeEndsAt(interval, from) {
    return interval === "yearly" ? addYears(from, 1) : addMonths(from, 1);
}
// ---------- DUPLICATE / UPGRADE HELPERS ----------
function endsActiveExpr(now) {
    return { $or: [{ endsAt: null }, { endsAt: { $gt: now } }] };
}
function variantFilterExpr(variantId) {
    return variantId === null
        ? { $or: [{ variantId: null }, { variantId: { $exists: false } }] }
        : { variantId };
}
/** Active entitlement for specific product (+ optional variant). */
async function findActiveEntitlement(userId, productId, variantId) {
    const now = new Date();
    return db.collection("user_products").findOne({
        userId,
        productId,
        status: "active",
        $and: [variantFilterExpr(variantId), endsActiveExpr(now)],
    });
}
/** Active bundle components that came from bundle purchase (source=payment_bundle). */
async function findActiveBundleComponentEntitlements(userId) {
    const now = new Date();
    const componentKeys = Array.from(await getBundleComponentsSet());
    const components = await db
        .collection("products")
        .find({ key: { $in: componentKeys }, isActive: true })
        .project({ _id: 1 })
        .toArray();
    const componentIds = components.map((p) => p._id);
    return db
        .collection("user_products")
        .find({
        userId,
        productId: { $in: componentIds },
        status: "active",
        $and: [
            variantFilterExpr(null),
            endsActiveExpr(now),
            { "meta.source": "payment_bundle" },
        ],
    })
        .toArray();
}
/** Cancel any active Journaling (Solo) entitlements when a Bundle purchase completes. */
async function cancelActiveJournalingSolo(userId, reason) {
    const now = new Date();
    const journalingSolo = await db
        .collection("products")
        .findOne({ key: JOURNALING_SOLO_SKU_KEY, isActive: true });
    if (!journalingSolo)
        return;
    await db.collection("user_products").updateMany({
        userId,
        productId: journalingSolo._id,
        status: "active",
        $or: [{ endsAt: null }, { endsAt: { $gt: now } }],
    }, {
        $set: {
            status: "cancelled",
            endsAt: now,
            "meta.cancelledBy": reason,
            "meta.cancelledAt": now,
        },
    });
}
// small helper to compute interval we want to store on upgrades
const intervalToSet = (interval, isUpgrade) => isUpgrade ? "yearly" : interval;
// ---------- controller: createOrder ----------
const createOrder = async (req, res) => {
    try {
        const { signupIntentId, productId, variantId, billingInterval, brokerConfig, } = (req.body ?? {});
        // ----- Guest flow (register-intent) -----
        if (signupIntentId) {
            let signupObjectId;
            try {
                signupObjectId = new mongodb_1.ObjectId(signupIntentId);
            }
            catch {
                res.status(400).json({ message: "Invalid signupIntentId" });
                return;
            }
            const intent = await db
                .collection("signup_intents")
                .findOne({ _id: signupObjectId });
            if (!intent) {
                res.status(404).json({ message: "Signup intent not found" });
                return;
            }
            if (intent.status !== "created") {
                res
                    .status(400)
                    .json({ message: "Signup intent not in a payable state" });
                return;
            }
            if (!intent.productId) {
                res.status(400).json({ message: "No product selected for payment" });
                return;
            }
            const product = await db
                .collection("products")
                .findOne({ _id: intent.productId, isActive: true });
            if (!product) {
                res.status(400).json({ message: "Invalid product" });
                return;
            }
            const interval = intent.billingInterval || "monthly";
            const productKey = product.key;
            let variantDoc = null;
            if (productKey === ALGO_SKU_KEY) {
                if (!intent.variantId) {
                    res
                        .status(400)
                        .json({ message: "variantId required for this product" });
                    return;
                }
                variantDoc = await db.collection("product_variants").findOne({
                    _id: intent.variantId,
                    productId: product._id,
                    isActive: true,
                });
                if (!variantDoc) {
                    res.status(400).json({ message: "Invalid or inactive variant" });
                    return;
                }
            }
            const { amountPaise, displayName } = await resolvePriceForProduct(product, interval, variantDoc);
            if (amountPaise === 0) {
                res.status(204).send();
                return;
            }
            const order = await razorpay_service_1.razorpay.orders.create({
                amount: amountPaise,
                currency: process.env.CURRENCY || "INR",
                receipt: `rcpt_${Date.now()}`,
                notes: { signupIntentId },
            });
            const amountRupeesGuest = Number(order.amount) / 100;
            const paymentIntent = await db.collection("payment_intents").insertOne({
                signupIntentId: signupObjectId,
                orderId: order.id,
                amount: amountRupeesGuest,
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
                    name: intent.name,
                    email: intent.email,
                    contact: intent.phone,
                },
            });
            return;
        }
        // ----- Logged-in direct purchase -----
        const authUserId = getUserIdFromReqOrBearer(req);
        if (!authUserId) {
            res.status(401).json({ message: "Authentication required" });
            return;
        }
        if (!productId) {
            res.status(400).json({ message: "productId is required" });
            return;
        }
        let productObjectId;
        try {
            productObjectId = new mongodb_1.ObjectId(productId);
        }
        catch {
            res.status(400).json({ message: "Invalid productId" });
            return;
        }
        const product = await db
            .collection("products")
            .findOne({ _id: productObjectId, isActive: true });
        if (!product) {
            res.status(400).json({ message: "Invalid product" });
            return;
        }
        const productKey = product.key;
        const interval = billingInterval ||
            (productKey === ALGO_SKU_KEY ? "monthly" : "monthly");
        let variantDoc = null;
        let isUpgrade = false;
        // === Duplicate / Upgrade checks ===
        if (productKey === ALGO_SKU_KEY) {
            if (!variantId) {
                res
                    .status(400)
                    .json({ message: "variantId required for this product" });
                return;
            }
            let variantObjectId;
            try {
                variantObjectId = new mongodb_1.ObjectId(variantId);
            }
            catch {
                res.status(400).json({ message: "Invalid variantId" });
                return;
            }
            variantDoc = await db.collection("product_variants").findOne({
                _id: variantObjectId,
                productId: product._id,
                isActive: true,
            });
            if (!variantDoc) {
                res.status(400).json({ message: "Invalid or inactive variant" });
                return;
            }
            const activeAlgo = await findActiveEntitlement(authUserId, product._id, variantObjectId);
            if (activeAlgo) {
                res.status(409).json({
                    message: "You already have an active ALGO Simulator plan for this variant",
                });
                return;
            }
        }
        else if (productKey === BUNDLE_SKU_KEY) {
            const activeBundleComps = await findActiveBundleComponentEntitlements(authUserId);
            if (activeBundleComps.length > 0) {
                const anyMonthly = activeBundleComps.some((r) => r?.meta?.interval === "monthly");
                if (interval === "yearly" && anyMonthly) {
                    isUpgrade = true;
                }
                else {
                    res
                        .status(409)
                        .json({ message: "You already have active Bundle access" });
                    return;
                }
            }
        }
        else if (productKey === JOURNALING_SOLO_SKU_KEY) {
            const journalingProd = await db
                .collection("products")
                .findOne({ key: "journaling", isActive: true });
            if (journalingProd) {
                const now = new Date();
                const hasBundleJ = await db.collection("user_products").findOne({
                    userId: authUserId,
                    productId: journalingProd._id,
                    status: "active",
                    $and: [
                        variantFilterExpr(null),
                        endsActiveExpr(now),
                        { "meta.source": "payment_bundle" },
                    ],
                });
                if (hasBundleJ) {
                    res.status(409).json({
                        message: "Your Bundle already includes Journaling. No need to buy Journaling (Solo).",
                    });
                    return;
                }
            }
            const activeSolo = await findActiveEntitlement(authUserId, product._id, null);
            if (activeSolo) {
                const existingInterval = activeSolo?.meta?.interval || "monthly";
                if (existingInterval === "yearly") {
                    res
                        .status(409)
                        .json({ message: "You already have an active Journaling (Solo) – Yearly" });
                    return;
                }
                if (interval === "yearly" && existingInterval === "monthly") {
                    isUpgrade = true;
                }
                else {
                    res
                        .status(409)
                        .json({ message: "You already have an active Journaling (Solo)" });
                    return;
                }
            }
        }
        else {
            res.status(400).json({ message: "This product is not purchasable" });
            return;
        }
        const { amountPaise, displayName } = await resolvePriceForProduct(product, interval, variantDoc);
        if (amountPaise === 0) {
            res.status(204).send();
            return;
        }
        const u = await db.collection("users").findOne({ _id: authUserId });
        const order = await razorpay_service_1.razorpay.orders.create({
            amount: amountPaise,
            currency: process.env.CURRENCY || "INR",
            receipt: `rcpt_${Date.now()}`,
            notes: {
                purchase: "direct",
                productId,
                variantId: variantId || "",
                userId: authUserId.toString(),
                interval,
                ...(isUpgrade ? { upgradeTo: "yearly" } : {}),
            },
        });
        const amountRupeesDirect = Number(order.amount) / 100;
        const paymentIntent = await db.collection("payment_intents").insertOne({
            orderId: order.id,
            amount: amountRupeesDirect,
            currency: order.currency,
            status: "created",
            createdAt: new Date(),
            updatedAt: new Date(),
            purchase: {
                userId: authUserId,
                productId: productObjectId,
                variantId: variantId ? new mongodb_1.ObjectId(variantId) : null,
                interval,
                brokerConfig: brokerConfig || null,
                ...(isUpgrade ? { upgradeTo: "yearly" } : {}),
            },
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
                name: u?.name,
                email: u?.email,
                contact: u?.phone,
            },
        });
        return;
    }
    catch (err) {
        const status = err?.status || 500;
        console.error("createOrder error:", {
            name: err?.name,
            message: err?.message,
            stack: err?.stack?.split("\n").slice(0, 2).join("\n"),
        });
        res
            .status(status)
            .json({ message: err?.message || "Failed to create order" });
        return;
    }
};
exports.createOrder = createOrder;
// ---------- controller: verifyPayment ----------
const verifyPayment = async (req, res) => {
    const now = new Date();
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, intentId, } = (req.body ?? {});
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !intentId) {
        res.status(400).json({ message: "Missing payment verification fields" });
        return;
    }
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret || !keySecret.trim()) {
        res.status(500).json({ message: "Server misconfiguration: RAZORPAY_KEY_SECRET not set" });
        return;
    }
    let intentObjectId;
    try {
        intentObjectId = new mongodb_1.ObjectId(intentId);
    }
    catch {
        res.status(400).json({ message: "Invalid intentId" });
        return;
    }
    try {
        const pIntent = await db.collection("payment_intents").findOne({ _id: intentObjectId });
        if (!pIntent) {
            res.status(404).json({ message: "Payment intent not found" });
            return;
        }
        if (pIntent.orderId && pIntent.orderId !== razorpay_order_id) {
            await db.collection("payment_intents").updateOne({ _id: intentObjectId }, {
                $set: {
                    status: "failed",
                    updatedAt: now,
                    razorpay_order_id,
                    razorpay_payment_id,
                    razorpay_signature,
                    failureReason: "order_id_mismatch",
                },
            });
            res.status(400).json({ message: "Order ID mismatch for this intent" });
            return;
        }
        const expected = crypto_1.default
            .createHmac("sha256", keySecret)
            .update(`${razorpay_order_id}|${razorpay_payment_id}`)
            .digest("hex");
        if (expected !== razorpay_signature) {
            await db.collection("payment_intents").updateOne({ _id: intentObjectId }, {
                $set: {
                    status: "failed",
                    updatedAt: now,
                    razorpay_order_id,
                    razorpay_payment_id,
                    razorpay_signature,
                    failureReason: "invalid_signature",
                },
            });
            res.status(400).json({ message: "Invalid signature" });
            return;
        }
        const paidAmountRupees = Number(pIntent.amount) || 0;
        // ===== FLOW A: Guest – finalize signup =====
        if (pIntent.signupIntentId) {
            const signupId = pIntent.signupIntentId;
            if (!signupId || !(signupId instanceof mongodb_1.ObjectId)) {
                res.status(400).json({ message: "Corrupt payment intent: missing signupIntentId" });
                return;
            }
            const sIntent = await db.collection("signup_intents").findOne({ _id: signupId });
            if (!sIntent) {
                res.status(404).json({ message: "Signup intent not found" });
                return;
            }
            if (sIntent.status !== "created") {
                res.status(400).json({ message: "Signup intent already finalized" });
                return;
            }
            const existing = await db.collection("users").findOne({
                $or: [{ email: sIntent.email }, { phone: sIntent.phone }],
            });
            let userId;
            if (existing) {
                userId = existing._id;
            }
            else {
                const ins = await db.collection("users").insertOne({
                    name: sIntent.name,
                    email: sIntent.email,
                    phone: sIntent.phone,
                    password: sIntent.passwordHash ?? sIntent.password ?? null,
                    role: "customer",
                    createdAt: now,
                    updatedAt: now,
                });
                userId = ins.insertedId;
            }
            const sProduct = await db.collection("products").findOne({ _id: sIntent.productId });
            if (!sProduct) {
                res.status(400).json({ message: "Invalid product on signup intent" });
                return;
            }
            const sProductKey = sProduct?.key;
            if (!sProductKey) {
                res.status(400).json({ message: "This product is not purchasable" });
                return;
            }
            const interval = (sIntent.billingInterval ?? "monthly");
            const newEndsAt = computeEndsAt(interval, now);
            if (sProductKey === BUNDLE_SKU_KEY) {
                const componentKeys = Array.from(await getBundleComponentsSet());
                const bundleProducts = await db
                    .collection("products")
                    .find({ key: { $in: componentKeys }, isActive: true })
                    .toArray();
                for (const bp of bundleProducts) {
                    await db.collection("user_products").updateOne({ userId, productId: bp._id, variantId: null }, {
                        $setOnInsert: { startedAt: now },
                        $set: {
                            status: "active",
                            endsAt: newEndsAt,
                            lastPaymentAt: now,
                            "meta.source": "payment_bundle",
                            "meta.interval": interval,
                            paymentMeta: {
                                provider: "razorpay",
                                orderId: razorpay_order_id,
                                paymentId: razorpay_payment_id,
                                amount: paidAmountRupees,
                                currency: pIntent.currency,
                            },
                        },
                    }, { upsert: true });
                }
                await cancelActiveJournalingSolo(userId, "bundle_purchase");
            }
            else if (sProductKey === ALGO_SKU_KEY) {
                const ends = computeEndsAt("monthly", now);
                await db.collection("user_products").updateOne({
                    userId,
                    productId: sIntent.productId,
                    variantId: sIntent.variantId || null,
                }, {
                    $setOnInsert: { startedAt: now },
                    $set: {
                        status: "active",
                        endsAt: ends,
                        lastPaymentAt: now,
                        "meta.source": "payment",
                        "meta.interval": "monthly",
                        paymentMeta: {
                            provider: "razorpay",
                            orderId: razorpay_order_id,
                            paymentId: razorpay_payment_id,
                            amount: paidAmountRupees,
                            currency: pIntent.currency,
                        },
                    },
                }, { upsert: true });
                if (sIntent.variantId && sIntent.brokerConfig) {
                    await db.collection("broker_configs").insertOne({
                        userId,
                        productId: sIntent.productId,
                        variantId: sIntent.variantId,
                        brokerName: sIntent.brokerConfig?.brokerName,
                        createdAt: now,
                        updatedAt: now,
                        ...(sIntent.brokerConfig || {}),
                    });
                }
            }
            else if (sProductKey === JOURNALING_SOLO_SKU_KEY) {
                await db.collection("user_products").updateOne({ userId, productId: sIntent.productId, variantId: null }, {
                    $setOnInsert: { startedAt: now },
                    $set: {
                        status: "active",
                        endsAt: newEndsAt,
                        lastPaymentAt: now,
                        "meta.source": "payment",
                        "meta.interval": interval,
                        paymentMeta: {
                            provider: "razorpay",
                            orderId: razorpay_order_id,
                            paymentId: razorpay_payment_id,
                            amount: paidAmountRupees,
                            currency: pIntent.currency,
                        },
                    },
                }, { upsert: true });
            }
            else {
                res.status(400).json({ message: "This product is not purchasable" });
                return;
            }
            await db.collection("signup_intents").updateOne({ _id: signupId }, { $set: { status: "completed", userId, updatedAt: now } });
            await db.collection("payment_intents").updateOne({ _id: intentObjectId }, {
                $set: {
                    status: "paid",
                    updatedAt: now,
                    razorpay_order_id,
                    razorpay_payment_id,
                    razorpay_signature,
                },
            });
            const token = generateToken(userId.toString());
            const u = await db.collection("users").findOne({ _id: userId });
            res.json({
                success: true,
                token,
                user: {
                    id: userId,
                    name: u?.name,
                    email: u?.email,
                    phone: u?.phone,
                },
            });
            return;
        }
        // ===== FLOW B: Direct purchase =====
        const purchase = pIntent.purchase;
        if (!purchase) {
            res.status(400).json({ message: "Invalid payment intent" });
            return;
        }
        const userId = purchase.userId;
        const prodId = purchase.productId;
        const varId = purchase.variantId || null;
        const interval = purchase.interval || "monthly";
        const brokerConfig = purchase.brokerConfig || null;
        const isUpgrade = purchase.upgradeTo === "yearly";
        const newEndsAt = computeEndsAt(interval, now);
        const product = await db.collection("products").findOne({ _id: prodId });
        if (!product) {
            res.status(400).json({ message: "Invalid product" });
            return;
        }
        const pKey = product?.key;
        if (!pKey) {
            res.status(400).json({ message: "This product is not purchasable" });
            return;
        }
        if (pKey === BUNDLE_SKU_KEY) {
            const componentKeys = Array.from(await getBundleComponentsSet());
            const bundleProducts = await db
                .collection("products")
                .find({ key: { $in: componentKeys }, isActive: true })
                .toArray();
            for (const bp of bundleProducts) {
                await db.collection("user_products").updateOne({ userId, productId: bp._id, variantId: null }, {
                    $setOnInsert: { startedAt: now },
                    $set: {
                        status: "active",
                        endsAt: newEndsAt,
                        lastPaymentAt: now,
                        "meta.source": "payment_bundle",
                        "meta.interval": intervalToSet(interval, isUpgrade),
                        paymentMeta: {
                            provider: "razorpay",
                            orderId: razorpay_order_id,
                            paymentId: razorpay_payment_id,
                            amount: paidAmountRupees,
                            currency: pIntent.currency,
                        },
                    },
                }, { upsert: true });
            }
            await cancelActiveJournalingSolo(userId, "bundle_purchase");
        }
        else if (pKey === ALGO_SKU_KEY) {
            const ends = computeEndsAt("monthly", now);
            await db.collection("user_products").updateOne({ userId, productId: prodId, variantId: varId }, {
                $setOnInsert: { startedAt: now },
                $set: {
                    status: "active",
                    endsAt: ends,
                    lastPaymentAt: now,
                    "meta.source": "payment",
                    "meta.interval": "monthly",
                    paymentMeta: {
                        provider: "razorpay",
                        orderId: razorpay_order_id,
                        paymentId: razorpay_payment_id,
                        amount: paidAmountRupees,
                        currency: pIntent.currency,
                    },
                },
            }, { upsert: true });
            if (varId && brokerConfig) {
                await db.collection("broker_configs").insertOne({
                    userId,
                    productId: prodId,
                    variantId: varId,
                    brokerName: brokerConfig?.brokerName,
                    createdAt: now,
                    updatedAt: now,
                    ...(brokerConfig || {}),
                });
            }
        }
        else if (pKey === JOURNALING_SOLO_SKU_KEY) {
            await db.collection("user_products").updateOne({ userId, productId: prodId, variantId: null }, {
                $setOnInsert: { startedAt: now },
                $set: {
                    status: "active",
                    endsAt: newEndsAt,
                    lastPaymentAt: now,
                    "meta.source": "payment",
                    "meta.interval": intervalToSet(interval, isUpgrade),
                    paymentMeta: {
                        provider: "razorpay",
                        orderId: razorpay_order_id,
                        paymentId: razorpay_payment_id,
                        amount: paidAmountRupees,
                        currency: pIntent.currency,
                    },
                },
            }, { upsert: true });
        }
        else {
            res.status(400).json({ message: "This product is not purchasable" });
            return;
        }
        await db.collection("payment_intents").updateOne({ _id: intentObjectId }, {
            $set: {
                status: "paid",
                updatedAt: now,
                razorpay_order_id,
                razorpay_payment_id,
                razorpay_signature,
            },
        });
        res.json({ success: true });
        return;
    }
    catch (err) {
        const simplified = {
            name: err?.name,
            code: err?.code,
            message: err?.message,
            stackTop: err?.stack?.split("\n").slice(0, 3).join("\n"),
        };
        console.error("verifyPayment fatal:", simplified);
        if (err?.code === 11000) {
            res.status(409).json({ message: "Duplicate resource conflict while finalizing payment" });
            return;
        }
        res.status(500).json({ message: "Verification failed" });
        return;
    }
};
exports.verifyPayment = verifyPayment;
