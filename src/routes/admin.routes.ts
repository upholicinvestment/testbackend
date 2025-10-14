// src/routes/admin.routes.ts
import { Router, type RequestHandler } from "express";
import type { Db } from "mongodb";
import { ObjectId as _ObjectId } from "mongodb";
import { authenticate, authorize } from "../middleware/auth.middleware";

/** Small helper to make async handlers type-safe on older @types/express */
const asyncHandler =
  (fn: (req: Parameters<RequestHandler>[0], res: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2]) => Promise<any>): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

/**
 * Mount with: app.use("/api/admin", registerAdminRoutes(db));
 * Guarded by authenticate + authorize("admin","superuser")
 */
export default function registerAdminRoutes(db: Db) {
  const r = Router();

  // middleware guards
  r.use(authenticate, authorize("admin", "superuser"));

  // GET /api/admin/overview  -> quick counts
  r.get(
    "/overview",
    asyncHandler(async (_req, res) => {
      const [users, activeSubs, products] = await Promise.all([
        db.collection("users").countDocuments({}),
        db.collection("user_products").countDocuments({ status: "active", endsAt: { $gt: new Date() } }),
        db.collection("products").countDocuments({}),
      ]);
      res.json({ users, activeSubs, products });
    })
  );

  // GET /api/admin/users?q=&page=&pageSize=
  r.get(
    "/users",
    asyncHandler(async (req, res) => {
      const page = Math.max(parseInt(String(req.query.page || 1)), 1);
      const pageSize = Math.min(Math.max(parseInt(String(req.query.pageSize || 20)), 1), 100);
      const q = String(req.query.q || "").trim();
      const rx = q ? new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : null;

      const match = rx ? { $or: [{ email: rx }, { name: rx }, { phone: rx }] } : {};
      const pipeline: any[] = [
        { $match: match },
        {
          $lookup: {
            from: "user_products",
            localField: "_id",
            foreignField: "userId",
            as: "purchases",
          },
        },
        {
          $lookup: {
            from: "products",
            localField: "purchases.productId",
            foreignField: "_id",
            as: "prodDocs",
          },
        },
        {
          $addFields: {
            purchases: {
              $map: {
                input: "$purchases",
                as: "p",
                in: {
                  _id: "$$p._id",
                  productId: "$$p.productId",
                  status: "$$p.status",
                  startedAt: "$$p.startedAt",
                  endsAt: "$$p.endsAt",
                  productKey: {
                    $let: {
                      vars: {
                        prod: {
                          $first: {
                            $filter: {
                              input: "$prodDocs",
                              cond: { $eq: ["$$this._id", "$$p.productId"] },
                            },
                          },
                        },
                      },
                      in: "$$prod.key",
                    },
                  },
                  productName: {
                    $let: {
                      vars: {
                        prod: {
                          $first: {
                            $filter: {
                              input: "$prodDocs",
                              cond: { $eq: ["$$this._id", "$$p.productId"] },
                            },
                          },
                        },
                      },
                      in: "$$prod.name",
                    },
                  },
                },
              },
            },
          },
        },
        { $project: { password: 0, prodDocs: 0 } },
        { $sort: { createdAt: -1 } },
        { $skip: (page - 1) * pageSize },
        { $limit: pageSize },
      ];

      const [items, total] = await Promise.all([
        db.collection("users").aggregate(pipeline).toArray(),
        db.collection("users").countDocuments(match),
      ]);

      res.json({ items, page, pageSize, total });
    })
  );

  // GET /api/admin/renewals?days=14
  r.get(
    "/renewals",
    asyncHandler(async (req, res) => {
      const days = Math.max(parseInt(String(req.query.days || 14)), 1);
      const now = new Date();
      const until = new Date(now.getTime() + days * 24 * 3600 * 1000);

      const items = await db
        .collection("user_products")
        .aggregate([
          { $match: { status: "active", endsAt: { $gt: now, $lte: until } } },
          { $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "user" } },
          { $lookup: { from: "products", localField: "productId", foreignField: "_id", as: "product" } },
          { $unwind: "$user" },
          { $unwind: "$product" },
          {
            $project: {
              _id: 1,
              endsAt: 1,
              status: 1,
              user: { _id: 1, email: 1, name: 1, phone: 1 },
              product: { _id: 1, key: 1, name: 1 },
            },
          },
          { $sort: { endsAt: 1 } },
        ])
        .toArray();

      res.json({ items, from: now, until });
    })
  );

  // POST /api/admin/grant  -> comp a product quickly (default 365 days)
  r.post(
    "/grant",
    asyncHandler(async (req, res) => {
      const { userId, productKey, days } = req.body as { userId: string; productKey: string; days?: number };
      if (!userId || !productKey) {
        res.status(400).json({ message: "userId and productKey required" });
        return;
      }

      const _id = _ObjectId.isValid(userId) ? new _ObjectId(userId) : null;
      if (!_id) {
        res.status(400).json({ message: "Invalid userId" });
        return;
      }

      const [user, product] = await Promise.all([
        db.collection("users").findOne({ _id }),
        db.collection("products").findOne({ key: productKey }),
      ]);

      if (!user) {
        res.status(404).json({ message: "User not found" });
        return;
      }
      if (!product) {
        res.status(404).json({ message: "Product not found" });
        return;
      }

      const now = new Date();
      const endsAt = new Date(now.getTime() + (days || 365) * 24 * 3600 * 1000);

      await db.collection("user_products").updateOne(
        { userId: _id, productId: product._id },
        {
          $set: {
            status: "active",
            startedAt: now,
            endsAt,
            meta: { source: "comp" },
          },
        },
        { upsert: true }
      );

      res.json({ ok: true, message: `Granted ${productKey} to ${(user as any).email} until ${endsAt.toISOString()}` });
    })
  );

  return r;
}
