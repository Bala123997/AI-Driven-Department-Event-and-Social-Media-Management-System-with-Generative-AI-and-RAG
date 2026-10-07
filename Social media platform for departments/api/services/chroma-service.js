import { ChromaClient } from "chromadb";
import { createPostText, generateEmbedding, parseEmbedding, EMBEDDING_MODEL } from "./similarity-service.js";

const CHROMA_HOST = process.env.CHROMA_HOST || "127.0.0.1";
const CHROMA_PORT = Number(process.env.CHROMA_PORT || 8000);
const COLLECTION_NAME = process.env.CHROMA_COLLECTION || "kare_approved_events";
const MIN_SIMILARITY = Number(process.env.CHROMA_MIN_SIMILARITY || 0.05);
const chroma = new ChromaClient({ host: CHROMA_HOST, port: CHROMA_PORT });
let collectionPromise;
const externalEmbeddingFunction = {
  generate: async (texts) => {
    const normalizedTexts = Array.isArray(texts) ? texts : [texts];
    return await Promise.all(
      normalizedTexts.map(async (text) => {
        const input = typeof text === "string" ? text : String(text ?? "");
        return generateEmbedding(input);
      }),
    );
  },
};

function getCollection() {
  collectionPromise ??= chroma.getOrCreateCollection({
      name: COLLECTION_NAME,
      metadata: { "hnsw:space": "cosine" },
      embeddingFunction: externalEmbeddingFunction,
    });
  return collectionPromise;
}

function formatDate(value) {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  return String(value || "").slice(0, 10);
}

function dateKey(value) {
  return Number(formatDate(value).replaceAll("-", ""));
}

export function buildChromaWhereFilter(scope) {
  return {
    $and: [
      { status: { $in: ["approved", "scheduled", "published"] } },
      { event_date_key: { $gte: dateKey(scope.start) } },
      { event_date_key: { $lte: dateKey(scope.end) } },
    ],
  };
}

function getEventMetadata(post) {
  return {
    post_id: Number(post.post_id),
    title: String(post.title || ""),
    post_type: String(post.post_type || "event"),
    event_date: formatDate(post.event_date),
    event_date_key: dateKey(post.event_date),
    status: String(post.status || "approved"),
  };
}

export async function upsertApprovedPost(post, embedding) {
  const collection = await getCollection();
  const vector = embedding || await generateEmbedding(createPostText(post));
  await collection.upsert({
    ids: [String(post.post_id)],
    embeddings: [vector],
    documents: [createPostText(post)],
    metadatas: [getEventMetadata(post)],
  });
}

export async function removePostFromChroma(postId) {
  const collection = await getCollection();
  await collection.delete({ ids: [String(postId)] });
}

export async function retrieveRelevantPostIds(questionEmbedding, scope, limit = 5) {
  try {
    const collection = await getCollection();
    const result = await collection.query({
      queryEmbeddings: [questionEmbedding],
      nResults: limit,
      where: buildChromaWhereFilter(scope),
      include: ["distances"],
    });
    const ids = result.ids?.[0] || [];
    const distances = result.distances?.[0] || [];
    const maxDistance = 1 - MIN_SIMILARITY;
    return ids.filter((_, index) => Number.isFinite(distances[index]) && distances[index] <= maxDistance);
  } catch (error) {
    error.code = "CHROMA_UNAVAILABLE";
    throw error;
  }
}

export async function syncApprovedPostsToChroma(database) {
  const collection = await getCollection();
  const [posts] = await database.query(
    `SELECT post_id, title, post_type, description, event_date, event_time, venue, status,
            ai_embedding, ai_embedding_model
       FROM posts
      WHERE status IN ('approved', 'scheduled', 'published')
        AND event_date IS NOT NULL
      ORDER BY post_id`,
  );

  for (const post of posts) {
    const storedEmbedding = post.ai_embedding_model === EMBEDDING_MODEL ? parseEmbedding(post.ai_embedding) : null;
    await upsertApprovedPost(post, storedEmbedding);
  }

  const currentIds = new Set(posts.map((post) => String(post.post_id)));
  const staleIds = [];
  const totalVectors = await collection.count();
  for (let offset = 0; offset < totalVectors; offset += 1000) {
    const existing = await collection.get({ limit: 1000, offset, include: ["metadatas"] });
    staleIds.push(...(existing.ids || []).filter((id) => !currentIds.has(id)));
  }
  for (let offset = 0; offset < staleIds.length; offset += 100) {
    await collection.delete({ ids: staleIds.slice(offset, offset + 100) });
  }

  return { indexed: posts.length, removed: staleIds.length };
}

export { CHROMA_HOST, CHROMA_PORT, COLLECTION_NAME };