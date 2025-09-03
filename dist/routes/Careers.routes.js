"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = registerCareersRoutes;
const express_1 = __importDefault(require("express"));
const mongodb_1 = require("mongodb");
const multer_1 = __importDefault(require("multer"));
const events_1 = require("events");
// ========================= Utils =========================
function asyncHandler(fn) {
    return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}
function toNum(n) {
    if (n === undefined || n === null || n === "")
        return undefined;
    const x = Number(n);
    return Number.isFinite(x) ? x : undefined;
}
function pick(obj, keys) {
    const out = {};
    keys.forEach((k) => {
        if (obj[k] !== undefined)
            out[k] = obj[k];
    });
    return out;
}
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});
function getBucket(db) {
    // Dedicated bucket named "resumes" → collections: resumes.files / resumes.chunks
    return new mongodb_1.GridFSBucket(db, { bucketName: "resumes" });
}
async function putBufferToGridFS(bucket, filename, buf, contentType, metadata) {
    const stream = bucket.openUploadStream(filename, { contentType, metadata });
    stream.end(buf);
    await (0, events_1.once)(stream, "finish");
    return stream.id;
}
// ========================= Router =========================
function registerCareersRoutes(db) {
    const router = express_1.default.Router();
    const jobsCol = db.collection("careers_jobs");
    const savedCol = db.collection("careers_saved"); // { userId, email?, jobId, createdAt }
    const appsCol = db.collection("careers_applications");
    const resumeCol = db.collection("careers_resumes");
    // Ensure helpful indexes (won't throw if they already exist)
    jobsCol.createIndex({ id: 1 }, { unique: true }).catch(() => { });
    savedCol.createIndex({ userId: 1, jobId: 1 }, { unique: true }).catch(() => { });
    appsCol.createIndex({ jobId: 1, email: 1, createdAt: -1 }).catch(() => { });
    resumeCol.createIndex({ email: 1, createdAt: -1 }).catch(() => { });
    // -------- GET /jobs (list + optional filters) --------
    router.get("/jobs", asyncHandler(async (req, res) => {
        const { q, dept, loc, expMax } = req.query;
        const filter = {};
        if (dept && dept !== "All")
            filter.department = dept;
        if (loc && loc !== "All")
            filter.locations = { $in: [loc] };
        if (expMax)
            filter["experience.min"] = { $lte: Number(expMax) };
        // q matches across key text fields
        if (q && q.trim()) {
            const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
            filter.$or = [
                { title: rx },
                { department: rx },
                { description: rx },
                { mustHave: rx },
                { niceToHave: rx },
                { locations: rx },
            ];
        }
        const docs = await jobsCol
            .find(filter)
            .sort({ createdAt: -1 })
            .project({ _id: 0 })
            .toArray();
        res.json(docs);
    }));
    // -------- POST /jobs (create) [admin] --------
    router.post("/jobs", asyncHandler(async (req, res) => {
        const now = new Date();
        const body = req.body;
        if (!body.id || !body.title || !body.department) {
            return res.status(400).json({ error: "id, title, department are required" });
        }
        const doc = {
            id: String(body.id),
            iconKey: body.iconKey || "code",
            title: String(body.title),
            department: String(body.department),
            locations: Array.isArray(body.locations) ? body.locations : ["Remote"],
            experience: body.experience || { min: 0, max: 10 },
            type: body.type || "Full-time",
            posted: body.posted || new Date().toISOString(),
            description: body.description || "",
            mustHave: body.mustHave || [],
            niceToHave: body.niceToHave || [],
            responsibilities: body.responsibilities || [],
            createdAt: now,
            updatedAt: now,
        };
        await jobsCol.insertOne(doc);
        res.json({ success: true, job: doc });
    }));
    // -------- PUT /jobs/:id (update) [admin] --------
    router.put("/jobs/:id", asyncHandler(async (req, res) => {
        const { id } = req.params;
        const payload = req.body;
        const $set = pick(payload, [
            "iconKey",
            "title",
            "department",
            "locations",
            "experience",
            "type",
            "posted",
            "description",
            "mustHave",
            "niceToHave",
            "responsibilities",
        ]);
        $set.updatedAt = new Date();
        const result = await jobsCol.updateOne({ id }, { $set });
        if (!result.matchedCount)
            return res.status(404).json({ error: "Job not found" });
        res.json({ success: true });
    }));
    // -------- DELETE /jobs/:id (delete) [admin] --------
    router.delete("/jobs/:id", asyncHandler(async (req, res) => {
        const { id } = req.params;
        const result = await jobsCol.deleteOne({ id });
        if (!result.deletedCount)
            return res.status(404).json({ error: "Job not found" });
        res.json({ success: true });
    }));
    // -------- POST /jobs/:id/save (toggle save for user) --------
    router.post("/jobs/:id/save", asyncHandler(async (req, res) => {
        const { id } = req.params;
        const { saved, userId, email } = req.body;
        const job = await jobsCol.findOne({ id });
        if (!job)
            return res.status(404).json({ error: "Job not found" });
        // Choose the identifier you use in your app (JWT user id, email, etc.)
        const owner = userId || email || "anonymous";
        const key = { userId: owner, jobId: id };
        if (saved) {
            await savedCol.updateOne(key, { $set: { ...key, createdAt: new Date() } }, { upsert: true });
        }
        else {
            await savedCol.deleteOne(key);
        }
        res.json({ success: true });
    }));
    // -------- POST /jobs/:id/apply (multipart + resume -> GridFS) --------
    router.post("/jobs/:id/apply", upload.single("resume"), asyncHandler(async (req, res) => {
        const { id } = req.params;
        const job = await jobsCol.findOne({ id });
        if (!job)
            return res.status(404).json({ error: "Job not found" });
        const file = req.file;
        const body = req.body;
        const appDoc = {
            jobId: id,
            name: String(body.name || ""),
            email: String(body.email || ""),
            phone: body.phone || undefined,
            linkedin: body.linkedin || undefined,
            expYears: toNum(body.expYears),
            currentLocation: body.currentLocation || undefined,
            coverLetter: body.coverLetter || undefined,
            createdAt: new Date(),
        };
        if (!appDoc.name || !appDoc.email) {
            return res.status(400).json({ error: "name and email are required" });
        }
        if (file) {
            const bucket = getBucket(db);
            const fileId = await putBufferToGridFS(bucket, file.originalname, file.buffer, file.mimetype, {
                kind: "job-application",
                jobId: id,
                email: appDoc.email,
                name: appDoc.name,
            });
            appDoc.resumeFileId = fileId;
            appDoc.resumeFilename = file.originalname;
        }
        await appsCol.insertOne(appDoc);
        // Optional: notify HR via email / Slack here
        // await notifyHR(appDoc);
        res.json({ success: true });
    }));
    // -------- POST /resume (general resume drop) --------
    router.post("/resume", upload.single("resume"), asyncHandler(async (req, res) => {
        const file = req.file;
        const body = req.body;
        const doc = {
            name: String(body.name || ""),
            email: String(body.email || ""),
            phone: body.phone || undefined,
            targetDepartment: body.targetDepartment || undefined,
            roleTitle: body.roleTitle || undefined,
            linkedin: body.linkedin || undefined,
            portfolio: body.portfolio || undefined,
            coverLetter: body.coverLetter || undefined,
            createdAt: new Date(),
        };
        if (!doc.name || !doc.email) {
            return res.status(400).json({ error: "name and email are required" });
        }
        if (file) {
            const bucket = getBucket(db);
            const fileId = await putBufferToGridFS(bucket, file.originalname, file.buffer, file.mimetype, {
                kind: "general-resume",
                email: doc.email,
                name: doc.name,
            });
            doc.resumeFileId = fileId;
            doc.resumeFilename = file.originalname;
        }
        await resumeCol.insertOne(doc);
        res.json({ success: true });
    }));
    return router;
}
// ========================= How to mount =========================
// In your server bootstrap (e.g., app.ts):
// import registerCareersRoutes from "./routes/careers.routes";
// const careersRouter = registerCareersRoutes(db);
// app.use("/api/careers", careersRouter);
