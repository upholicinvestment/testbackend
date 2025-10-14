// server/src/scripts/setRole.ts
import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const email = process.argv.find(a => a.startsWith("--email="))?.split("=")[1];
const role  = (process.argv.find(a => a.startsWith("--role="))?.split("=")[1] || "").toLowerCase();

if (!email || !role || !["admin","superuser"].includes(role)) {
  console.error("Usage: ts-node src/scripts/setRole.ts --email=user@example.com --role=admin|superuser");
  process.exit(1);
}

(async () => {
  const uri = process.env.MONGO_URI!;
  const dbName = process.env.MONGO_DB_NAME!;
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);

  const r = await db.collection("users").updateOne({ email }, { $set: { role } });
  console.log(r.matchedCount ? `✅ Set ${email} -> ${role}` : `❌ User not found: ${email}`);
  await client.close();
})();
