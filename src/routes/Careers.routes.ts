// import express, { Request, Response, NextFunction } from "express";
// import type { Db, GridFSBucket, ObjectId } from "mongodb";
// import { GridFSBucket as GFBB } from "mongodb";
// import multer from "multer";
// import { once } from "events";

// /**
//  * Careers Routes (MongoDB native driver, no Mongoose)
//  *
//  * Endpoints
//  * ---------
//  * GET    /api/careers/jobs                  -> list jobs (optionally filter by q, dept, loc, expMax)
//  * POST   /api/careers/jobs                  -> create a job (admin)
//  * PUT    /api/careers/jobs/:id              -> update a job (admin)
//  * DELETE /api/careers/jobs/:id              -> delete a job (admin)
//  * POST   /api/careers/jobs/:id/save         -> save/unsave job for a user
//  * POST   /api/careers/jobs/:id/apply        -> apply to a job (multipart form + resume -> GridFS)
//  * POST   /api/careers/resume                -> send general resume (no specific job)
//  */

// // ========================= Types =========================
// export type CareerJob = {
//   id: string; // human or slug id (e.g., "fe", "be", etc.)
//   iconKey?: string; // maps to UI icon (code, backend, devops, quant, design, product, sales, marketing, tele)
//   title: string;
//   department: string; // Engineering, Research, Design, Product, Growth, etc.
//   locations: string[];
//   experience: { min: number; max: number };
//   type: string; // Full-time, Contract, etc.
//   posted: string; // free text like "7 days ago" or an ISO date string
//   description: string;
//   mustHave?: string[];
//   niceToHave?: string[];
//   responsibilities?: string[];
//   createdAt: Date;
//   updatedAt: Date;
// };

// export type JobApplication = {
//   jobId: string;
//   name: string;
//   email: string;
//   phone?: string;
//   linkedin?: string;
  
//   expYears?: number;
//   currentLocation?: string;
  
//   coverLetter?: string;
//   resumeFileId?: ObjectId;
//   resumeFilename?: string;
//   createdAt: Date;
// };

// export type GeneralResume = {
//   name: string;
//   email: string;
//   phone?: string;
//   targetDepartment?: string;
//   roleTitle?: string;
//   linkedin?: string;
//   portfolio?: string;
//   coverLetter?: string;
//   resumeFileId?: ObjectId;
//   resumeFilename?: string;
//   createdAt: Date;
// };

// // ========================= Utils =========================
// function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
//   return (req: Request, res: Response, next: NextFunction) =>
//     Promise.resolve(fn(req, res, next)).catch(next);
// }

// function toNum(n: any) {
//   if (n === undefined || n === null || n === "") return undefined;
//   const x = Number(n);
//   return Number.isFinite(x) ? x : undefined;
// }

// function pick<T extends object>(obj: any, keys: (keyof T)[]): Partial<T> {
//   const out: any = {};
//   keys.forEach((k) => {
//     if (obj[k] !== undefined) out[k] = obj[k];
//   });
//   return out;
// }

// const upload = multer({
//   storage: multer.memoryStorage(),
//   limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
// });

// function getBucket(db: Db): GridFSBucket {
//   // Dedicated bucket named "resumes" → collections: resumes.files / resumes.chunks
//   return new GFBB(db, { bucketName: "resumes" });
// }

// async function putBufferToGridFS(bucket: GridFSBucket, filename: string, buf: Buffer, contentType?: string, metadata?: Record<string, any>) {
//   const stream = bucket.openUploadStream(filename, { contentType, metadata });
//   stream.end(buf);
//   await once(stream, "finish");
//   return stream.id as ObjectId;
// }

// // ========================= Router =========================
// export default function registerCareersRoutes(db: Db) {
//   const router = express.Router();

//   const jobsCol = db.collection<CareerJob>("careers_jobs");
//   const savedCol = db.collection("careers_saved"); // { userId, email?, jobId, createdAt }
//   const appsCol = db.collection<JobApplication>("careers_applications");
//   const resumeCol = db.collection<GeneralResume>("careers_resumes");

//   // Ensure helpful indexes (won't throw if they already exist)
//   jobsCol.createIndex({ id: 1 }, { unique: true }).catch(() => {});
//   savedCol.createIndex({ userId: 1, jobId: 1 }, { unique: true }).catch(() => {});
//   appsCol.createIndex({ jobId: 1, email: 1, createdAt: -1 }).catch(() => {});
//   resumeCol.createIndex({ email: 1, createdAt: -1 }).catch(() => {});

//   // -------- GET /jobs (list + optional filters) --------
//   router.get(
//     "/jobs",
//     asyncHandler(async (req, res) => {
//       const { q, dept, loc, expMax } = req.query as Record<string, string | undefined>;

//       const filter: any = {};
//       if (dept && dept !== "All") filter.department = dept;
//       if (loc && loc !== "All") filter.locations = { $in: [loc] };
//       if (expMax) filter["experience.min"] = { $lte: Number(expMax) };

//       // q matches across key text fields
//       if (q && q.trim()) {
//         const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
//         filter.$or = [
//           { title: rx },
//           { department: rx },
//           { description: rx },
//           { mustHave: rx },
//           { niceToHave: rx },
//           { locations: rx },
//         ];
//       }

//       const docs = await jobsCol
//         .find(filter)
//         .sort({ createdAt: -1 })
//         .project({ _id: 0 })
//         .toArray();

//       res.json(docs);
//     })
//   );

//   // -------- POST /jobs (create) [admin] --------
//   router.post(
//     "/jobs",
//     asyncHandler(async (req, res) => {
//       const now = new Date();
//       const body = req.body as Partial<CareerJob>;
//       if (!body.id || !body.title || !body.department) {
//         return res.status(400).json({ error: "id, title, department are required" });
//       }
//       const doc: CareerJob = {
//         id: String(body.id),
//         iconKey: body.iconKey || "code",
//         title: String(body.title),
//         department: String(body.department),
//         locations: Array.isArray(body.locations) ? (body.locations as string[]) : ["Remote"],
//         experience: body.experience || { min: 0, max: 10 },
//         type: body.type || "Full-time",
//         posted: body.posted || new Date().toISOString(),
//         description: body.description || "",
//         mustHave: body.mustHave || [],
//         niceToHave: body.niceToHave || [],
//         responsibilities: body.responsibilities || [],
//         createdAt: now,
//         updatedAt: now,
//       };

//       await jobsCol.insertOne(doc);
//       res.json({ success: true, job: doc });
//     })
//   );

//   // -------- PUT /jobs/:id (update) [admin] --------
//   router.put(
//     "/jobs/:id",
//     asyncHandler(async (req, res) => {
//       const { id } = req.params;
//       const payload = req.body as Partial<CareerJob>;

//       const $set: any = pick<CareerJob>(payload, [
//         "iconKey",
//         "title",
//         "department",
//         "locations",
//         "experience",
//         "type",
//         "posted",
//         "description",
//         "mustHave",
//         "niceToHave",
//         "responsibilities",
//       ]);
//       $set.updatedAt = new Date();

//       const result = await jobsCol.updateOne({ id }, { $set });
//       if (!result.matchedCount) return res.status(404).json({ error: "Job not found" });
//       res.json({ success: true });
//     })
//   );

//   // -------- DELETE /jobs/:id (delete) [admin] --------
//   router.delete(
//     "/jobs/:id",
//     asyncHandler(async (req, res) => {
//       const { id } = req.params;
//       const result = await jobsCol.deleteOne({ id });
//       if (!result.deletedCount) return res.status(404).json({ error: "Job not found" });
//       res.json({ success: true });
//     })
//   );

//   // -------- POST /jobs/:id/save (toggle save for user) --------
//   router.post(
//     "/jobs/:id/save",
//     asyncHandler(async (req, res) => {
//       const { id } = req.params;
//       const { saved, userId, email } = req.body as { saved?: boolean; userId?: string; email?: string };

//       const job = await jobsCol.findOne({ id });
//       if (!job) return res.status(404).json({ error: "Job not found" });

//       // Choose the identifier you use in your app (JWT user id, email, etc.)
//       const owner = userId || email || "anonymous";
//       const key = { userId: owner, jobId: id };

//       if (saved) {
//         await savedCol.updateOne(
//           key,
//           { $set: { ...key, createdAt: new Date() } },
//           { upsert: true }
//         );
//       } else {
//         await savedCol.deleteOne(key);
//       }
//       res.json({ success: true });
//     })
//   );

//   // -------- POST /jobs/:id/apply (multipart + resume -> GridFS) --------
//   router.post(
//     "/jobs/:id/apply",
//     upload.single("resume"),
//     asyncHandler(async (req, res) => {
//       const { id } = req.params;
//       const job = await jobsCol.findOne({ id });
//       if (!job) return res.status(404).json({ error: "Job not found" });

//       const file = (req as any).file as Express.Multer.File | undefined;
//       const body = req.body as any;

//       const appDoc: JobApplication = {
//         jobId: id,
//         name: String(body.name || ""),
//         email: String(body.email || ""),
//         phone: body.phone || undefined,
//         linkedin: body.linkedin || undefined,
        
//         expYears: toNum(body.expYears),
//         currentLocation: body.currentLocation || undefined,
        
//         coverLetter: body.coverLetter || undefined,
//         createdAt: new Date(),
//       };

//       if (!appDoc.name || !appDoc.email) {
//         return res.status(400).json({ error: "name and email are required" });
//       }

//       if (file) {
//         const bucket = getBucket(db);
//         const fileId = await putBufferToGridFS(bucket, file.originalname, file.buffer, file.mimetype, {
//           kind: "job-application",
//           jobId: id,
//           email: appDoc.email,
//           name: appDoc.name,
//         });
//         appDoc.resumeFileId = fileId;
//         appDoc.resumeFilename = file.originalname;
//       }

//       await appsCol.insertOne(appDoc);

//       // Optional: notify HR via email / Slack here
//       // await notifyHR(appDoc);

//       res.json({ success: true });
//     })
//   );

//   // -------- POST /resume (general resume drop) --------
//   router.post(
//     "/resume",
//     upload.single("resume"),
//     asyncHandler(async (req, res) => {
//       const file = (req as any).file as Express.Multer.File | undefined;
//       const body = req.body as any;

//       const doc: GeneralResume = {
//         name: String(body.name || ""),
//         email: String(body.email || ""),
//         phone: body.phone || undefined,
//         targetDepartment: body.targetDepartment || undefined,
//         roleTitle: body.roleTitle || undefined,
//         linkedin: body.linkedin || undefined,
//         portfolio: body.portfolio || undefined,
//         coverLetter: body.coverLetter || undefined,
//         createdAt: new Date(),
//       };

//       if (!doc.name || !doc.email) {
//         return res.status(400).json({ error: "name and email are required" });
//       }

//       if (file) {
//         const bucket = getBucket(db);
//         const fileId = await putBufferToGridFS(bucket, file.originalname, file.buffer, file.mimetype, {
//           kind: "general-resume",
//           email: doc.email,
//           name: doc.name,
//         });
//         doc.resumeFileId = fileId;
//         doc.resumeFilename = file.originalname;
//       }

//       await resumeCol.insertOne(doc);
//       res.json({ success: true });
//     })
//   );

//   return router;
// }

// // ========================= How to mount =========================
// // In your server bootstrap (e.g., app.ts):
// // import registerCareersRoutes from "./routes/careers.routes";
// // const careersRouter = registerCareersRoutes(db);
// // app.use("/api/careers", careersRouter);
// src/routes/careers.routes.ts
import express, { Request, Response, NextFunction } from "express";
import type { Db, GridFSBucket, ObjectId } from "mongodb";
import { GridFSBucket as GFBB, ObjectId as OID } from "mongodb";
import multer from "multer";
import { once } from "events";

/**
 * Careers Routes (MongoDB native driver, no Mongoose)
 *
 * Endpoints
 * ---------
 * PUBLIC:
 * GET    /api/careers/jobs                  -> list jobs (optionally filter by q, dept, loc, expMax)
 * POST   /api/careers/jobs                  -> create a job (admin)
 * PUT    /api/careers/jobs/:id              -> update a job (admin)
 * DELETE /api/careers/jobs/:id              -> delete a job (admin)
 * POST   /api/careers/jobs/:id/save         -> save/unsave job for a user
 * POST   /api/careers/jobs/:id/apply        -> apply to a job (multipart form + resume -> GridFS)
 * POST   /api/careers/resume                -> send general resume (no specific job)
 *
 * ADMIN (added):
 * GET    /api/careers/admin/applications    -> list job applications (paginated, search)
 * GET    /api/careers/admin/resumes         -> list general resumes (paginated, search)
 * GET    /api/careers/admin/resume/:kind/:fileId
 *          kind: "applications" | "resumes" | "career_applications" | "career_resume"
 *          streams GridFS resume (inline by default, ?download=1 to download)
 */

// ========================= Types =========================
export type CareerJob = {
  id: string; // human or slug id (e.g., "fe", "be", etc.)
  iconKey?: string; // maps to UI icon (code, backend, devops, quant, design, product, sales, marketing, tele)
  title: string;
  department: string; // Engineering, Research, Design, Product, Growth, etc.
  locations: string[];
  experience: { min: number; max: number };
  type: string; // Full-time, Contract, etc.
  posted: string; // free text like "7 days ago" or an ISO date string
  description: string;
  mustHave?: string[];
  niceToHave?: string[];
  responsibilities?: string[];
  createdAt: Date;
  updatedAt: Date;
};

export type JobApplication = {
  jobId: string;
  name: string;
  email: string;
  phone?: string;
  linkedin?: string;

  expYears?: number;
  currentLocation?: string;

  coverLetter?: string;
  resumeFileId?: ObjectId;
  resumeFilename?: string;
  createdAt: Date;
};

export type GeneralResume = {
  name: string;
  email: string;
  phone?: string;
  targetDepartment?: string;
  roleTitle?: string;
  linkedin?: string;
  portfolio?: string;
  coverLetter?: string;
  resumeFileId?: ObjectId;
  resumeFilename?: string;
  createdAt: Date;
};

// ========================= Utils =========================
function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);
}

function toNum(n: any) {
  if (n === undefined || n === null || n === "") return undefined;
  const x = Number(n);
  return Number.isFinite(x) ? x : undefined;
}

function pick<T extends object>(obj: any, keys: (keyof T)[]): Partial<T> {
  const out: any = {};
  keys.forEach((k) => {
    if (obj[k] !== undefined) out[k] = obj[k];
  });
  return out;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

function getBucket(db: Db): GridFSBucket {
  // Dedicated bucket named "resumes" → collections: resumes.files / resumes.chunks
  return new GFBB(db, { bucketName: "resumes" });
}

async function putBufferToGridFS(
  bucket: GridFSBucket,
  filename: string,
  buf: Buffer,
  contentType?: string,
  metadata?: Record<string, any>
) {
  const stream = bucket.openUploadStream(filename, { contentType, metadata });
  stream.end(buf);
  await once(stream, "finish");
  return stream.id as ObjectId;
}

// ========================= Router =========================
export default function registerCareersRoutes(db: Db) {
  const router = express.Router();

  const jobsCol = db.collection<CareerJob>("careers_jobs");
  const savedCol = db.collection("careers_saved"); // { userId, email?, jobId, createdAt }
  const appsCol = db.collection<JobApplication>("careers_applications");
  const resumeCol = db.collection<GeneralResume>("careers_resumes");

  // Ensure helpful indexes (won't throw if they already exist)
  jobsCol.createIndex({ id: 1 }, { unique: true }).catch(() => {});
  savedCol.createIndex({ userId: 1, jobId: 1 }, { unique: true }).catch(() => {});
  appsCol.createIndex({ jobId: 1, email: 1, createdAt: -1 }).catch(() => {});
  resumeCol.createIndex({ email: 1, createdAt: -1 }).catch(() => {});

  // -------- GET /jobs (list + optional filters) --------
  router.get(
    "/jobs",
    asyncHandler(async (req, res) => {
      const { q, dept, loc, expMax } = req.query as Record<string, string | undefined>;

      const filter: any = {};
      if (dept && dept !== "All") filter.department = dept;
      if (loc && loc !== "All") filter.locations = { $in: [loc] };
      if (expMax) filter["experience.min"] = { $lte: Number(expMax) };

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
    })
  );

  // -------- POST /jobs (create) [admin] --------
  router.post(
    "/jobs",
    asyncHandler(async (req, res) => {
      const now = new Date();
      const body = req.body as Partial<CareerJob>;
      if (!body.id || !body.title || !body.department) {
        return res.status(400).json({ error: "id, title, department are required" });
      }
      const doc: CareerJob = {
        id: String(body.id),
        iconKey: body.iconKey || "code",
        title: String(body.title),
        department: String(body.department),
        locations: Array.isArray(body.locations) ? (body.locations as string[]) : ["Remote"],
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
    })
  );

  // -------- PUT /jobs/:id (update) [admin] --------
  router.put(
    "/jobs/:id",
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const payload = req.body as Partial<CareerJob>;

      const $set: any = pick<CareerJob>(payload, [
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
      if (!result.matchedCount) return res.status(404).json({ error: "Job not found" });
      res.json({ success: true });
    })
  );

  // -------- DELETE /jobs/:id (delete) [admin] --------
  router.delete(
    "/jobs/:id",
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const result = await jobsCol.deleteOne({ id });
      if (!result.deletedCount) return res.status(404).json({ error: "Job not found" });
      res.json({ success: true });
    })
  );

  // -------- POST /jobs/:id/save (toggle save for user) --------
  router.post(
    "/jobs/:id/save",
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const { saved, userId, email } = req.body as { saved?: boolean; userId?: string; email?: string };

      const job = await jobsCol.findOne({ id });
      if (!job) return res.status(404).json({ error: "Job not found" });

      // Choose the identifier you use in your app (JWT user id, email, etc.)
      const owner = userId || email || "anonymous";
      const key = { userId: owner, jobId: id };

      if (saved) {
        await savedCol.updateOne(
          key,
          { $set: { ...key, createdAt: new Date() } },
          { upsert: true }
        );
      } else {
        await savedCol.deleteOne(key);
      }
      res.json({ success: true });
    })
  );

  // -------- POST /jobs/:id/apply (multipart + resume -> GridFS) --------
  router.post(
    "/jobs/:id/apply",
    upload.single("resume"),
    asyncHandler(async (req, res) => {
      const { id } = req.params;
      const job = await jobsCol.findOne({ id });
      if (!job) return res.status(404).json({ error: "Job not found" });

      const file = (req as any).file as Express.Multer.File | undefined;
      const body = req.body as any;

      const appDoc: JobApplication = {
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

      res.json({ success: true });
    })
  );

  // -------- POST /resume (general resume drop) --------
  router.post(
    "/resume",
    upload.single("resume"),
    asyncHandler(async (req, res) => {
      const file = (req as any).file as Express.Multer.File | undefined;
      const body = req.body as any;

      const doc: GeneralResume = {
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
    })
  );

  // ========= ADMIN ENDPOINTS (list + stream resumes) =========

  // GET /api/careers/admin/applications?page=&pageSize=&q=
  router.get(
    "/admin/applications",
    asyncHandler(async (req, res) => {
      const page = Math.max(parseInt(String(req.query.page || "1"), 10) || 1, 1);
      const pageSize = Math.min(Math.max(parseInt(String(req.query.pageSize || "20"), 10) || 20, 1), 100);
      const q = String(req.query.q || "").trim();

      const filter: any = {};
      if (q) {
        const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ name: rx }, { email: rx }, { phone: rx }, { jobId: rx }, { linkedin: rx }];
      }

      const total = await appsCol.countDocuments(filter);
      const itemsRaw = await appsCol
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray();

      const items = itemsRaw.map((d) => ({
        _id: String(d._id),
        jobId: d.jobId,
        name: d.name,
        email: d.email,
        phone: d.phone,
        linkedin: d.linkedin,
        expYears: d.expYears,
        currentLocation: d.currentLocation,
        coverLetter: d.coverLetter,
        createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : d.createdAt,
        resumeFileId: d.resumeFileId ? String(d.resumeFileId) : undefined,
        resumeFilename: d.resumeFilename,
      }));

      res.json({ items, page, pageSize, total });
    })
  );

  // GET /api/careers/admin/resumes?page=&pageSize=&q=
  router.get(
    "/admin/resumes",
    asyncHandler(async (req, res) => {
      const page = Math.max(parseInt(String(req.query.page || "1"), 10) || 1, 1);
      const pageSize = Math.min(Math.max(parseInt(String(req.query.pageSize || "20"), 10) || 20, 1), 100);
      const q = String(req.query.q || "").trim();

      const filter: any = {};
      if (q) {
        const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [
          { name: rx },
          { email: rx },
          { phone: rx },
          { targetDepartment: rx },
          { roleTitle: rx },
          { linkedin: rx },
        ];
      }

      const total = await resumeCol.countDocuments(filter);
      const itemsRaw = await resumeCol
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray();

      const items = itemsRaw.map((d) => ({
        _id: String(d._id),
        name: d.name,
        email: d.email,
        phone: d.phone,
        targetDepartment: d.targetDepartment,
        roleTitle: d.roleTitle,
        linkedin: d.linkedin,
        createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : d.createdAt,
        resumeFileId: d.resumeFileId ? String(d.resumeFileId) : undefined,
        resumeFilename: d.resumeFilename,
      }));

      res.json({ items, page, pageSize, total });
    })
  );

  // GET /api/careers/admin/resume/:kind/:fileId
  // kind accepts "applications" | "resumes" | legacy "career_applications" | "career_resume"
  router.get(
    "/admin/resume/:kind/:fileId",
    asyncHandler(async (req, res) => {
      const { kind, fileId } = req.params;

      const K = (kind || "").toLowerCase();
      const allowed = new Set(["applications", "resumes", "career_applications", "career_resume", "career_resumes"]);
      if (!allowed.has(K)) return res.status(400).json({ error: "Invalid kind" });

      let oid: InstanceType<typeof OID>;
      try {
        oid = new OID(fileId);
      } catch {
        return res.status(400).json({ error: "Invalid fileId" });
      }

      const bucket = getBucket(db);
      const fileDoc = await bucket.find({ _id: oid }).limit(1).next();
      if (!fileDoc) return res.status(404).json({ error: "File not found" });

      const contentType = fileDoc.contentType || "application/octet-stream";
      const filename = fileDoc.filename || "resume.pdf";
      const disposition = String(req.query.download || "") === "1" ? "attachment" : "inline";

      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`);

      const dl = bucket.openDownloadStream(oid);
      dl.on("error", () => {
        if (!res.headersSent) res.status(404).end();
      });
      dl.pipe(res);
    })
  );

  return router;
}

// ========================= How to mount =========================
// In your server bootstrap (e.g., app.ts):
// import registerCareersRoutes from "./routes/careers.routes";
// const careersRouter = registerCareersRoutes(db);
// app.use("/api/careers", careersRouter);
