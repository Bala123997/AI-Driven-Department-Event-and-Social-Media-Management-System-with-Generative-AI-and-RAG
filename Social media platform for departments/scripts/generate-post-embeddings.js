import "dotenv/config";
import mysql from "mysql2/promise";
import { createPostText, EMBEDDING_MODEL, generateEmbedding } from "../api/services/similarity-service.js";

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "kare_cse_social",
});

try {
  const [posts] = await pool.query(
    `SELECT post_id, title, post_type, description, event_date, event_time, venue
       FROM posts
      WHERE status IN ('pending', 'approved', 'scheduled', 'published')
        AND (ai_embedding IS NULL OR ai_embedding_model <> ?)
      ORDER BY post_id`,
    [EMBEDDING_MODEL],
  );
  for (const post of posts) {
    const embedding = await generateEmbedding(createPostText(post));
    await pool.execute(
      "UPDATE posts SET ai_embedding = ?, ai_embedding_model = ? WHERE post_id = ?",
      [JSON.stringify(embedding), EMBEDDING_MODEL, post.post_id],
    );
    console.log(`Generated embedding for post ${post.post_id}: ${post.title}`);
  }
  console.log(`Processed ${posts.length} post(s).`);
} finally {
  await pool.end();
}