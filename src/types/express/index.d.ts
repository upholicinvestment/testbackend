import { Document } from 'mongoose';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        role: string;
      };
      db?: any; // Add this if you're using db context in your routes
    }
  }
}

export {};