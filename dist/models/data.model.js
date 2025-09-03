"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Data = void 0;
const mongoose_1 = require("mongoose");
const dataSchema = new mongoose_1.Schema({
    symbol: { type: String, required: true, index: true },
    price: { type: Number, required: true },
    volume: { type: Number, required: true },
    timestamp: { type: Date, default: Date.now, index: true },
    metadata: { type: Object },
    source: { type: String, default: 'manual' },
}, { timestamps: true });
// Index for faster queries
dataSchema.index({ symbol: 1, timestamp: -1 });
exports.Data = (0, mongoose_1.model)('Data', dataSchema);
