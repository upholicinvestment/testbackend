// server/src/controllers/data.controller.ts
import { Request, Response } from 'express';
import { Data } from '../models/data.model';

export const getData = async (req: Request, res: Response) => {
  try {
    const { symbol, startDate, endDate, limit } = req.query;
    
    const query: any = { 
      // Add any public filters here if needed
    };
    
    if (symbol) query.symbol = symbol;
    
    if (startDate || endDate) {
      query.timestamp = {};
      if (startDate) query.timestamp.$gte = new Date(startDate as string);
      if (endDate) query.timestamp.$lte = new Date(endDate as string);
    }

    // Only return essential fields for public access
    const data = await Data.find(query)
      .select('symbol price volume timestamp') // Limit fields
      .sort({ timestamp: -1 })
      .limit(Math.min(parseInt(limit as string) || 100, 100)); // Max 100 items

    res.json(data);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const createData = async (req: Request, res: Response) => {
  try {
    // Disable creation in public mode
    return res.status(403).json({ 
      message: 'Data creation is disabled in public mode' 
    });

    /* Commented out the original implementation:
    const { symbol, price, volume, metadata } = req.body;

    const newData = await Data.create({
      symbol,
      price,
      volume,
      metadata,
      timestamp: new Date(),
    });

    res.status(201).json(newData);
    */
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

export const getLatestData = async (req: Request, res: Response) => {
  try {
    const { symbol } = req.params;
    
    const latestData = await Data.findOne({ symbol })
      .select('symbol price volume timestamp') // Limit fields
      .sort({ timestamp: -1 });

    if (!latestData) {
      return res.status(404).json({ message: 'No data found for this symbol' });
    }

    res.json(latestData);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};