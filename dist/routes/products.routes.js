"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.setProductsDb = void 0;
const express_1 = require("express");
const auth_controller_1 = require("../controllers/auth.controller");
let db;
const setProductsDb = (database) => {
    db = database;
    (0, auth_controller_1.setDatabase)(database);
};
exports.setProductsDb = setProductsDb;
const router = (0, express_1.Router)();
router.get('/', async (_req, res) => {
    try {
        // Only return purchasable products (bundle + algo)
        const products = await db
            .collection('products')
            .find({ isActive: true, forSale: true })
            .toArray();
        const withVariants = products.filter((p) => p.hasVariants);
        const ids = withVariants.map((p) => p._id);
        const variants = ids.length
            ? await db
                .collection('product_variants')
                .find({ productId: { $in: ids }, isActive: true })
                .toArray()
            : [];
        const variantMap = {};
        variants.forEach((v) => {
            const pid = v.productId.toString();
            (variantMap[pid] ||= []).push(v);
        });
        res.json(products.map((p) => ({
            ...p,
            variants: p.hasVariants ? (variantMap[p._id.toString()] || []) : [],
        })));
    }
    catch (e) {
        console.error('products.routes error:', e);
        res.status(500).json({ message: 'Failed to load products' });
    }
});
exports.default = router;
