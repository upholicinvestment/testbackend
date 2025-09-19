import { Router, Request, Response } from "express";
import type { Db, Sort } from "mongodb";
import { ObjectId } from "mongodb";

type VoteMap = Record<string, number>;

export interface FeedbackDoc {
  userId?: string | null;

  title: string;
  details?: string;
  tags?: string[];

  votes: number;         // net votes
  voteUsers?: VoteMap;   // uid -> 1 | -1 to prevent multi votes
  comments: number;

  score: number;         // for trending/top sorts
  createdAt: number;     // epoch ms
  updatedAt: number;     // epoch ms
}

/* ----------------- sanitizers ----------------- */
function sanitizeTitle(x: any): string {
  const s = String(x ?? "").trim();
  if (s.length < 3) throw new Error("Title must be at least 3 characters.");
  if (s.length > 200) throw new Error("Title is too long (max 200).");
  return s;
}

function sanitizeDetails(x: any): string | undefined {
  const s = String(x ?? "").trim();
  return s.length ? s : undefined;
}

function sanitizeTags(x: any): string[] | undefined {
  if (Array.isArray(x)) {
    const t = x.map(v => String(v ?? "").trim().toLowerCase()).filter(Boolean).slice(0, 8);
    return t.length ? t : undefined;
  }
  const s = String(x ?? "")
    .split(",")
    .map(v => v.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 8);
  return s.length ? s : undefined;
}

/* ----------------- scoring ----------------- */
function computeScore(votes: number, comments: number, createdAt: number): number {
  const ageHours = Math.max(1, (Date.now() - createdAt) / 36e5); // hours
  // trending-ish: higher weight to votes, light time decay
  return (votes * 3 + comments) / Math.sqrt(ageHours);
}

/* ----------------- helpers ----------------- */
function getVoteDir(req: Request): "up" | "down" {
  // accepts ?dir=up|down and trailing ":1" / ":-1" (via :dir param)
  let raw =
    (req.query.dir as string | undefined) ??
    (req.params.dir as string | undefined) ??
    "";

  raw = String(raw).trim();
  if (raw.startsWith(":")) raw = raw.slice(1);

  if (raw === "1" || /^up/i.test(raw) || /^plus/i.test(raw)) return "up";
  if (raw === "-1" || /^down/i.test(raw) || /^minus/i.test(raw)) return "down";
  return "up";
}

function toDbId(id: string): any {
  // If your collection uses ObjectId (typical), convert when the string looks like one
  if (/^[0-9a-fA-F]{24}$/.test(id)) {
    try { return new ObjectId(id); } catch { /* fall through to string */ }
  }
  return id;
}

/* ================================================================ */
export default function registerFeedbackRoutes(db: Db): Router {
  const router = Router();
  const col = db.collection<FeedbackDoc>("feedback_items");

  /* ---------- GET /api/feedback ---------- */
  // /api/feedback?sort=trending|new|top&page=1&limit=20&tag=bug&search=foo
  router.get("/", async (req: Request, res: Response): Promise<void> => {
    try {
      const sortParam = String(req.query.sort ?? "trending").toLowerCase();
      const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
      const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "20"), 10) || 20));
      const tag = (req.query.tag ? String(req.query.tag) : "").trim().toLowerCase();
      const search = (req.query.search ? String(req.query.search) : "").trim();

      const filter: Record<string, any> = {};
      if (tag) filter.tags = tag;
      if (search) {
        filter.$or = [
          { title: { $regex: search, $options: "i" } },
          { details: { $regex: search, $options: "i" } },
        ];
      }

      let sortStage: Sort;
      switch (sortParam) {
        case "new":
          sortStage = { createdAt: -1 };
          break;
        case "top":
          sortStage = { votes: -1, createdAt: -1 };
          break;
        default: // trending
          sortStage = { score: -1, votes: -1, createdAt: -1 };
          break;
      }

      const cursor = col.find(filter).sort(sortStage).skip((page - 1) * limit).limit(limit);
      const items = await cursor.toArray();
      const total = await col.countDocuments(filter);

      res.json({
        items,
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Failed to load feedback." });
    }
  });

  /* ---------- POST /api/feedback ---------- */
  // body: { title, details?, tags? }  (public)
  router.post("/", async (req: Request, res: Response): Promise<void> => {
    try {
      const userId =
        ((req as any).user?.id as string | undefined) ||
        (req.query.userId as string | undefined) ||
        null;

      const title = sanitizeTitle(req.body?.title);
      const details = sanitizeDetails(req.body?.details);
      const tags = sanitizeTags(req.body?.tags);

      const now = Date.now();
      const doc: FeedbackDoc = {
        userId: userId ?? null,
        title,
        details,
        tags,
        votes: 0,
        voteUsers: {},
        comments: 0,
        score: 0,
        createdAt: now,
        updatedAt: now,
      };
      doc.score = computeScore(doc.votes, doc.comments, doc.createdAt);

      const result = await col.insertOne(doc);
      const created = await col.findOne({ _id: result.insertedId as any });
      res.status(201).json({ ok: true, item: created });
    } catch (e: any) {
      const msg = String(e?.message || "");
      const code = /title|tag|detail/i.test(msg) ? 400 : 500;
      res.status(code).json({ error: msg || "Failed to post feedback." });
    }
  });

  /* ---------- VOTE (supports both URL styles) ---------- */
  const voteHandler = async (req: Request, res: Response): Promise<void> => {
    try {
      const idStr = req.params.id;
      const id = toDbId(idStr);
      const dir = getVoteDir(req);
      const delta = dir === "down" ? -1 : 1;

      const uid =
        ((req as any).user?.id as string | undefined) ||
        (req.query.userId as string | undefined) ||
        null;

      const existing = await col.findOne({ _id: id } as any);
      if (!existing) { res.status(404).json({ error: "Item not found." }); return; }

      let votes = existing.votes ?? 0;
      const voteUsers = { ...(existing.voteUsers ?? {}) };

      if (uid) {
        const prev = voteUsers[uid] || 0;
        const nu = prev === delta ? 0 : delta; // toggle/switch
        votes = votes - prev + nu;
        if (nu === 0) delete voteUsers[uid];
        else voteUsers[uid] = nu;
      } else {
        votes += delta; // anonymous
      }

      const updatedAt = Date.now();
      const score = computeScore(votes, existing.comments ?? 0, existing.createdAt);

      await col.updateOne({ _id: id } as any, { $set: { votes, voteUsers, updatedAt, score } });
      const updated = await col.findOne({ _id: id } as any);

      res.json({ ok: true, item: updated });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Failed to update vote." });
    }
  };

  // Query-param style: /api/feedback/:id/vote?dir=up|down
  router.patch("/:id/vote", voteHandler);
  router.put("/:id/vote", voteHandler);

  // Trailing-colon style: /api/feedback/:id/vote:1  or vote:-1
  router.patch("/:id/vote:dir", voteHandler);
  router.put("/:id/vote:dir", voteHandler);

  /* ---------- POST /api/feedback/:id/comment ---------- */
  router.post("/:id/comment", async (req: Request, res: Response): Promise<void> => {
    try {
      const idStr = req.params.id;
      const id = toDbId(idStr);

      const text = String(req.body?.text ?? "").trim();
      if (!text) { res.status(400).json({ error: "Comment text is required." }); return; }

      const item = await col.findOne({ _id: id } as any);
      if (!item) { res.status(404).json({ error: "Item not found." }); return; }

      const comments = (item.comments ?? 0) + 1;
      const updatedAt = Date.now();
      const score = computeScore(item.votes ?? 0, comments, item.createdAt);

      await col.updateOne({ _id: id } as any, { $set: { comments, updatedAt, score } });
      const updated = await col.findOne({ _id: id } as any);

      res.json({ ok: true, item: updated });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "Failed to add comment." });
    }
  });

  return router;
}
