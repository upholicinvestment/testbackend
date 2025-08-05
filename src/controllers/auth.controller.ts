import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { Db, ObjectId } from 'mongodb';

let db: Db;
export const setDatabase = (database: Db) => { db = database; };

const generateToken = (userId: string) => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is not defined in .env');
  return jwt.sign({ id: userId }, secret, { expiresIn: '30d' });
};

export const register = async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, email, password, phone, initialProductId, initialVariantId, brokerConfig } = req.body as {
      name: string;
      email: string;
      password: string;
      phone: string;
      initialProductId?: string;
      initialVariantId?: string;
      brokerConfig?: {
        brokerName: string;
        clientId: string;
        smartApiKey: string;
        brokerPin: string;
        totpSecret: string;
      };
    };

    if (!name || !email || !password || !phone) {
      res.status(400).json({ message: 'All fields are required' });
      return;
    }

    const existingUser = await db.collection('users').findOne({
      $or: [{ email }, { phone }]
    });

    if (existingUser) {
      if (existingUser.email === email) {
        res.status(400).json({ message: 'User with this email already exists' });
      } else {
        res.status(400).json({ message: 'User with this phone number already exists' });
      }
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await db.collection('users').insertOne({
      name,
      email,
      phone,
      password: hashedPassword,
      role: 'customer',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    if (initialProductId) {
      const product = await db.collection('products').findOne({
        _id: new ObjectId(initialProductId),
        isActive: true,
      });

      if (product) {
        let variantId: ObjectId | null = null;

        if (product.hasVariants) {
          if (!initialVariantId) {
            res.status(400).json({ message: 'Please select a plan for the chosen product.' });
            return;
          }

          const variant = await db.collection('product_variants').findOne({
            _id: new ObjectId(initialVariantId),
            productId: product._id,
            isActive: true,
          });

          if (!variant) {
            res.status(400).json({ message: 'Selected plan is invalid or inactive.' });
            return;
          }

          variantId = variant._id;
        }

        await db.collection('user_products').insertOne({
          userId: result.insertedId,
          productId: product._id,
          variantId,
          status: 'active',
          startedAt: new Date(),
          endsAt: null,
          meta: { source: 'signup', interval: 'monthly' },
        });

        // ✅ Insert broker config if product is ALGO SIMULATOR
        if (product.key === 'algo_simulator' && variantId && brokerConfig) {
          await db.collection('broker_configs').insertOne({
            userId: result.insertedId,
            productId: product._id,
            variantId,
            brokerName: brokerConfig.brokerName,
            clientId: brokerConfig.clientId,
            smartApiKey: brokerConfig.smartApiKey,
            brokerPin: brokerConfig.brokerPin,
            totpSecret: brokerConfig.totpSecret,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
      }
    }

    const token = generateToken(result.insertedId.toString());
    console.log('[auth.register] JWT issued for user', result.insertedId.toString(), token);

    res.status(201).json({
      token,
      user: { id: result.insertedId, name, email, phone },
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};


export const login = async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body as { email: string; password: string };

    const user = await db.collection('users').findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      res.status(400).json({ message: 'Invalid credentials' });
      return;
    }

    const token = generateToken(user._id.toString());

    // ✅ Console the token on the server for debugging
    console.log('[auth.login] JWT issued for user', (user as any)._id.toString(), token);

    res.status(200).json({
      token,
      user: { id: user._id, name: user.name, email: user.email, phone: user.phone },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error' });
  }
};