"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLatestData = exports.createData = exports.getData = void 0;
const data_model_1 = require("../models/data.model");
const getData = async (req, res) => {
    try {
        const { symbol, startDate, endDate, limit } = req.query;
        const query = {
        // Add any public filters here if needed
        };
        if (symbol)
            query.symbol = symbol;
        if (startDate || endDate) {
            query.timestamp = {};
            if (startDate)
                query.timestamp.$gte = new Date(startDate);
            if (endDate)
                query.timestamp.$lte = new Date(endDate);
        }
        // Only return essential fields for public access
        const data = await data_model_1.Data.find(query)
            .select('symbol price volume timestamp') // Limit fields
            .sort({ timestamp: -1 })
            .limit(Math.min(parseInt(limit) || 100, 100)); // Max 100 items
        res.json(data);
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
};
exports.getData = getData;
const createData = async (req, res) => {
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
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
};
exports.createData = createData;
const getLatestData = async (req, res) => {
    try {
        const { symbol } = req.params;
        const latestData = await data_model_1.Data.findOne({ symbol })
            .select('symbol price volume timestamp') // Limit fields
            .sort({ timestamp: -1 });
        if (!latestData) {
            return res.status(404).json({ message: 'No data found for this symbol' });
        }
        res.json(latestData);
    }
    catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error' });
    }
};
exports.getLatestData = getLatestData;
