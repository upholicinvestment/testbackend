"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.errorMiddleware = void 0;
const errorMiddleware = (err, req, res, next) => {
    // Log more details in development
    if (process.env.NODE_ENV === 'development') {
        console.error('Error details:', {
            message: err.message,
            stack: err.stack,
            fullError: err
        });
    }
    else {
        console.error(err.stack);
    }
    // Handle validation errors
    if (err.name === 'ValidationError' || err.errors) {
        return res.status(400).json({
            success: false,
            message: 'Validation failed',
            errors: process.env.NODE_ENV === 'development' ? err.errors : undefined,
        });
    }
    // Handle MongoDB duplicate key error
    if (err.code === 11000) {
        return res.status(400).json({
            success: false,
            message: 'Duplicate field value entered',
            field: process.env.NODE_ENV === 'development' ? err.keyValue : undefined
        });
    }
    // Handle JWT errors
    if (err.name === 'JsonWebTokenError') {
        return res.status(401).json({
            success: false,
            message: 'Invalid token',
        });
    }
    if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
            success: false,
            message: 'Token expired',
        });
    }
    const statusCode = err.statusCode || 500;
    const message = err.message || 'Internal Server Error';
    res.status(statusCode).json({
        success: false,
        message,
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
};
exports.errorMiddleware = errorMiddleware;
