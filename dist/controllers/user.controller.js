"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMyProducts = exports.updateProfile = exports.getProfile = exports.setUserDatabase = void 0;
const mongodb_1 = require("mongodb");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
let db;
/** Inject DB once at bootstrap */
const setUserDatabase = (database) => {
    db = database;
};
exports.setUserDatabase = setUserDatabase;
const requireDb = () => {
    if (!db)
        throw new Error("[user.controller] DB not initialized. Call setUserDatabase(db).");
    return db;
};
const toObjectId = (id) => {
    if (id instanceof mongodb_1.ObjectId)
        return id;
    if (!mongodb_1.ObjectId.isValid(id))
        throw new Error("Invalid ObjectId");
    return new mongodb_1.ObjectId(id);
};
/** Resolve userId from multiple sources:
 * 1) req.user.id (if auth middleware sets it)
 * 2) Authorization: Bearer <JWT> (shared with your other controllers)
 * 3) X-User-Id header (DEV helper)
 * 4) ?userId=<ObjectId> (DEV helper)
 */
const getUserIdFromReq = (req) => {
    const u = req.user;
    if (u?.id) {
        try {
            return toObjectId(u.id);
        }
        catch { /* ignore */ }
    }
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ") && process.env.JWT_SECRET) {
        const token = auth.split(" ")[1];
        try {
            const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
            if (decoded?.id)
                return toObjectId(decoded.id);
        }
        catch {
            /* invalid token -> fall through */
        }
    }
    const hdrUserId = req.header("X-User-Id");
    if (hdrUserId && mongodb_1.ObjectId.isValid(hdrUserId)) {
        return new mongodb_1.ObjectId(hdrUserId);
    }
    const qpUserId = req.query.userId || "";
    if (qpUserId && mongodb_1.ObjectId.isValid(qpUserId)) {
        return new mongodb_1.ObjectId(qpUserId);
    }
    return null;
};
/** GET /api/users/me */
const getProfile = async (req, res) => {
    try {
        const userId = getUserIdFromReq(req);
        if (!userId) {
            res.status(401).json({ message: "Not authorized" });
            return;
        }
        const _db = requireDb();
        const user = await _db.collection("users").findOne({ _id: userId }, { projection: { password: 0 } });
        if (!user) {
            res.status(404).json({ message: "User not found" });
            return;
        }
        res.json(user);
    }
    catch (err) {
        console.error("[users.getProfile] error:", err);
        res.status(500).json({ message: "Server error" });
    }
};
exports.getProfile = getProfile;
/** PUT /api/users/me  body: { name?: string, email?: string } */
const updateProfile = async (req, res) => {
    try {
        const userId = getUserIdFromReq(req);
        if (!userId) {
            res.status(401).json({ message: "Not authorized" });
            return;
        }
        const { name, email } = (req.body ?? {});
        if (!name && !email) {
            res.status(400).json({ message: "Nothing to update" });
            return;
        }
        const _db = requireDb();
        const existing = await _db.collection("users").findOne({ _id: userId });
        if (!existing) {
            res.status(404).json({ message: "User not found" });
            return;
        }
        if (email && email !== existing.email) {
            const dup = await _db.collection("users").findOne({ email });
            if (dup) {
                res.status(400).json({ message: "Email already in use" });
                return;
            }
        }
        const $set = { updatedAt: new Date() };
        if (name)
            $set.name = name;
        if (email)
            $set.email = email;
        await _db.collection("users").updateOne({ _id: userId }, { $set });
        const fresh = await _db.collection("users").findOne({ _id: userId }, { projection: { password: 0 } });
        res.json(fresh);
    }
    catch (err) {
        console.error("[users.updateProfile] error:", err);
        res.status(500).json({ message: "Server error" });
    }
};
exports.updateProfile = updateProfile;
/** GET /api/users/me/products
 * Returns active entitlements (status=active and (endsAt null or future)).
 * - DOES NOT filter by forSale (so bundle components like 'journaling' are returned)
 * - Hides 'journaling_solo' if 'journaling' (bundle component) exists
 * - Accepts ?debug=1 to include raw entitlements for troubleshooting
 */
const getMyProducts = async (req, res) => {
    try {
        const userId = getUserIdFromReq(req);
        if (!userId) {
            res.status(401).json({ message: "Not authorized" });
            return;
        }
        const debug = req.query.debug === "1";
        const _db = requireDb();
        const now = new Date();
        // 1) Fetch all active entitlements for the user
        const entitlements = await _db
            .collection("user_products")
            .find({
            userId,
            status: "active",
            $or: [{ endsAt: null }, { endsAt: { $gt: now } }],
        })
            .project({
            userId: 1,
            productId: 1,
            variantId: 1,
            status: 1,
            startedAt: 1,
            endsAt: 1,
            meta: 1,
        })
            .toArray();
        if (!entitlements.length) {
            res.json({ items: [], ...(debug ? { debug: { entitlements } } : {}) });
            return;
        }
        // 2) Load product documents for all productIds (NO forSale filter!)
        const productIds = Array.from(new Set(entitlements.map((e) => e.productId.toString()))).map((s) => new mongodb_1.ObjectId(s));
        const products = await _db
            .collection("products")
            .find({ _id: { $in: productIds }, isActive: true })
            .project({ key: 1, name: 1, route: 1, hasVariants: 1, forSale: 1 })
            .toArray();
        const productMap = new Map();
        products.forEach((p) => productMap.set(p._id.toString(), p));
        // 3) Load variant docs (if any)
        const variantIds = Array.from(new Set(entitlements
            .map((e) => e.variantId)
            .filter((v) => v && mongodb_1.ObjectId.isValid(v))
            .map((v) => v.toString()))).map((s) => new mongodb_1.ObjectId(s));
        let variantMap = new Map();
        if (variantIds.length) {
            const variants = await _db
                .collection("product_variants")
                .find({ _id: { $in: variantIds }, isActive: true })
                .project({ key: 1, name: 1, priceMonthly: 1, interval: 1, productId: 1 })
                .toArray();
            variants.forEach((v) => variantMap.set(v._id.toString(), v));
        }
        // 4) Build items
        const rawItems = entitlements
            .map((e) => {
            const pid = e.productId.toString();
            const vid = e.variantId ? e.variantId.toString() : null;
            const p = productMap.get(pid);
            if (!p)
                return null; // product might be inactive/removed
            const v = vid ? variantMap.get(vid) : null;
            return {
                productId: p._id,
                key: p.key,
                name: p.name,
                route: p.route,
                hasVariants: !!p.hasVariants,
                forSale: !!p.forSale,
                status: e.status,
                startedAt: e.startedAt ?? null,
                endsAt: e.endsAt ?? null,
                meta: e.meta ?? null,
                variant: v
                    ? {
                        variantId: v._id,
                        key: v.key,
                        name: v.name,
                        priceMonthly: v.priceMonthly ?? null,
                        interval: v.interval ?? null,
                    }
                    : null,
            };
        })
            .filter(Boolean);
        if (!rawItems.length) {
            res.json({ items: [], ...(debug ? { debug: { entitlements, products } } : {}) });
            return;
        }
        // 5) Hide Journaling (Solo) if Journaling (bundle component) exists
        const hasBundleJournaling = rawItems.some((it) => it.key === "journaling");
        const items = hasBundleJournaling
            ? rawItems.filter((it) => it.key !== "journaling_solo")
            : rawItems;
        // 6) If there are accidental duplicates, keep the one with the latest endsAt
        const latestByKey = new Map();
        for (const it of items) {
            const prev = latestByKey.get(it.key);
            if (!prev) {
                latestByKey.set(it.key, it);
            }
            else {
                const prevEnds = prev.endsAt ? new Date(prev.endsAt).getTime() : 0;
                const currEnds = it.endsAt ? new Date(it.endsAt).getTime() : 0;
                if (currEnds >= prevEnds)
                    latestByKey.set(it.key, it);
            }
        }
        const finalItems = Array.from(latestByKey.values()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        res.json({
            items: finalItems,
            ...(debug
                ? {
                    debug: {
                        entitlements,
                        productIds,
                        hasBundleJournaling,
                        keptKeys: finalItems.map((x) => x.key),
                    },
                }
                : {}),
        });
    }
    catch (err) {
        console.error("[users.getMyProducts] error:", err);
        res.status(500).json({ message: "Server error" });
    }
};
exports.getMyProducts = getMyProducts;
