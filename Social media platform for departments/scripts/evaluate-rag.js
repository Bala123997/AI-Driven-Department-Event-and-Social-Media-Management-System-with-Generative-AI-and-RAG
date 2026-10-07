import "dotenv/config";
import { readFile } from "node:fs/promises";
import mysql from "mysql2/promise";
import { buildUserRagContext, evaluateRetrieval, generateRagAnswer, getCalendarScope, mapRetrievedPosts, OLLAMA_MODEL, OLLAMA_URL, RAG_TOP_K } from "../api/services/rag-service.js";
import { retrieveRelevantPostIds } from "../api/services/chroma-service.js";
import { generateEmbedding } from "../api/services/similarity-service.js";

const datasetPath = new URL("../tests/fixtures/rag-evaluation.json", import.meta.url);
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
const database = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "kare_cse_social",
});

async function judgeAnswer({ question, context, answer }) {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      format: "json",
      options: { temperature: 0 },
      messages: [
        {
          role: "system",
          content: "Evaluate a RAG answer using only the supplied evidence. Score faithfulness from 1 (unsupported or contradicted) to 5 (all factual claims supported), and answer_relevance from 1 (unrelated) to 5 (directly answers the question). Return JSON with integer keys faithfulness and answer_relevance, plus a short rationale.",
        },
        {
          role: "user",
          content: JSON.stringify({ question, evidence: context, answer }),
        },
      ],
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Ollama judge returned HTTP ${response.status}.`);
  const content = payload.message?.content;
  if (!content) throw new Error("Ollama judge returned an empty response.");
  const result = JSON.parse(content);
  for (const scoreName of ["faithfulness", "answer_relevance"]) {
    if (!Number.isInteger(result[scoreName]) || result[scoreName] < 1 || result[scoreName] > 5) {
      throw new Error(`Ollama judge returned an invalid ${scoreName} score.`);
    }
  }
  return result;
}

try {
  const [[databaseDate]] = await database.query("SELECT CURDATE() AS today");
  const results = [];

  for (const example of dataset) {
    const scope = getCalendarScope(example.question, databaseDate.today);
    const [posts] = await database.query(
      `SELECT post_id, title, post_type, description, event_date, event_time, venue
         FROM posts
        WHERE status IN ('approved', 'scheduled', 'published')
          AND event_date BETWEEN ? AND ?
        ORDER BY event_date ASC, event_time ASC`,
      [scope.start, scope.end],
    );
    const relevanceLabels = posts.filter((post) =>
      example.relevantTitleContains.some((label) => post.title.toLowerCase().includes(label.toLowerCase())),
    );

    if (!relevanceLabels.length) {
      console.warn(`SKIP ${example.id}: no labeled title exists in the requested date scope (${scope.start} through ${scope.end}).`);
      continue;
    }

    const questionEmbedding = await generateEmbedding(example.question);
    const retrievedIds = await retrieveRelevantPostIds(questionEmbedding, scope, RAG_TOP_K);
    const retrievedPosts = mapRetrievedPosts(retrievedIds, posts, RAG_TOP_K);
    const context = buildUserRagContext({ calendarEvents: retrievedPosts });
    const answer = await generateRagAnswer({ question: example.question, context, currentDate: databaseDate.today, scope });
    const retrieval = evaluateRetrieval(retrievedIds, relevanceLabels.map((post) => post.post_id), RAG_TOP_K);
    const quality = await judgeAnswer({ question: example.question, context, answer });

    results.push({ id: example.id, retrieval, quality, answer, rationale: quality.rationale });
    console.log(JSON.stringify(results.at(-1)));
  }

  if (!results.length) throw new Error("No labeled evaluation cases matched approved events in their requested scopes.");

  const mean = (key) => results.reduce((total, result) => total + result[key], 0) / results.length;
  const meanRetrieval = (key) => results.reduce((total, result) => total + result.retrieval[key], 0) / results.length;
  console.log(JSON.stringify({
    evaluated: results.length,
    topK: RAG_TOP_K,
    precisionAtK: meanRetrieval("precisionAtK"),
    recallAtK: meanRetrieval("recallAtK"),
    mrr: meanRetrieval("reciprocalRank"),
    meanFaithfulness: results.reduce((total, result) => total + result.quality.faithfulness, 0) / results.length,
    meanAnswerRelevance: results.reduce((total, result) => total + result.quality.answer_relevance, 0) / results.length,
  }, null, 2));
} finally {
  await database.end();
}