import { Express, Request, Response } from "express";
import { Db } from "mongodb";
import { otpStore } from "../controllers/otp_send.controller";


export default function registerAdsRoutes(app: Express, db: Db) {
app.post("/api/ads", async (req: Request, res: Response) => {
try {
const { firstName, lastName, phone, message, otp } = req.body || {};
const digits = String(phone || "").replace(/\D/g, "");
if (!String(firstName || "").trim() || !String(lastName || "").trim()) {
res.status(400).json({ error: "First and last name are required" });
return;
}
if (digits.length !== 10) {
res.status(400).json({ error: "Phone must be 10 digits" });
return;
}


const rec = otpStore[digits];
if (!rec) {
res.status(401).json({ error: "No OTP request found for this number" });
return;
}


const now = Math.floor(Date.now() / 1000);
if (rec.expiresAt < now) {
delete otpStore[digits];
res.status(410).json({ error: "OTP expired. Please request a new one." });
return;
}


const ok = rec.verified || String(rec.otp) === String(otp || "");
if (!ok) {
res.status(401).json({ error: "OTP not verified / incorrect" });
return;
}


// Consume OTP to prevent reuse
delete otpStore[digits];


await db.collection("ads").insertOne({
firstName: String(firstName).trim(),
lastName: String(lastName).trim(),
phone: digits,
message: String(message || "").trim(),
createdAt: new Date(),
});


res.json({ success: true, message: "Enquiry submitted" });
} catch (e: any) {
console.error("POST /api/ads error:", e?.message || e);
res.status(500).json({ error: "Internal Server Error" });
}
});
}