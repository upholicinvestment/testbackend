"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = registerContactRoutes;
// ---- Minimal in-memory rate limiter (per IP) ----
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 10; // 10 requests/IP/min
const ipHits = new Map();
const rateLimit = (req, res, next) => {
    const fwd = req.headers["x-forwarded-for"];
    const first = Array.isArray(fwd) ? fwd[0] : (fwd || "");
    const ip = (first ? first.split(",")[0].trim() : "") || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const rec = ipHits.get(ip);
    if (!rec || now > rec.resetAt) {
        ipHits.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        next();
        return;
    }
    if (rec.count >= RATE_LIMIT_MAX) {
        res.status(429).json({ error: "Too many requests. Please try again shortly." });
        return;
    }
    rec.count += 1;
    next();
};
const ALLOWED_PERSONAS = new Set([
    "5-in-1 Trader's Essential Bundle",
    "ALGO Simulator",
    "Both / Not sure",
    "Select a product",
]);
function isEmail(x) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);
}
function isPhoneLike(x) {
    const digits = (x || "").replace(/\D/g, "");
    return digits.length >= 8;
}
function validateBody(body) {
    const b = body || {};
    if (!b.firstName || typeof b.firstName !== "string")
        return { ok: false, error: "firstName is required" };
    if (!b.lastName || typeof b.lastName !== "string")
        return { ok: false, error: "lastName is required" };
    if (!b.email || !isEmail(b.email))
        return { ok: false, error: "Valid email is required" };
    if (b.company && !isPhoneLike(b.company))
        return { ok: false, error: "Mobile number looks invalid" };
    if (!b.persona || !ALLOWED_PERSONAS.has(b.persona))
        return { ok: false, error: "Please select a valid product" };
    if (typeof b.agree !== "boolean" || !b.agree)
        return { ok: false, error: "You must agree to Terms & Privacy" };
    if (typeof b.message !== "string")
        return { ok: false, error: "message must be a string" };
    if (b.website && b.website.trim().length > 0)
        return { ok: false, error: "Spam detected" };
    return { ok: true };
}
// ---- Index Helper (idempotent) ----
async function ensureIndexes(collectionName, db) {
    const col = db.collection(collectionName);
    await col.createIndex({ createdAt: -1 });
    await col.createIndex({ email: 1, createdAt: -1 });
    await col.createIndex({ persona: 1, createdAt: -1 });
}
function registerContactRoutes(app, db) {
    const COLLECTION = "contact_messages";
    // Ensure indexes on boot (fire-and-forget)
    void ensureIndexes(COLLECTION, db).catch((e) => console.warn("Index creation error (contact_messages):", e));
    // POST /api/contact — save a contact submission
    const postContact = async (req, res) => {
        try {
            const check = validateBody(req.body);
            if (!check.ok) {
                res.status(400).json({ error: check.error });
                return;
            }
            const payload = req.body;
            const doc = {
                firstName: payload.firstName.trim(),
                lastName: payload.lastName.trim(),
                email: payload.email.trim().toLowerCase(),
                mobile: (payload.company || "").trim(),
                persona: payload.persona,
                message: (payload.message || "").trim(),
                agree: !!payload.agree,
                createdAt: new Date(),
                status: "new",
                meta: {
                    ip: (() => {
                        const fwd = req.headers["x-forwarded-for"];
                        const first = Array.isArray(fwd) ? fwd[0] : (fwd || "");
                        return (first ? first.split(",")[0].trim() : "") || req.socket.remoteAddress || null;
                    })(),
                    ua: req.headers["user-agent"] || null,
                    referer: req.headers["referer"] || null,
                },
            };
            const col = db.collection(COLLECTION);
            const result = await col.insertOne(doc);
            res.status(201).json({
                ok: true,
                id: result.insertedId,
                message: "Thanks! We received your message.",
            });
            return;
        }
        catch (err) {
            console.error("POST /api/contact error:", err);
            res.status(500).json({ error: "Internal server error" });
            return;
        }
    };
    // GET /api/contact — list recent messages (admin)
    const getContactList = async (req, res) => {
        try {
            const secret = req.header("x-admin-secret");
            if (!process.env.CONTACT_ADMIN_SECRET || secret !== process.env.CONTACT_ADMIN_SECRET) {
                res.status(403).json({ error: "Forbidden" });
                return;
            }
            const col = db.collection(COLLECTION);
            const items = await col
                .find({})
                .sort({ createdAt: -1 })
                .limit(200)
                .toArray();
            res.json({ ok: true, count: items.length, items });
            return;
        }
        catch (err) {
            console.error("GET /api/contact error:", err);
            res.status(500).json({ error: "Internal server error" });
            return;
        }
    };
    app.post("/api/contact", rateLimit, postContact);
    app.get("/api/contact", getContactList);
}
