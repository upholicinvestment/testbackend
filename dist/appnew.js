"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.io = void 0;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const mongodb_1 = require("mongodb");
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const dhan_socket_1 = require("./socket/dhan.socket");
const ltp_route_1 = require("./routes/ltp.route");
const ltp_service_1 = require("./services/ltp.service");
const quote_service_1 = require("./services/quote.service");
const routes_1 = __importDefault(require("./routes"));
const auth_routes_1 = __importDefault(require("./routes/auth.routes"));
const error_middleware_1 = require("./middleware/error.middleware");
const auth_controller_1 = require("./controllers/auth.controller");
const analysis_api_1 = __importDefault(require("./api/analysis.api"));
const call_put_1 = __importDefault(require("./api/call_put"));
const cash_data_api_1 = __importDefault(require("./api/cash data.api"));
const client_api_1 = __importDefault(require("./api/client.api"));
const dii_api_1 = __importDefault(require("./api/dii.api"));
const fii_api_1 = __importDefault(require("./api/fii.api"));
const pro_api_1 = __importDefault(require("./api/pro.api"));
const summary_api_1 = __importDefault(require("./api/summary.api"));
const stocks_1 = require("./api/stocks");
const advdec_1 = require("./api/advdec");
const heatmap_1 = require("./api/heatmap");
const products_routes_1 = __importStar(require("./routes/products.routes"));
const payment_routes_1 = __importDefault(require("./routes/payment.routes"));
const payment_controller_1 = require("./controllers/payment.controller");
const dailyJournal_routes_1 = __importDefault(require("./routes/dailyJournal.routes"));
const instruments_1 = __importDefault(require("./routes/instruments")); // Path as needed
const tradeJournal_routes_1 = __importDefault(require("./routes/tradeJournal.routes"));
const contact_1 = __importDefault(require("./api/contact"));
const user_controller_1 = require("./controllers/user.controller");
const user_routes_1 = __importDefault(require("./routes/user.routes"));
const Careers_routes_1 = __importDefault(require("./routes/Careers.routes"));
dotenv_1.default.config();
const app = (0, express_1.default)();
const httpServer = (0, http_1.createServer)(app);
// CORS + Body parsing
app.use((0, cors_1.default)({
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    credentials: true,
}));
app.use(express_1.default.json());
// Global DB variables
let db;
let mongoClient;
// -------------- websocket dhan data -----------------------
/*** Get IST Date (UTC +5:30) */
function getISTDate() {
    return new Date(); // Server is already in IST
}
/*** Check if market is open (Mon–Fri, 09:15–15:30 IST) */
function isMarketOpen() {
    const now = getISTDate();
    // 0 = Sunday, 6 = Saturday
    const day = now.getDay();
    if (day === 0 || day === 6)
        return false; // Weekend closed
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const totalMinutes = hours * 60 + minutes;
    // Regular session window
    return totalMinutes >= 9 * 60 + 15 && totalMinutes <= 15 * 60 + 30;
}
// Market Quote Polling (with rate limit handling) //
const securityIds = [
    35052, 35053, 35054, 35055, 35107, 35108, 35109, 35110, 35111, 35112, 35113,
    35114, 35179, 35183, 35189, 35190, 37102, 37116, 38340, 38341, 42509, 42510
]; // Add your full NSE_FNO instrument list here
const QUOTE_BATCH_SIZE = 1000;
const QUOTE_INTERVAL = 2500; // 1.2 seconds (slightly above 1s to avoid 429)
async function startMarketQuotePolling() {
    console.log("🚀 Starting Market Quote Polling...");
    let currentIndex = 0;
    setInterval(async () => {
        if (!isMarketOpen()) {
            console.log("⏳ Market closed. Skipping Market Quote Polling.");
            return;
        }
        try {
            const batch = securityIds.slice(currentIndex, currentIndex + QUOTE_BATCH_SIZE);
            if (batch.length > 0) {
                const data = await (0, quote_service_1.fetchMarketQuote)(batch);
                await (0, quote_service_1.saveMarketQuote)(data);
            }
            currentIndex += QUOTE_BATCH_SIZE;
            if (currentIndex >= securityIds.length)
                currentIndex = 0;
        }
        catch (err) {
            if (err.response?.status === 429) {
                console.warn("⚠ Rate limit hit (429). Skipping this cycle to avoid being blocked.");
            }
            else {
                console.error("❌ Error in Market Quote Polling:", err);
            }
        }
    }, QUOTE_INTERVAL);
}
// WebSocket for LTP
const dhanSocket = new dhan_socket_1.DhanSocket(process.env.DHAN_API_KEY, process.env.DHAN_CLIENT_ID);
// Connect WebSocket only during market hours
if (isMarketOpen()) {
    dhanSocket.connect(securityIds);
}
else {
    console.log("⏳ Market is closed. Skipping WebSocket connection.");
}
// --------------------------------------------------------
// Connect to MongoDB and start server
const connectDB = async () => {
    try {
        if (!process.env.MONGO_URI || !process.env.MONGO_DB_NAME) {
            throw new Error("❌ Missing MongoDB URI or DB Name in .env");
        }
        mongoClient = new mongodb_1.MongoClient(process.env.MONGO_URI);
        await mongoClient.connect();
        db = mongoClient.db(process.env.MONGO_DB_NAME);
        console.log("✅ Connected to MongoDB");
        // Inject DB into controllers
        (0, auth_controller_1.setDatabase)(db);
        (0, ltp_service_1.setDatabase)(db);
        (0, quote_service_1.setDatabase)(db);
        (0, products_routes_1.setProductsDb)(db);
        // Inject DB into all routes that need it
        (0, analysis_api_1.default)(app, db);
        (0, call_put_1.default)(app, db);
        (0, cash_data_api_1.default)(app, db);
        (0, client_api_1.default)(app, db);
        (0, dii_api_1.default)(app, db);
        (0, fii_api_1.default)(app, db);
        (0, pro_api_1.default)(app, db);
        (0, summary_api_1.default)(app, db);
        (0, stocks_1.Stocks)(app, db);
        (0, advdec_1.AdvDec)(app, db);
        (0, heatmap_1.Heatmap)(app, db);
        (0, contact_1.default)(app, db);
        (0, payment_controller_1.setPaymentDatabase)(db);
        (0, user_controller_1.setUserDatabase)(db);
        // mount specific routers first
        app.use("/api/auth", auth_routes_1.default);
        app.use("/api/payments", payment_routes_1.default);
        app.use("/api/products", products_routes_1.default);
        app.use("/api/ltp", ltp_route_1.ltpRoutes);
        // then mount the central router
        app.use("/api", routes_1.default);
        app.use("/api/instruments", instruments_1.default);
        app.use("/api", (0, tradeJournal_routes_1.default)(db));
        app.use('/api/daily-journal', (0, dailyJournal_routes_1.default)(db));
        app.use("/api/users", user_routes_1.default);
        app.use("/api/careers", (0, Careers_routes_1.default)(db));
        // Start Market Quote Polling
        await (0, quote_service_1.fetchAndStoreInstruments)();
        startMarketQuotePolling();
        // Error handler
        app.use((err, req, res, next) => {
            (0, error_middleware_1.errorMiddleware)(err, req, res, next);
        });
        // Start HTTP + WebSocket server
        const PORT = Number(process.env.PORT) || 8000;
        httpServer.listen(PORT, () => {
            console.log(`🚀 Server running at http://localhost:${PORT}`);
            console.log(`🔗 Allowed CORS origin: ${process.env.CLIENT_URL || "http://localhost:5173"}`);
        });
    }
    catch (err) {
        console.error("❌ MongoDB connection error:", err);
        process.exit(1);
    }
};
connectDB();
// Setup Socket.IO
const io = new socket_io_1.Server(httpServer, {
    cors: {
        origin: process.env.CLIENT_URL || "http://localhost:5173",
        methods: ["GET", "POST"],
    },
    // connectionStateRecovery: {
    //   maxDisconnectionDuration: 2 * 60 * 1000,
    //   skipMiddlewares: true,
    // },
});
exports.io = io;
io.on("connection", (socket) => {
    console.log("🔌 New client connected:", socket.id);
    socket.on("disconnect", (reason) => console.log(`Client disconnected (${socket.id}):`, reason));
    // socket.on("error", (err) => console.error("Socket error:", err));
});
// Graceful shutdown
process.on("SIGINT", async () => {
    console.log("🛑 Shutting down gracefully...");
    await mongoClient.close();
    httpServer.close(() => {
        console.log("✅ Server closed");
        process.exit(0);
    });
});
