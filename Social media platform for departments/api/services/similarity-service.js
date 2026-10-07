import { pipeline } from "@huggingface/transformers";

const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const DUPLICATE_THRESHOLD = 0.85;
const SIMILAR_THRESHOLD = 0.75;
let embeddingPipelinePromise;

function getEmbeddingPipeline() {
  embeddingPipelinePromise ??= pipeline("feature-extraction", EMBEDDING_MODEL, { quantized: true });
  return embeddingPipelinePromise;
}

export function createPostText(post) {
  return [
    `Title: ${post.title || ""}`,
    `Description: ${post.description || ""}`,
    `Category: ${post.post_type || post.type || ""}`,
    `Event Date: ${post.event_date || post.date || ""}`,
    `Event Time: ${post.event_time || post.time || ""}`,
    `Venue: ${post.venue || ""}`,
  ].join("\n").trim();
}

export async function generateEmbedding(text) {
  const extractor = await getEmbeddingPipeline();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dotProduct += a[index] * b[index];
    magnitudeA += a[index] * a[index];
    magnitudeB += b[index] * b[index];
  }
  if (magnitudeA === 0 || magnitudeB === 0) return 0;
  return dotProduct / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

export function parseEmbedding(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function classifySimilarity(score) {
  if (score >= DUPLICATE_THRESHOLD) return "high";
  if (score >= SIMILAR_THRESHOLD) return "possible";
  return "low";
}

export { DUPLICATE_THRESHOLD, EMBEDDING_MODEL, SIMILAR_THRESHOLD };
