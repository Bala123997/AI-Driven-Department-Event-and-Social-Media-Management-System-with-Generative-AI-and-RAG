import "dotenv/config";
import mysql from "mysql2/promise";
import { syncApprovedPostsToChroma } from "../api/services/chroma-service.js";

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "kare_cse_social",
});

try {
  const result = await syncApprovedPostsToChroma(pool);
  console.log(`ChromaDB index synchronized: ${result.indexed} approved event(s) indexed; ${result.removed} stale entry/entries removed.`);
} finally {
  await pool.end();
}