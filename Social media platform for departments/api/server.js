import "dotenv/config";
import http from "node:http";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import mysql from "mysql2/promise";
import { google } from "googleapis";
import { dispatchNotification } from "./services/notification-service.js";
import { generateCaption, generateDescription } from "./services/caption-service.js";
import { removePostFromChroma, retrieveRelevantPostIds, syncApprovedPostsToChroma, upsertApprovedPost } from "./services/chroma-service.js";
import {
  classifySimilarity,
  cosineSimilarity,
  createPostText,
  DUPLICATE_THRESHOLD,
  EMBEDDING_MODEL,
  generateEmbedding,
  parseEmbedding,
} from "./services/similarity-service.js";
import {
  buildRagContext,
  formatCalendarEvents,
  formatRegisteredEvents,
  filterRegisteredEvents,
  generateRagAnswer,
  getCalendarScope,
  getRegistrationFilter,
  findEventTypeMatches,
  formatEventTypeAnswer,
  isCalendarCountQuestion,
  isCalendarListQuestion,
  isEventTypeQuestion,
  isRegistrationStatusQuestion,
  mapRetrievedPosts,
  RAG_TOP_K,
} from "./services/rag-service.js";

const port = Number(process.env.API_PORT || 3001);
const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "kare_cse_social",
  connectionLimit: 10,
});

const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/calendar.events", "openid", "email"];
const googleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
const googleStateSecret = process.env.GOOGLE_STATE_SECRET || process.env.GOOGLE_CLIENT_SECRET || "development-google-state-secret";
const googleFrontendRedirect = process.env.GOOGLE_FRONTEND_REDIRECT_URI || "http://localhost:5173/prototype/index.html";

function createOAuthClient() {
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
}

function encryptToken(value) {
  if (!value) return null;
  const key = crypto.createHash("sha256").update(process.env.APP_ENCRYPTION_KEY || googleStateSecret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

function decryptToken(value) {
  if (!value) return null;
  const [ivValue, tagValue, encryptedValue] = String(value).split(".");
  if (!ivValue || !tagValue || !encryptedValue) return null;
  const key = crypto.createHash("sha256").update(process.env.APP_ENCRYPTION_KEY || googleStateSecret).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
}

function signGoogleState(userId) {
  const payload = Buffer.from(JSON.stringify({ userId: Number(userId), issuedAt: Date.now() })).toString("base64url");
  const signature = crypto.createHmac("sha256", googleStateSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyGoogleState(state) {
  const [payload, signature] = String(state || "").split(".");
  if (!payload || !signature) return null;
  const expected = crypto.createHmac("sha256", googleStateSecret).update(payload).digest("base64url");
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed.userId || Date.now() - Number(parsed.issuedAt) > 10 * 60 * 1000) return null;
    return Number(parsed.userId);
  } catch {
    return null;
  }
}

function redirect(response, location) {
  response.writeHead(302, { Location: location });
  response.end();
}

function googleErrorRedirect(message) {
  return `${googleFrontendRedirect}?googleCalendar=error&message=${encodeURIComponent(message)}`;
}

async function syncRegistrationToGoogle({ registrationId, userId, post }) {
  const [[connection]] = await pool.execute(
    "SELECT * FROM google_calendar_connections WHERE user_id = ? LIMIT 1",
    [userId],
  );
  if (!connection) {
    await pool.execute("UPDATE event_registrations SET calendar_sync_status = 'not_connected' WHERE registration_id = ?", [registrationId]);
    return { status: "not_connected" };
  }
  try {
    const oauthClient = createOAuthClient();
    oauthClient.setCredentials({
      access_token: decryptToken(connection.access_token_encrypted),
      refresh_token: decryptToken(connection.refresh_token_encrypted),
      expiry_date: connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : undefined,
    });
    const calendar = google.calendar({ version: "v3", auth: oauthClient });
    const start = `${post.event_date}T${post.event_time || "10:00:00"}`;
    const endDate = new Date(`${post.event_date}T${post.event_time || "10:00:00"}Z`);
    endDate.setHours(endDate.getHours() + 1);
    const end = `${endDate.toISOString().slice(0, 10)}T${endDate.toISOString().slice(11, 19)}`;
    const result = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: post.title,
        description: post.description || "Department event",
        location: post.venue || undefined,
        start: { dateTime: start, timeZone: process.env.GOOGLE_CALENDAR_TIMEZONE || "Asia/Kolkata" },
        end: { dateTime: end, timeZone: process.env.GOOGLE_CALENDAR_TIMEZONE || "Asia/Kolkata" },
        reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 1440 }] },
      },
    });
    await pool.execute(
      "UPDATE event_registrations SET google_calendar_event_id = ?, calendar_sync_status = 'synced', calendar_sync_error = NULL WHERE registration_id = ?",
      [result.data.id, registrationId],
    );
    return { status: "synced", eventId: result.data.id };
  } catch (error) {
    await pool.execute(
      "UPDATE event_registrations SET calendar_sync_status = 'failed', calendar_sync_error = ? WHERE registration_id = ?",
      [String(error.message || "Google Calendar sync failed").slice(0, 1000), registrationId],
    );
    return { status: "failed" };
  }
}

async function ensureSchemaCompatibility() {
  const requiredColumns = [
    ["submitted_at", "DATETIME NULL"],
    ["approved_at", "DATETIME NULL"],
    ["published_at", "DATETIME NULL"],
    ["rejection_reason", "TEXT NULL"],
    ["updated_at", "DATETIME NULL"],
    ["ai_embedding", "JSON NULL"],
    ["ai_embedding_model", "VARCHAR(100) NULL"],
  ];
  const [columns] = await pool.query("SHOW COLUMNS FROM posts");
  const existing = new Set(columns.map((column) => column.Field));
  for (const [name, definition] of requiredColumns) {
    if (!existing.has(name)) {
      await pool.execute(`ALTER TABLE posts ADD COLUMN ${name} ${definition}`);
    }
  }
  await pool.execute("ALTER TABLE posts MODIFY COLUMN poster_url LONGTEXT NULL");
  const [userIndexes] = await pool.query("SHOW INDEX FROM users");
  const hasRoleEmailIndex = userIndexes.some((index) => index.Key_name === "uq_users_role_email");
  if (!hasRoleEmailIndex) {
    const emailOnlyUniqueIndexes = userIndexes.filter((index) => index.Non_unique === 0 && index.Column_name === "email" && index.Key_name !== "PRIMARY");
    for (const index of emailOnlyUniqueIndexes) {
      await pool.execute(`ALTER TABLE users DROP INDEX \`${index.Key_name}\``);
    }
    await pool.execute("ALTER TABLE users ADD UNIQUE KEY uq_users_role_email (role_id, email)");
  }
  const [notificationColumns] = await pool.query("SHOW COLUMNS FROM notifications");
  if (!notificationColumns.some((column) => column.Field === "created_at")) {
    await pool.execute("ALTER TABLE notifications ADD COLUMN created_at DATETIME NULL");
  }
  const [calendarColumns] = await pool.query("SHOW COLUMNS FROM calendar_events");
  if (!calendarColumns.some((column) => column.Field === "updated_at")) {
    await pool.execute("ALTER TABLE calendar_events ADD COLUMN updated_at DATETIME NULL");
  }
  const [[postKey]] = await pool.query(
    "SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts' AND COLUMN_NAME = 'post_id' LIMIT 1",
  );
  const [[userKey]] = await pool.query(
    "SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'user_id' LIMIT 1",
  );
  const postIdType = postKey?.COLUMN_TYPE || "bigint unsigned";
  const userIdType = userKey?.COLUMN_TYPE || "bigint unsigned";
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS post_likes (
       post_id ${postIdType} NOT NULL,
       user_id ${userIdType} NOT NULL,
       created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (post_id, user_id),
       CONSTRAINT fk_post_likes_post FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
       CONSTRAINT fk_post_likes_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
       INDEX idx_post_likes_user (user_id)
     )`,
  );
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS event_registrations (
       registration_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       post_id ${postIdType} NOT NULL,
       user_id ${userIdType} NOT NULL,
       registration_url VARCHAR(1000) NULL,
       registered_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
       CONSTRAINT fk_event_registrations_post FOREIGN KEY (post_id) REFERENCES posts(post_id) ON DELETE CASCADE,
       CONSTRAINT fk_event_registrations_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
       UNIQUE KEY uq_event_registration_user_post (post_id, user_id),
       INDEX idx_event_registrations_user (user_id)
     )`,
  );
  const [registrationColumns] = await pool.query("SHOW COLUMNS FROM event_registrations");
  const registrationColumnNames = new Set(registrationColumns.map((column) => column.Field));
  if (!registrationColumnNames.has("google_calendar_event_id")) {
    await pool.execute("ALTER TABLE event_registrations ADD COLUMN google_calendar_event_id VARCHAR(255) NULL");
  }
  if (!registrationColumnNames.has("calendar_sync_status")) {
    await pool.execute("ALTER TABLE event_registrations ADD COLUMN calendar_sync_status ENUM('not_connected', 'synced', 'failed') NOT NULL DEFAULT 'not_connected'");
  }
  if (!registrationColumnNames.has("calendar_sync_error")) {
    await pool.execute("ALTER TABLE event_registrations ADD COLUMN calendar_sync_error TEXT NULL");
  }
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS google_calendar_connections (
       connection_id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       user_id ${userIdType} NOT NULL,
       google_subject VARCHAR(255) NOT NULL,
       google_email VARCHAR(255) NULL,
       access_token_encrypted TEXT NULL,
       refresh_token_encrypted TEXT NULL,
       token_expires_at DATETIME NULL,
       scopes TEXT NULL,
       connected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
       CONSTRAINT fk_google_calendar_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
       UNIQUE KEY uq_google_calendar_user (user_id),
       UNIQUE KEY uq_google_calendar_subject (google_subject)
     )`,
  );
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  });
  response.end(JSON.stringify(body));
}

async function removeExpiredEvents() {
  // Keep historical posts and calendar events available for users.
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

function normalizeTime(value) {
  const input = String(value || "10:00").trim();
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i.exec(input);
  if (!match) return "10:00:00";
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[4] && match[4].toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return "10:00:00";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
}

async function storePostEmbedding(postId, post) {
  try {
    const embedding = await generateEmbedding(createPostText(post));
    await pool.execute(
      "UPDATE posts SET ai_embedding = ?, ai_embedding_model = ? WHERE post_id = ?",
      [JSON.stringify(embedding), EMBEDDING_MODEL, postId],
    );
  } catch (error) {
    console.warn(`Could not generate AI embedding for post ${postId}:`, error.message);
  }
}

async function syncPostVector(postId) {
  try {
    const [posts] = await pool.query(
      `SELECT post_id, title, post_type, description, event_date, event_time, venue, status,
              ai_embedding, ai_embedding_model
         FROM posts WHERE post_id = ? LIMIT 1`,
      [postId],
    );
    const post = posts[0];
    if (!post || !["approved", "scheduled", "published"].includes(post.status) || !post.event_date) {
      await removePostFromChroma(postId);
      return;
    }
    const embedding = post.ai_embedding_model === EMBEDDING_MODEL ? parseEmbedding(post.ai_embedding) : null;
    await upsertApprovedPost(post, embedding);
  } catch (error) {
    console.warn(`Could not synchronize event ${postId} with ChromaDB:`, error.message);
  }
}

async function getUserIdsForRoles(roleNames, database = pool, allUsers = false) {
  if (allUsers) {
    const [rows] = await database.execute("SELECT user_id FROM users WHERE status = 'active'");
    return rows.map((row) => Number(row.user_id));
  }
  if (!Array.isArray(roleNames) || !roleNames.length) return [];
  const placeholders = roleNames.map(() => "?").join(", ");
  const [rows] = await database.execute(
    `SELECT DISTINCT u.user_id
       FROM users u
       JOIN roles r ON r.role_id = u.role_id
      WHERE r.role_name IN (${placeholders})`,
    roleNames,
  );
  return rows.map((row) => Number(row.user_id));
}

async function createNotificationsForRoles({ postId = null, notificationType = "system", title, message, roleNames = [], database = pool, allUsers = false }) {
  const userIds = Array.from(new Set(await getUserIdsForRoles(roleNames, database, allUsers)));
  if (!userIds.length || !title || !message) return [];
  const values = [];
  const placeholders = userIds.map(() => "(?, ?, ?, ?, ?, 0)").join(", ");
  userIds.forEach((userId) => {
    values.push(userId, postId, notificationType, title, message);
  });
  await database.execute(
    `INSERT INTO notifications (user_id, post_id, notification_type, title, message, is_read)
     VALUES ${placeholders}`,
    values,
  );
  return userIds;
}

async function handleRequest(request, response) {
  if (request.method === "OPTIONS") return sendJson(response, 204, {});

  await removeExpiredEvents();

  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "GET" && url.pathname === "/api/health") {
    await pool.query("SELECT 1");
    return sendJson(response, 200, { ok: true, service: "kare-cse-api" });
  }

  if (request.method === "GET" && url.pathname === "/api/calendar-window") {
    const [[databaseDate]] = await pool.query("SELECT CURDATE() AS current_date_value");
    return sendJson(response, 200, { currentDate: databaseDate.current_date_value });
  }

  if (request.method === "POST" && url.pathname === "/api/similarity/check") {
    const body = await readJson(request);
    if (!body.title || !String(body.title).trim()) {
      return sendJson(response, 400, { error: "An event title is required." });
    }
    const embedding = await generateEmbedding(createPostText(body));
    const [previousPosts] = await pool.query(
      `SELECT post_id, title, event_date, ai_embedding
         FROM posts
        WHERE status IN ('pending', 'approved', 'scheduled', 'published')
        ORDER BY event_date ASC, event_time ASC`,
    );
    const matches = previousPosts
      .map((post) => ({
        postId: Number(post.post_id),
        title: post.title,
        date: post.event_date,
        similarity: cosineSimilarity(embedding, parseEmbedding(post.ai_embedding)),
      }))
      .filter((match) => match.similarity >= 0.5)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 3)
      .map((match) => ({ ...match, similarity: Number(match.similarity.toFixed(4)), classification: classifySimilarity(match.similarity) }));
    return sendJson(response, 200, {
      success: true,
      model: EMBEDDING_MODEL,
      duplicateDetected: matches.length > 0 && matches[0].similarity >= DUPLICATE_THRESHOLD,
      matches,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/ai/generate-caption") {
    const body = await readJson(request);
    if (!body.title || !String(body.title).trim()) {
      return sendJson(response, 400, { error: "Event title is required before generating a caption." });
    }
    try {
      const caption = await generateCaption(body);
      return sendJson(response, 200, { success: true, caption });
    } catch (error) {
      const knownErrors = new Set(["OLLAMA_UNAVAILABLE", "OLLAMA_MODEL_NOT_FOUND", "OLLAMA_TIMEOUT"]);
      if (knownErrors.has(error.code)) {
        return sendJson(response, 503, { code: error.code, error: error.message });
      }
      throw error;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/ai/generate-description") {
    const body = await readJson(request);
    if (!body.title || !String(body.title).trim()) {
      return sendJson(response, 400, { error: "Event title is required before generating a description." });
    }
    try {
      const description = await generateDescription(body);
      return sendJson(response, 200, { success: true, description });
    } catch (error) {
      const knownErrors = new Set(["OLLAMA_UNAVAILABLE", "OLLAMA_MODEL_NOT_FOUND", "OLLAMA_TIMEOUT"]);
      if (knownErrors.has(error.code)) return sendJson(response, 503, { code: error.code, error: error.message });
      throw error;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/rag/chat") {
    const body = await readJson(request);
    const question = String(body.question || "").trim();
    const userId = Number(body.userId || 0);
    if (!question) {
      return sendJson(response, 400, { error: "A question is required for the department assistant." });
    }

    const [[databaseDate]] = await pool.query("SELECT CURDATE() AS current_date_value");
    const scope = getCalendarScope(question, databaseDate.current_date_value);

    if (isRegistrationStatusQuestion(question)) {
      if (!userId) return sendJson(response, 400, { error: "A valid General User is required to check registrations." });
      const [registeredEvents] = await pool.query(
        `SELECT p.title, p.event_date, p.event_time, p.venue
           FROM event_registrations er
           JOIN posts p ON p.post_id = er.post_id
          WHERE er.user_id = ?
            AND p.status IN ('approved', 'scheduled', 'published')
            AND p.event_date >= CURDATE()
          ORDER BY p.event_date ASC, p.event_time ASC`,
        [userId],
      );
      const registrationFilter = getRegistrationFilter(question);
      const matchingRegistrations = filterRegisteredEvents(registeredEvents, question);
      return sendJson(response, 200, {
        success: true,
        answer: formatRegisteredEvents(
          matchingRegistrations,
          registrationFilter
            ? `You are not registered for any upcoming ${registrationFilter} events.`
            : "You are not registered for any upcoming events.",
        ),
      });
    }

    const [rows] = await pool.query(
      `SELECT post_id, title, post_type, description, event_date, event_time, venue
         FROM posts
        WHERE status IN ('approved', 'scheduled', 'published')
          AND event_date BETWEEN ? AND ?
        ORDER BY event_date ASC, event_time ASC`,
      [scope.start, scope.end],
    );

    if (!rows.length) {
      return sendJson(response, 200, {
        success: false,
        answer: "I couldn't find this information in the department's available approved records.",
      });
    }

    try {
      if (isCalendarListQuestion(question)) {
        return sendJson(response, 200, { success: true, answer: formatCalendarEvents(rows) });
      }
      if (isCalendarCountQuestion(question)) {
        return sendJson(response, 200, { success: true, answer: `There ${rows.length === 1 ? "is 1 upcoming event" : `are ${rows.length} upcoming events`} in the requested calendar period.` });
      }

      if (isEventTypeQuestion(question)) {
        const typeMatches = findEventTypeMatches(question, rows);
        const requestedType = getRegistrationFilter(question) || (question.toLowerCase().includes("hackathon") ? "hackathon" : "");
        return sendJson(response, 200, { success: true, answer: formatEventTypeAnswer(typeMatches[0], requestedType) });
      }

      const questionEmbedding = await generateEmbedding(question);
      const retrievedIds = await retrieveRelevantPostIds(questionEmbedding, scope, Math.min(RAG_TOP_K, rows.length));
      const relevantPosts = mapRetrievedPosts(retrievedIds, rows);
      if (!relevantPosts.length) {
        return sendJson(response, 200, {
          success: false,
          answer: "I couldn't find this information in the department's available approved records.",
        });
      }

      const context = buildRagContext(relevantPosts);
      const answer = await generateRagAnswer({ question, context, currentDate: databaseDate.current_date_value, scope });

      return sendJson(response, 200, {
        success: true,
        answer,
      });
    } catch (error) {
      const knownErrors = new Set(["OLLAMA_UNAVAILABLE", "OLLAMA_MODEL_NOT_FOUND", "OLLAMA_TIMEOUT"]);
      if (knownErrors.has(error.code)) {
        return sendJson(response, 503, { code: error.code, error: error.message });
      }
      if (error.code === "CHROMA_UNAVAILABLE") {
        return sendJson(response, 503, { code: "CHROMA_UNAVAILABLE", error: "The event search service is unavailable. Start ChromaDB and try again." });
      }
      throw error;
    }
  }

  if (request.method === "GET" && url.pathname === "/auth/google") {
    const userId = Number(url.searchParams.get("userId") || 0);
    if (!googleConfigured) return sendJson(response, 503, { error: "Google Calendar is not configured. Add the GOOGLE_* values to .env first." });
    if (!userId) return sendJson(response, 400, { error: "A valid user is required." });
    const [usersForAuth] = await pool.execute(
      `SELECT u.user_id FROM users u JOIN roles r ON r.role_id = u.role_id
        WHERE u.user_id = ? AND r.role_name = 'General User' AND u.status = 'active' LIMIT 1`,
      [userId],
    );
    if (!usersForAuth.length) return sendJson(response, 403, { error: "Only an active General User can connect Google Calendar." });
    const oauthClient = createOAuthClient();
    const authUrl = oauthClient.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: GOOGLE_SCOPES,
      include_granted_scopes: true,
      state: signGoogleState(userId),
    });
    return redirect(response, authUrl);
  }

  if (request.method === "GET" && url.pathname === "/auth/google/callback") {
    if (!googleConfigured) return redirect(response, googleErrorRedirect("Google Calendar is not configured."));
    const userId = verifyGoogleState(url.searchParams.get("state"));
    if (!userId || url.searchParams.get("error")) return redirect(response, googleErrorRedirect("Google authorization was cancelled or expired."));
    try {
      const oauthClient = createOAuthClient();
      const { tokens } = await oauthClient.getToken(String(url.searchParams.get("code") || ""));
      oauthClient.setCredentials(tokens);
      const oauth2 = google.oauth2({ version: "v2", auth: oauthClient });
      const { data: profile } = await oauth2.userinfo.get();
      const googleSubject = profile?.id || profile?.sub || profile?.email;
      if (!googleSubject) throw new Error("Google did not return an account identifier.");
      await pool.execute(
        `INSERT INTO google_calendar_connections
          (user_id, google_subject, google_email, access_token_encrypted, refresh_token_encrypted, token_expires_at, scopes)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE google_subject = VALUES(google_subject), google_email = VALUES(google_email),
           access_token_encrypted = VALUES(access_token_encrypted),
           refresh_token_encrypted = COALESCE(VALUES(refresh_token_encrypted), refresh_token_encrypted),
           token_expires_at = VALUES(token_expires_at), scopes = VALUES(scopes), updated_at = NOW()`,
        [
          userId,
          googleSubject,
          profile?.email || null,
          encryptToken(tokens.access_token),
          encryptToken(tokens.refresh_token),
          tokens.expiry_date ? new Date(tokens.expiry_date) : null,
          tokens.scope || GOOGLE_SCOPES.join(" "),
        ],
      );
      return redirect(response, `${googleFrontendRedirect}?googleCalendar=connected`);
    } catch (error) {
      console.error("Google Calendar OAuth callback failed:", error.stack || error);
      return redirect(response, googleErrorRedirect("Google Calendar could not be connected."));
    }
  }

  if (request.method === "GET" && url.pathname === "/api/google-calendar/status") {
    const userId = Number(url.searchParams.get("userId") || 0);
    if (!userId) return sendJson(response, 400, { error: "A valid user is required." });
    const [[connection]] = await pool.execute(
      "SELECT google_email, connected_at FROM google_calendar_connections WHERE user_id = ? LIMIT 1",
      [userId],
    );
    return sendJson(response, 200, { connected: Boolean(connection), email: connection?.google_email || null, connectedAt: connection?.connected_at || null });
  }

  if (request.method === "POST" && url.pathname === "/api/google-calendar/disconnect") {
    const body = await readJson(request);
    const userId = Number(body.userId || 0);
    if (!userId) return sendJson(response, 400, { error: "A valid user is required." });
    await pool.execute("DELETE FROM google_calendar_connections WHERE user_id = ?", [userId]);
    return sendJson(response, 200, { connected: false });
  }

  if (request.method === "POST" && url.pathname === "/api/login") {
    const body = await readJson(request);
    if (!body.email || !body.password || !body.role) {
      return sendJson(response, 400, { error: "Email, password and role are required." });
    }

    const requestedRole = {
      faculty: "Faculty",
      coordinator: "Student Coordinator",
      admin: "Administrator",
      general: "General User",
    }[String(body.role).toLowerCase()] || body.role;

    const [rows] = await pool.execute(
      `SELECT u.user_id, u.full_name, u.email, u.password_hash, r.role_name,
              d.department_code
         FROM users u
         JOIN roles r ON r.role_id = u.role_id
         LEFT JOIN departments d ON d.department_id = u.department_id
        WHERE u.email = ? AND r.role_name = ? AND u.status = 'active'
        LIMIT 1`,
      [String(body.email).trim().toLowerCase(), requestedRole],
    );
    const user = rows[0];
    const roleMatches = user && user.role_name.toLowerCase() === String(requestedRole).toLowerCase();
    if (!user || !roleMatches || !(await bcrypt.compare(body.password, user.password_hash))) {
      return sendJson(response, 401, { error: "Invalid login details." });
    }

    return sendJson(response, 200, {
      user: {
        id: user.user_id,
        name: user.full_name,
        email: user.email,
        role: user.role_name,
        department: user.department_code,
      },
    });
  }

  if (request.method === "POST" && url.pathname === "/api/register-general") {
    const body = await readJson(request);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!name || !email || password.length < 6) {
      return sendJson(response, 400, { error: "Name, email and a password of at least 6 characters are required." });
    }

    const [existing] = await pool.execute(
      `SELECT u.user_id
         FROM users u
         JOIN roles r ON r.role_id = u.role_id
        WHERE u.email = ? AND r.role_name = 'General User'
        LIMIT 1`,
      [email],
    );
    if (existing.length) return sendJson(response, 409, { error: "An account with this email already exists." });

    const [roles] = await pool.execute("SELECT role_id FROM roles WHERE role_name = 'General User' LIMIT 1");
    if (!roles.length) return sendJson(response, 500, { error: "General User role is missing from the database." });
    await pool.execute(
      `INSERT IGNORE INTO departments (department_code, department_name, status)
       VALUES ('CSE', 'Computer Science and Engineering', 'active')`,
    );
    const [departments] = await pool.execute("SELECT department_id FROM departments WHERE department_code = 'CSE' LIMIT 1");
    if (!departments.length) return sendJson(response, 500, { error: "CSE department is missing from the database." });

    const passwordHash = await bcrypt.hash(password, 10);
    await pool.execute(
      `INSERT INTO users (department_id, role_id, full_name, email, password_hash, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
      [departments[0].department_id, roles[0].role_id, name, email, passwordHash],
    );
    return sendJson(response, 201, { message: "General account created. You can now log in." });
  }

  if (request.method === "POST" && url.pathname === "/api/users") {
    const body = await readJson(request);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const roleNames = {
      "Faculty": "Faculty",
      "Student Coordinator": "Student Coordinator",
      "Placement Staff": "Placement Staff",
      "Admin": "Administrator",
      "Administrator": "Administrator",
    };
    const roleName = roleNames[String(body.role || "")] || "";
    const departmentCode = String(body.department || "CSE").trim().toUpperCase();
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 6 || !roleName) {
      return sendJson(response, 400, { error: "Name, email, role and a password of at least 6 characters are required." });
    }
    const [existing] = await pool.execute(
      `SELECT u.user_id
         FROM users u
         JOIN roles r ON r.role_id = u.role_id
        WHERE u.email = ? AND r.role_name = ?
        LIMIT 1`,
      [email, roleName],
    );
    if (existing.length) return sendJson(response, 409, { error: "An account with this email already exists." });
    await pool.execute("INSERT IGNORE INTO roles (role_name) VALUES (?)", [roleName]);
    const [roles] = await pool.execute("SELECT role_id FROM roles WHERE role_name = ? LIMIT 1", [roleName]);
    const [departments] = await pool.execute("SELECT department_id FROM departments WHERE department_code = ? LIMIT 1", [departmentCode]);
    if (!roles.length || !departments.length) return sendJson(response, 400, { error: "The selected role or department is not configured." });
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.execute(
      `INSERT INTO users (department_id, role_id, full_name, email, password_hash, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
      [departments[0].department_id, roles[0].role_id, name, email, passwordHash],
    );
    return sendJson(response, 201, { message: "User account created." });
  }

  if (request.method === "GET" && url.pathname === "/api/users") {
    const [rows] = await pool.query(
      `SELECT u.user_id AS id, u.full_name AS name, u.email, r.role_name AS role,
              d.department_code AS department, u.status
         FROM users u
         JOIN roles r ON r.role_id = u.role_id
         LEFT JOIN departments d ON d.department_id = u.department_id
        ORDER BY u.user_id DESC`,
    );
    return sendJson(response, 200, rows);
  }

  const userDeleteMatch = /^\/api\/users\/(\d+)$/.exec(url.pathname);
  if (request.method === "DELETE" && userDeleteMatch) {
    const body = await readJson(request);
    const userId = Number(userDeleteMatch[1]);
    const adminUserId = Number(body.adminUserId || 0);
    if (!userId || !adminUserId) return sendJson(response, 400, { error: "A valid user and administrator are required." });
    const [admins] = await pool.execute(
      `SELECT u.user_id
         FROM users u
         JOIN roles r ON r.role_id = u.role_id
        WHERE u.user_id = ? AND r.role_name = 'Administrator' AND u.status = 'active'
        LIMIT 1`,
      [adminUserId],
    );
    if (!admins.length) return sendJson(response, 403, { error: "Only an active administrator can delete users." });
    if (userId === adminUserId) return sendJson(response, 400, { error: "You cannot delete the current administrator account." });

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [usersToDelete] = await connection.execute("SELECT user_id FROM users WHERE user_id = ? LIMIT 1", [userId]);
      if (!usersToDelete.length) {
        await connection.rollback();
        return sendJson(response, 404, { error: "User not found." });
      }
      await connection.execute("DELETE FROM calendar_events WHERE created_by = ?", [userId]);
      await connection.execute("DELETE FROM post_approvals WHERE reviewer_id = ?", [userId]);
      await connection.execute("DELETE FROM posts WHERE created_by = ?", [userId]);
      const [result] = await connection.execute("DELETE FROM users WHERE user_id = ?", [userId]);
      await connection.commit();
      return sendJson(response, 200, { message: "User deleted.", deleted: result.affectedRows || 0 });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  const decisionMatch = /^\/api\/posts\/(\d+)\/decision$/.exec(url.pathname);
  if (request.method === "POST" && decisionMatch) {
    const body = await readJson(request);
    const decision = String(body.status || "").toLowerCase();
    const reviewerId = Number(body.reviewerId);
    if (!["approved", "rejected"].includes(decision) || !reviewerId) {
      return sendJson(response, 400, { error: "A valid decision and reviewer are required." });
    }
    const postId = Number(decisionMatch[1]);
    const [posts] = await pool.execute(
      "SELECT post_id, department_id, created_by, title, event_date, event_time, venue FROM posts WHERE post_id = ? LIMIT 1",
      [postId],
    );
    if (!posts.length) return sendJson(response, 404, { error: "Post not found." });
    const post = posts[0];
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `UPDATE posts
            SET status = ?, rejection_reason = ?, approved_at = CASE WHEN ? = 'approved' THEN NOW() ELSE approved_at END,
                updated_at = NOW()
          WHERE post_id = ?`,
        [decision, decision === "rejected" ? String(body.reason || "Needs revision as per faculty review.") : null, decision, postId],
      );
      await connection.execute(
        `INSERT INTO post_approvals (post_id, reviewer_id, decision, comments, reviewed_at)
         VALUES (?, ?, ?, ?, NOW())`,
        [postId, reviewerId, decision, body.reason || null],
      );
      if (decision === "approved" && post.event_date) {
        await connection.execute(
          `INSERT INTO calendar_events (department_id, post_id, created_by, event_title, event_date, event_time, venue, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')
           ON DUPLICATE KEY UPDATE event_title = VALUES(event_title), event_date = VALUES(event_date),
             event_time = VALUES(event_time), venue = VALUES(venue), status = 'approved', updated_at = NOW()`,
          [post.department_id, postId, post.created_by, post.title, post.event_date, post.event_time, post.venue],
        );
      }
      const decisionReason = decision === "rejected" ? String(body.reason || "Needs revision as per faculty review.") : null;
      if (decision === "approved") {
        await dispatchNotification({
          database: connection,
          action: "POST_APPROVED",
          eventName: post.title,
          recipientRoleNames: ["Student Coordinator"],
          actionPerformer: "Faculty",
          postId,
          notificationType: "approval",
          customTitle: `Post Approved: ${post.title}`,
          customMessage: `Post Approved: Your ${post.title} event has been approved by Faculty.`,
        });
        await dispatchNotification({
          database: connection,
          action: "GENERAL_EVENT_APPROVED",
          eventName: post.title,
          recipientRoleNames: ["General User"],
          actionPerformer: "Faculty",
          postId,
          eventDate: post.event_date,
          eventTime: post.event_time,
          venue: post.venue,
          notificationType: "approval",
          customTitle: `New Event: ${post.title}`,
          customMessage: `New Event: ${post.title} has been approved and is now available. Check the event details for more information.`,
        });
        await dispatchNotification({
          database: connection,
          action: "POST_APPROVED",
          eventName: post.title,
          recipientRoleNames: ["Administrator"],
          actionPerformer: "Faculty",
          postId,
          notificationType: "system",
          customTitle: `Post Approved: ${post.title}`,
          customMessage: `Post Approved: ${post.title} submitted by the Student Coordinator has been approved.`,
        });
      } else {
        await dispatchNotification({
          database: connection,
          action: "POST_REJECTED",
          eventName: post.title,
          recipientRoleNames: ["Student Coordinator"],
          actionPerformer: "Faculty",
          postId,
          rejectionReason: decisionReason,
          notificationType: "rejection",
          customTitle: `Post Rejected: ${post.title}`,
          customMessage: `Post Rejected: Your ${post.title} submission was rejected because ${decisionReason} Please update the post and resubmit it.`,
        });
        await dispatchNotification({
          database: connection,
          action: "POST_REJECTED",
          eventName: post.title,
          recipientRoleNames: ["Administrator"],
          actionPerformer: "Faculty",
          postId,
          rejectionReason: decisionReason,
          notificationType: "system",
          customTitle: `Post Rejected: ${post.title}`,
          customMessage: `Post Rejected: ${post.title} was rejected by Faculty because ${decisionReason}`,
        });
      }
      await connection.commit();
      await syncPostVector(postId);
      return sendJson(response, 200, { message: `Post ${decision}.` });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  const postUpdateMatch = /^\/api\/posts\/(\d+)$/.exec(url.pathname);
  if (request.method === "PUT" && postUpdateMatch) {
    const body = await readJson(request);
    const postId = Number(postUpdateMatch[1]);
    const postType = String(body.type || "event").toLowerCase();
    const allowedTypes = ["workshop", "seminar", "hackathon", "placement", "event", "achievement", "other"];
    const status = ["draft", "pending"].includes(String(body.status || "pending")) ? String(body.status) : "pending";
    if (!body.title || !allowedTypes.includes(postType)) return sendJson(response, 400, { error: "Title and a valid post type are required." });
    const [result] = await pool.execute(
      `UPDATE posts SET title = ?, post_type = ?, description = ?, caption = ?, poster_url = ?, event_date = NULLIF(?, ''),
              event_time = NULLIF(?, ''), venue = ?, status = ?, rejection_reason = NULL, submitted_at = NOW(), updated_at = NOW()
        WHERE post_id = ?`,
      [String(body.title).trim(), postType, body.description || null, body.caption || null, body.posterData || null, body.date || "", normalizeTime(body.time), body.venue || null, status, postId],
    );
    if (!result.affectedRows) return sendJson(response, 404, { error: "Post not found." });
    if (status === "pending") {
      await storePostEmbedding(postId, { title: body.title, type: postType, description: body.description, date: body.date, time: body.time, venue: body.venue });
    }
    await syncPostVector(postId);
    return sendJson(response, 200, { message: "Post updated.", id: postId });
  }

  if (request.method === "POST" && url.pathname === "/api/posts") {
    const body = await readJson(request);
    const userId = Number(body.userId);
    const postType = String(body.type || "event").toLowerCase();
    const allowedTypes = ["workshop", "seminar", "hackathon", "placement", "event", "achievement", "other"];
    const status = ["draft", "pending"].includes(String(body.status || "pending")) ? String(body.status) : "pending";
    if (!userId || !body.title || !allowedTypes.includes(postType)) return sendJson(response, 400, { error: "User, title and a valid post type are required." });
    const [users] = await pool.execute("SELECT department_id FROM users WHERE user_id = ? LIMIT 1", [userId]);
    if (!users.length || !users[0].department_id) return sendJson(response, 400, { error: "User department is missing." });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute(
        `INSERT INTO posts (department_id, created_by, title, post_type, description, caption, poster_url, event_date, event_time, venue, status, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULLIF(?, ''), NULLIF(?, ''), ?, ?, NOW())`,
        [users[0].department_id, userId, String(body.title).trim(), postType, body.description || null, body.caption || null, body.posterData || null,
          body.date || "", normalizeTime(body.time), body.venue || null, status],
      );
      const postId = Number(result.insertId);
      await dispatchNotification({
        database: connection,
        action: "POST_SUBMITTED",
        eventName: String(body.title).trim(),
        recipientRoleNames: ["Faculty", "Administrator"],
        actionPerformer: "Student Coordinator",
        postId,
        notificationType: "system",
        customTitle: `"${String(body.title).trim()}" submitted for approval`,
        customMessage: `New Post Awaiting Approval: ${String(body.title).trim()} submitted by the Student Coordinator is waiting for your review.`,
      });
      await connection.commit();
      if (status === "pending") {
        await storePostEmbedding(postId, { title: body.title, type: postType, description: body.description, date: body.date, time: body.time, venue: body.venue });
      }
      return sendJson(response, 201, { message: "Post created.", id: postId });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  if (request.method === "GET" && url.pathname === "/api/notifications") {
    const userId = Number(url.searchParams.get("userId") || "0");
    if (!userId) return sendJson(response, 400, { error: "A valid userId is required." });
    const [rows] = await pool.execute(
      `SELECT notification_id AS id, user_id, post_id, notification_type, title, message, is_read,
              DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
         FROM notifications
        WHERE user_id = ?
        ORDER BY created_at DESC` ,
      [userId],
    );
    return sendJson(response, 200, rows.map((row) => ({
      id: row.id,
      user_id: row.user_id,
      post_id: row.post_id,
      type: row.notification_type,
      title: row.title,
      message: row.message,
      read: Boolean(row.is_read),
      created_at: row.created_at,
    })));
  }

  const likeMatch = /^\/api\/posts\/(\d+)\/like$/.exec(url.pathname);
  if (request.method === "POST" && likeMatch) {
    const body = await readJson(request);
    const postId = Number(likeMatch[1]);
    const userId = Number(body.userId);
    if (!postId || !userId) return sendJson(response, 400, { error: "Post and user are required." });
    const [users] = await pool.execute(
      `SELECT u.user_id FROM users u JOIN roles r ON r.role_id = u.role_id
        WHERE u.user_id = ? AND r.role_name = 'General User' AND u.status = 'active' LIMIT 1`,
      [userId],
    );
    if (!users.length) return sendJson(response, 403, { error: "Only general users can like approved posts." });
    const [posts] = await pool.execute(
      "SELECT post_id, title, description, DATE_FORMAT(event_date, '%Y-%m-%d') AS event_date, event_time, venue FROM posts WHERE post_id = ? AND status IN ('approved', 'scheduled', 'published') LIMIT 1",
      [postId],
    );
    if (!posts.length) return sendJson(response, 404, { error: "Approved post not found." });
    if (body.liked) {
      await pool.execute("INSERT IGNORE INTO post_likes (post_id, user_id) VALUES (?, ?)", [postId, userId]);
    } else {
      await pool.execute("DELETE FROM post_likes WHERE post_id = ? AND user_id = ?", [postId, userId]);
    }
    const [[result]] = await pool.execute("SELECT COUNT(*) AS likes FROM post_likes WHERE post_id = ?", [postId]);
    return sendJson(response, 200, { liked: Boolean(body.liked), likes: Number(result.likes) });
  }

  const registrationMatch = /^\/api\/posts\/(\d+)\/registration$/.exec(url.pathname);
  if (request.method === "POST" && registrationMatch) {
    const body = await readJson(request);
    const postId = Number(registrationMatch[1]);
    const userId = Number(body.userId);
    const registrationUrl = String(body.registrationUrl || "").trim().slice(0, 1000) || null;
    if (!postId || !userId) return sendJson(response, 400, { error: "Post and user are required." });
    const [users] = await pool.execute(
      `SELECT u.user_id FROM users u JOIN roles r ON r.role_id = u.role_id
        WHERE u.user_id = ? AND r.role_name = 'General User' AND u.status = 'active' LIMIT 1`,
      [userId],
    );
    if (!users.length) return sendJson(response, 403, { error: "Only general users can register for events." });
    const [posts] = await pool.execute(
      "SELECT post_id, title, description, DATE_FORMAT(event_date, '%Y-%m-%d') AS event_date, TIME_FORMAT(event_time, '%H:%i:%s') AS event_time, venue FROM posts WHERE post_id = ? AND status IN ('approved', 'scheduled', 'published') LIMIT 1",
      [postId],
    );
    if (!posts.length) return sendJson(response, 404, { error: "Approved event not found." });
    const [registrationResult] = await pool.execute(
      "INSERT INTO event_registrations (post_id, user_id, registration_url) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE registration_url = VALUES(registration_url)",
      [postId, userId, registrationUrl],
    );
    const [[registration]] = await pool.execute(
      "SELECT registration_id FROM event_registrations WHERE post_id = ? AND user_id = ? LIMIT 1",
      [postId, userId],
    );
    const calendar = await syncRegistrationToGoogle({ registrationId: registration.registration_id, userId, post: posts[0] });
    return sendJson(response, 201, { registered: true, postId, registrationId: registration.registration_id || registrationResult.insertId, calendar });
  }

  if (request.method === "GET" && url.pathname === "/api/registrations") {
    const userId = Number(url.searchParams.get("userId") || "0");
    if (!userId) return sendJson(response, 400, { error: "A valid user is required." });
    const [rows] = await pool.execute(
            `SELECT p.post_id AS id, p.title, p.post_type AS type, p.poster_url AS posterUrl,
              DATE_FORMAT(p.event_date, '%d %b %Y') AS date,
              TIME_FORMAT(p.event_time, '%h:%i %p') AS time, p.venue,
              er.registered_at AS registeredAt, er.calendar_sync_status AS calendarSyncStatus,
              er.google_calendar_event_id AS googleCalendarEventId
         FROM event_registrations er
         JOIN posts p ON p.post_id = er.post_id
        WHERE er.user_id = ?
          AND p.event_date >= CURDATE()
        ORDER BY p.event_date ASC, p.event_time ASC`,
      [userId],
    );
    return sendJson(response, 200, rows);
  }

  if (request.method === "GET" && url.pathname === "/api/analytics") {
    const userId = Number(url.searchParams.get("userId") || "0");
    const [summaryRows] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM post_likes pl JOIN posts lp ON lp.post_id = pl.post_id
           WHERE lp.status IN ('approved', 'scheduled', 'published')) AS total_likes,
         (SELECT COUNT(*) FROM users u JOIN roles r ON r.role_id = u.role_id
           WHERE r.role_name = 'General User' AND u.status = 'active') AS general_users,
         (SELECT COUNT(*) FROM posts WHERE status IN ('approved', 'scheduled', 'published')) AS published_posts`,
    );
    const [postRows] = await pool.query(
      `SELECT p.post_id AS id, p.title, p.post_type AS type, COUNT(pl.user_id) AS likes,
              ${userId ? "MAX(CASE WHEN pl.user_id = ? THEN 1 ELSE 0 END)" : "0"} AS liked
         FROM posts p LEFT JOIN post_likes pl ON pl.post_id = p.post_id
        WHERE p.status IN ('approved', 'scheduled', 'published')
        GROUP BY p.post_id, p.title, p.post_type
        ORDER BY likes DESC, p.updated_at DESC`,
      userId ? [userId] : [],
    );
    return sendJson(response, 200, { summary: summaryRows[0], posts: postRows });
  }

  if (request.method === "POST" && url.pathname === "/api/notifications/read") {
    const body = await readJson(request);
    const userId = Number(body.userId || 0);
    const ids = Array.isArray(body.notificationIds) ? body.notificationIds.map((id) => Number(id)).filter(Boolean) : [];
    if (!userId || !ids.length) return sendJson(response, 200, { updated: 0 });
    const placeholders = ids.map(() => "?").join(", ");
    const [result] = await pool.execute(
      `UPDATE notifications
          SET is_read = 1
        WHERE user_id = ? AND notification_id IN (${placeholders})`,
      [userId, ...ids],
    );
    return sendJson(response, 200, { updated: result.affectedRows || 0 });
  }

  if (request.method === "POST" && url.pathname === "/api/notifications/clear") {
    const body = await readJson(request);
    const userId = Number(body.userId || 0);
    if (!userId) return sendJson(response, 400, { error: "A valid userId is required." });
    const [result] = await pool.execute("DELETE FROM notifications WHERE user_id = ?", [userId]);
    return sendJson(response, 200, { deleted: result.affectedRows || 0 });
  }

  const scheduleMatch = /^\/api\/posts\/(\d+)\/schedule$/.exec(url.pathname);
  if (request.method === "POST" && scheduleMatch) {
    return sendJson(response, 403, { error: "Calendar events are created automatically when a post is approved. Manual calendar editing is disabled." });
  }

  if (request.method === "POST" && url.pathname === "/api/calendar") {
    return sendJson(response, 403, { error: "Calendar events are created automatically when a post is approved. Manual calendar editing is disabled." });
  }

  if (request.method === "GET" && url.pathname === "/api/posts") {
    const workflow = url.searchParams.get("workflow") === "1";
    const userId = Number(url.searchParams.get("userId") || "0");
    const [rows] = await pool.query(
            `SELECT p.post_id AS id, p.created_by, p.title, p.post_type AS type, u.full_name AS author, p.poster_url,
              DATE_FORMAT(p.event_date, '%d %b %Y') AS date, TIME_FORMAT(p.event_time, '%h:%i %p') AS time,
              p.venue, p.status, p.caption, p.description AS description, p.rejection_reason,
              (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.post_id) AS likes_count,
              ${userId ? "EXISTS (SELECT 1 FROM post_likes upl WHERE upl.post_id = p.post_id AND upl.user_id = ?)" : "FALSE"} AS liked,
              (SELECT pa.decision FROM post_approvals pa WHERE pa.post_id = p.post_id ORDER BY pa.reviewed_at DESC, pa.approval_id DESC LIMIT 1) AS approval_decision
         FROM posts p
         JOIN users u ON u.user_id = p.created_by
        WHERE ${workflow ? "1 = 1" : "p.status IN ('approved', 'scheduled', 'published') AND p.event_date >= CURDATE()"}
        ORDER BY p.event_date ASC, p.event_time ASC`,
      userId ? [userId] : [],
    );
    return sendJson(response, 200, rows);
  }

  if (request.method === "GET" && url.pathname === "/api/calendar") {
    const [rows] = await pool.query(
      `SELECT calendar_event_id AS id, event_title AS title, event_date AS date,
              event_time AS time, venue, status
         FROM calendar_events
        WHERE status IN ('scheduled', 'approved')
        ORDER BY event_date ASC, event_time ASC`,
    );
    return sendJson(response, 200, rows);
  }

  return sendJson(response, 404, { error: "API route not found." });
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error(error.stack || error);
    sendJson(response, 500, {
      error: process.env.NODE_ENV === "production" ? "Internal server error." : `Database request failed: ${error.message}`,
    });
  });
});

ensureSchemaCompatibility()
  .then(() => {
    syncApprovedPostsToChroma(pool)
      .then((result) => console.log(`ChromaDB event index synchronized: ${result.indexed} indexed, ${result.removed} stale entries removed.`))
      .catch((error) => console.warn("ChromaDB startup synchronization failed. Chat semantic search will be unavailable until ChromaDB is running:", error.message));
    removeExpiredEvents().catch((error) => {
      console.error("Initial expired-event cleanup failed:", error.stack || error);
    });
    const expiredEventCleanupTimer = setInterval(() => {
      removeExpiredEvents().catch((error) => {
        console.error("Scheduled expired-event cleanup failed:", error.stack || error);
      });
    }, 60 * 60 * 1000);
    expiredEventCleanupTimer.unref();
    server.listen(port, () => {
      console.log(`KARE CSE API listening on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error("Database schema compatibility check failed:", error.stack || error);
    console.error("The API will still start. Set DB_PASSWORD in .env and restart to enable database-backed features.");
    server.listen(port, () => {
      console.log(`KARE CSE API listening on http://localhost:${port} (database unavailable)`);
    });
  });