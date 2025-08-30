// server/src/seedProducts.ts
import path from 'path';
import dotenv from 'dotenv';
import { MongoClient, ObjectId } from 'mongodb';

const envPath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: envPath });

(async () => {
  const uri = process.env.MONGO_URI;
  const dbName = process.env.MONGO_DB_NAME;
  if (!uri || !dbName) {
    console.error('Loaded .env from:', envPath);
    console.error('MONGO_URI =', process.env.MONGO_URI);
    console.error('MONGO_DB_NAME =', process.env.MONGO_DB_NAME);
    throw new Error('❌ MONGO_URI or MONGO_DB_NAME is not defined in .env');
  }

  const client = new MongoClient(uri);

  try {
    console.log('⏳ Connecting to MongoDB…', uri);
    await client.connect();
    const db = client.db(dbName);
    console.log(`✅ Connected to MongoDB (${db.databaseName})`);

    // Clean existing (safe to re-run)
    const delProducts = await db.collection('products').deleteMany({});
    const delVariants = await db.collection('product_variants').deleteMany({});
    console.log(`🧹 Cleared products: ${delProducts.deletedCount}, variants: ${delVariants.deletedCount}`);

    // ===== Purchasable SKUs =====
    // 1) essentials_bundle — forSale: true, contains 5 non-sale components
    // 2) algo_simulator — forSale: true, 3 variants below
    // 3) journaling_solo — forSale: true (NEW ✅), ₹999 / month
    const products = [
      {
        key: 'essentials_bundle',
        name: "Trader's Essential Bundle (5-in-1)",
        isActive: true,
        hasVariants: false,
        forSale: true,
        route: '/bundle',
        priceMonthly: 4999, // store price in DB
        components: [
          'technical_scanner',
          'fundamental_scanner',
          'fno_khazana',
          'journaling',          // stays as bundle component
          'fii_dii_data',
        ],
      },

      // --- Non-sale component products (not purchasable individually) ---
      { key: 'technical_scanner',   name: 'Technical Scanner',   isActive: true, hasVariants: false, forSale: false, route: '/technical' },
      { key: 'fundamental_scanner', name: 'Fundamental Scanner', isActive: true, hasVariants: false, forSale: false, route: '/fundamental' },
      { key: 'fno_khazana',         name: 'FNO Khazana',         isActive: true, hasVariants: false, forSale: false, route: '/fno' },
      { key: 'journaling',          name: 'Journaling',          isActive: true, hasVariants: false, forSale: false, route: '/journal' },
      { key: 'fii_dii_data',        name: 'FIIs/DIIs Data',      isActive: true, hasVariants: false, forSale: false, route: '/fii-dii' },

      // --- Purchasable ALGO product (variants below) ---
      { key: 'algo_simulator',      name: 'ALGO Simulator',      isActive: true, hasVariants: true,  forSale: true,  route: '/algo' },

      // --- NEW: Journaling (Solo) purchasable SKU ---
      {
        key: 'journaling_solo',
        name: 'Journaling (Solo)',
        isActive: true,
        hasVariants: false,
        forSale: true,              // visible in /products
        route: '/journal',
        priceMonthly: 299,          // ✅ ₹999 / month
      },
    ];

    const insertRes = await db.collection('products').insertMany(products);
    console.log(`📦 Inserted products: ${Object.keys(insertRes.insertedIds).length}`);

    const productsCount = await db.collection('products').countDocuments();
    console.log(`🔍 products count now: ${productsCount}`);
    if (productsCount < 8) throw new Error('❌ Expected 8 products (bundle + algo + journaling_solo + 5 components)');

    // Get the ALGO Simulator _id
    const algo = await db.collection('products').findOne({ key: 'algo_simulator' });
    if (!algo?._id) throw new Error('❌ Could not find ALGO Simulator after insert');

    // ----- Insert ALGO variants (monthly only) -----
    const variants = [
      {
        productId: new ObjectId(algo._id),
        key: 'starter',
        name: 'Starter Scalping',
        description: 'Beginner-friendly scalping suite',
        priceMonthly: 5999,
        interval: 'monthly',
        isActive: true,
      },
      {
        productId: new ObjectId(algo._id),
        key: 'pro',
        name: 'Option Scalper PRO',
        description: 'Advanced option scalping engine',
        priceMonthly: 14999,
        interval: 'monthly',
        isActive: true,
      },
      {
        productId: new ObjectId(algo._id),
        key: 'swing',
        name: 'Swing Trader Master',
        description: 'Swing trading strategy system',
        priceMonthly: 9999,
        interval: 'monthly',
        isActive: true,
      },
    ];

    await db.collection('product_variants').insertMany(variants);

    const variantsCount = await db.collection('product_variants').countDocuments({ productId: algo._id });
    console.log(`🔍 product_variants for ALGO count now: ${variantsCount}`);
    if (variantsCount < 3) throw new Error('❌ Expected 3 variants for ALGO after insert');

    // ----- Helpful indexes -----
    await db.collection('users').createIndex({ email: 1 }, { unique: true });
    await db.collection('products').createIndex({ key: 1 }, { unique: true });
    await db.collection('products').createIndex({ forSale: 1, isActive: 1 });
    await db.collection('product_variants').createIndex({ productId: 1, key: 1 }, { unique: true });
    await db.collection('user_products').createIndex({ userId: 1, productId: 1, variantId: 1 }, { unique: true });
    await db.collection('broker_configs').createIndex({ userId: 1, productId: 1, variantId: 1 }, { unique: true });

    console.log('🔧 Indexes ensured (users, products, product_variants, user_products, broker_configs).');
    console.log('✅ Seed complete.');
  } catch (err) {
    console.error('❌ Seeding failed:', err);
    process.exitCode = 1;
  } finally {
    await client.close();
    console.log('🔌 MongoDB connection closed.');
  }
})();