import type { Request, Response, RequestHandler } from "express";
import { Db, ObjectId } from "mongodb";
import jwt from "jsonwebtoken";

let db: Db | undefined;

/** Call this once after you connect to Mongo (in app bootstrap) */
export const setUserDatabase = (database: Db) => {
  db = database;
};

const requireDb = (): Db => {
  if (!db) {
    throw new Error("[user.controller] Database not initialized. Call setUserDatabase(db).");
  }
  return db;
};

const toObjectId = (id: string | ObjectId): ObjectId => {
  if (id instanceof ObjectId) return id;
  if (!ObjectId.isValid(id)) throw new Error("Invalid ObjectId");
  return new ObjectId(id);
};

/** Find userId in:
 * 1) req.user.id (if authenticate middleware ran)
 * 2) Authorization: Bearer <JWT> (fallback for PUBLIC_MODE)
 * 3) ?userId=<ObjectId>  (dev/testing)
 */
const getUserIdFromReq = (req: Request): ObjectId | null => {
  const u = (req as any).user;
  if (u?.id) {
    try { return toObjectId(u.id); } catch { /* ignore */ }
  }

  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ") && process.env.JWT_SECRET) {
    const token = auth.split(" ")[1];
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET) as { id?: string };
      if (decoded?.id) return toObjectId(decoded.id);
    } catch {
      /* ignore invalid tokens */
    }
  }

  const qpUserId = (req.query.userId as string) || "";
  if (qpUserId && ObjectId.isValid(qpUserId)) {
    return new ObjectId(qpUserId);
  }

  return null;
};

/** GET /api/users/me */
export const getProfile: RequestHandler = async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) {
      res.status(401).json({ message: "Not authorized" });
      return;
    }

    const _db = requireDb();
    const user = await _db.collection("users").findOne(
      { _id: userId },
      { projection: { password: 0 } }
    );

    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    res.json(user);
  } catch (err) {
    console.error("[users.getProfile] error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/** PUT /api/users/me  body: { name?: string, email?: string } */
export const updateProfile: RequestHandler = async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) {
      res.status(401).json({ message: "Not authorized" });
      return;
    }

    const { name, email } = (req.body ?? {}) as { name?: string; email?: string };
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

    if (email && email !== (existing as any).email) {
      const dup = await _db.collection("users").findOne({ email });
      if (dup) {
        res.status(400).json({ message: "Email already in use" });
        return;
      }
    }

    const $set: Record<string, any> = { updatedAt: new Date() };
    if (name) $set.name = name;
    if (email) $set.email = email;

    await _db.collection("users").updateOne({ _id: userId }, { $set });
    const fresh = await _db.collection("users").findOne(
      { _id: userId },
      { projection: { password: 0 } }
    );

    res.json(fresh);
  } catch (err) {
    console.error("[users.updateProfile] error:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/** GET /api/users/me/products  → returns active entitlements */
export const getMyProducts: RequestHandler = async (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromReq(req);
    if (!userId) {
      res.status(401).json({ message: "Not authorized" });
      return;
    }

    const _db = requireDb();

    const now = new Date();
    const entitlements = await _db
      .collection("user_products")
      .find({
        userId,
        status: "active",
        $or: [{ endsAt: null }, { endsAt: { $gt: now } }],
      })
      .project({ productId: 1, variantId: 1, status: 1, startedAt: 1, endsAt: 1 })
      .toArray();

    if (!entitlements.length) {
      res.json({ items: [] });
      return;
    }

    const productIds = Array.from(
      new Set(entitlements.map((e: any) => (e.productId as ObjectId).toString()))
    ).map((s) => new ObjectId(s));

    const products = await _db
      .collection("products")
      .find({ _id: { $in: productIds }, isActive: true })
      .project({ key: 1, name: 1, route: 1, hasVariants: 1, forSale: 1 })
      .toArray();

    const productMap = new Map<string, any>();
    products.forEach((p: any) => productMap.set((p._id as ObjectId).toString(), p));

    const variantIds = Array.from(
      new Set(
        entitlements
          .map((e: any) => e.variantId)
          .filter((v: any) => v && ObjectId.isValid(v))
          .map((v: any) => v.toString())
      )
    ).map((s) => new ObjectId(s));

    let variantMap = new Map<string, any>();
    if (variantIds.length) {
      const variants = await _db
        .collection("product_variants")
        .find({ _id: { $in: variantIds }, isActive: true })
        .project({ key: 1, name: 1, priceMonthly: 1, interval: 1, productId: 1 })
        .toArray();

      variantMap = new Map<string, any>();
      variants.forEach((v: any) => variantMap.set((v._id as ObjectId).toString(), v));
    }

    const items = entitlements
      .map((e: any) => {
        const pid = (e.productId as ObjectId).toString();
        const vid = e.variantId ? (e.variantId as ObjectId).toString() : null;
        const p = productMap.get(pid);
        if (!p) return null;

        const v = vid ? variantMap.get(vid) : null;

        return {
          productId: p._id,
          key: p.key as string,
          name: p.name as string,
          route: p.route as string,
          hasVariants: !!p.hasVariants,
          forSale: !!p.forSale,
          status: e.status as string,
          startedAt: e.startedAt ?? null,
          endsAt: e.endsAt ?? null,
          variant: v
            ? {
                variantId: v._id,
                key: v.key as string,
                name: v.name as string,
                priceMonthly: v.priceMonthly ?? null,
                interval: v.interval ?? null,
              }
            : null,
        };
      })
      .filter(Boolean);

    res.json({ items });
  } catch (err) {
    console.error("[users.getMyProducts] error:", err);
    res.status(500).json({ message: "Server error" });
  }
};
