import path from 'path';
import dotenv from 'dotenv';
import { MongoClient, ObjectId } from 'mongodb';

// Load .env explicitly from project root (adjust if your layout differs)
const envPath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: envPath });

(async () => {
  const uri = process.env.MONGO_URI;          // matches your .env
  const dbName = process.env.MONGO_DB_NAME;   // matches your .env

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

    // ----- Insert 6 product families -----
    const products = [
      { key: 'technical_scanner',   name: 'Technical Scanner',   isActive: true, hasVariants: false, route: '/technical' },
      { key: 'fundamental_scanner', name: 'Fundamental Scanner', isActive: true, hasVariants: false, route: '/fundamental' },
      { key: 'algo_simulator',      name: 'ALGO Simulator',      isActive: true, hasVariants: true,  route: '/algo' },
      { key: 'fno_khazana',         name: 'FNO Khazana',         isActive: true, hasVariants: false, route: '/fno' },
      { key: 'journaling',          name: 'Journaling',          isActive: true, hasVariants: false, route: '/journal' },
      { key: 'fii_dii_data',        name: 'FIIs/DIIs Data',      isActive: true, hasVariants: false, route: '/fii-dii' },
    ];

    const insertRes = await db.collection('products').insertMany(products);
    console.log(`📦 Inserted products: ${Object.keys(insertRes.insertedIds).length}`);

    const productsCount = await db.collection('products').countDocuments();
    console.log(`🔍 products count now: ${productsCount}`);
    if (productsCount < 6) throw new Error('❌ Expected 6 products after insert');

    // Get the ALGO Simulator _id
    const algo = await db.collection('products').findOne({ key: 'algo_simulator' });
    if (!algo?._id) throw new Error('❌ Could not find ALGO Simulator after insert');

    // ----- Insert ALGO variants (monthly only) -----
    const variants = [
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
        priceMonthly: 99999,
        interval: 'monthly',
        isActive: true,
      },
      {
        productId: new ObjectId(algo._id),
        key: 'starter',
        name: 'Starter Scalping',
        description: 'Beginner-friendly scalping suite',
        priceMonthly: 5999,
        interval: 'monthly',
        isActive: true,
      },
    ];

    const varRes = await db.collection('product_variants').insertMany(variants);
    console.log(`🧩 Inserted variants: ${Object.keys(varRes.insertedIds).length}`);

    const variantsCount = await db.collection('product_variants').countDocuments({ productId: algo._id });
    console.log(`🔍 product_variants for ALGO count now: ${variantsCount}`);
    if (variantsCount < 3) throw new Error('❌ Expected 3 variants for ALGO after insert');

    // ----- Helpful indexes -----
    await db.collection('users').createIndex({ email: 1 }, { unique: true });
    await db.collection('products').createIndex({ key: 1 }, { unique: true });
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
