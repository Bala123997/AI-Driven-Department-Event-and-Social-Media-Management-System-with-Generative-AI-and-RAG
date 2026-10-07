import { cosineSimilarity, parseEmbedding } from "./similarity-service.js";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:3b";
export const RAG_TOP_K = 5;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function buildRagContext(posts) {
  return (posts || []).map((post, index) => {
    const title = post.title || "Department Event";
    const date = post.event_date || post.date || "Date not provided";
    const time = post.event_time || post.time || "Time not provided";
    const venue = post.venue || "Venue not provided";
    const type = post.post_type || post.type || "event";
    const description = post.description || "No additional description provided.";
    return [
      `Source ${index + 1}:`,
      `Title: ${title}`,
      `Type: ${type}`,
      `Date: ${date}`,
      `Time: ${time}`,
      `Venue: ${venue}`,
      `Description: ${description}`,
    ].join("\n");
  }).join("\n\n");
}

export function buildUserRagContext({ calendarEvents = [], registeredEvents = [] }) {
  const calendarContext = buildRagContext(calendarEvents);
  const registrationContext = registeredEvents.length
    ? registeredEvents.map((event, index) => [
      `Registration ${index + 1}:`,
      `Title: ${event.title || "Department Event"}`,
      `Date: ${event.event_date || "Date not provided"}`,
      `Time: ${event.event_time || "Time not provided"}`,
      `Venue: ${event.venue || "Venue not provided"}`,
    ].join("\n")).join("\n\n")
    : "No upcoming registered events for this user.";

  return `APPROVED EVENTS IN THE CURRENT CALENDAR:\n${calendarContext || "No approved events in the requested calendar period."}\n\nEVENTS REGISTERED BY THIS USER:\n${registrationContext}`;
}

function toDate(value) {
  if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
  if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(NaN) : new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function formatDate(date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

function formatTime(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ""));
  if (!match) return "time not provided";
  const hour = Number(match[1]);
  const minute = match[2];
  if (hour > 23) return "time not provided";
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${minute} ${suffix}`;
}

function formatDisplayDate(date) {
  return Number.isNaN(date.getTime())
    ? "date not provided"
    : `${date.getDate()} ${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
}

export function getCalendarScope(question, currentDate) {
  const date = toDate(currentDate);
  const normalizedQuestion = String(question || "").toLowerCase();
  let scope = "current-and-next-month";
  let start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  let end = new Date(date.getFullYear(), date.getMonth() + 2, 0);

  if (/\bthis month\b|\bcurrent month\b/.test(normalizedQuestion)) {
    scope = "current-month";
    end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  } else if (/\bnext month\b|\bfollowing month\b/.test(normalizedQuestion)) {
    scope = "next-month";
    start = new Date(date.getFullYear(), date.getMonth() + 1, 1);
    end = new Date(date.getFullYear(), date.getMonth() + 2, 0);
  }

  return { scope, start: formatDate(start), end: formatDate(end) };
}

export function isRegistrationQuestion(question) {
  return /\b(my|i|me)\b.*\b(register|registration|registered|registred|signup|signed up)\b|\b(register|registration|registered|registred|signup|signed up)\b.*\b(my|i|me)\b/i.test(String(question || ""));
}

export function isRegistrationStatusQuestion(question) {
  return /\b(register|registration|registered|registred|signup|signed up)\b/i.test(String(question || ""));
}

export function getRegistrationFilter(question) {
  const normalizedQuestion = String(question || "").toLowerCase();
  const categories = ["hackathon", "workshop", "seminar", "placement", "achievement"];
  if (/\bhack ?tons?\b|\bhackathons?\b/i.test(normalizedQuestion)) return "hackathon";
  return categories.find((value) => new RegExp(`\\b${value}s?\\b`, "i").test(normalizedQuestion)) || "";
}

export function filterRegisteredEvents(events, question) {
  const category = getRegistrationFilter(question);
  if (!category) return events;
  return events.filter((event) => {
    const searchableText = [event.post_type, event.title, event.description].join(" ").toLowerCase();
    return searchableText.includes(category);
  });
}

export function formatRegisteredEvents(events, emptyMessage = "You are not registered for any upcoming events.") {
  if (!events.length) return emptyMessage;
  const details = events.map((event) => {
    const date = formatDisplayDate(toDate(event.event_date));
    const time = formatTime(event.event_time);
    return `${event.title} (${date}, ${time})`;
  });
  return details.join("\n");
}

export function isCalendarListQuestion(question) {
  return /\b(what|which|show|list|tell me|are there)\b.*\b(event|events|happening|scheduled|calendar|upcoming)\b|\b(upcoming|calendar)\b.*\b(event|events|happening|scheduled)\b/i.test(String(question || ""));
}

export function isCalendarCountQuestion(question) {
  return /\bhow many\b.*\b(event|events)\b/i.test(String(question || ""));
}

export function isEventTypeQuestion(question) {
  return /\b(is|was|what type|what kind|category|categorized|classified)\b.*\b(hackathon|workshop|seminar|placement|achievement|event)\b/i.test(String(question || ""));
}

export function findEventTypeMatches(question, posts) {
  const normalizedQuestion = String(question || "").toLowerCase();
  const typeWords = new Set(["is", "was", "what", "type", "kind", "category", "categorized", "classified", "a", "an", "the", "this", "event", "hackathon", "workshop", "seminar", "placement", "achievement"]);
  const words = normalizedQuestion.match(/[a-z0-9]+/g)?.filter((word) => word.length > 2 && !typeWords.has(word)) || [];
  if (!words.length) return [];
  return posts
    .map((post) => {
      const title = String(post.title || "").toLowerCase();
      const score = words.reduce((total, word) => total + (title.includes(word) ? 1 : 0), 0);
      return { post, score };
    })
    .filter((item) => item.score === words.length)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.post);
}

export function formatEventTypeAnswer(event, requestedType = "") {
  if (!event) return "I couldn't find that event in the current approved calendar.";
  const actualType = String(event.post_type || "event").toLowerCase();
  const label = actualType.charAt(0).toUpperCase() + actualType.slice(1);
  const article = /^[aeiou]/i.test(label) ? "an" : "a";
  if (requestedType && actualType === requestedType) return `Yes. ${event.title} is ${article} ${label}.`;
  if (requestedType) return `No. ${event.title} is ${article} ${label}, not a ${requestedType}.`;
  return `${event.title} is a ${label}.`;
}

function formatEventDate(value) {
  const date = toDate(value);
  return formatDisplayDate(date);
}

export function formatCalendarEvents(events) {
  if (!events.length) return "I couldn't find any upcoming events in the requested calendar period.";
  const details = events.map((event) => {
    const date = formatEventDate(event.event_date);
    const time = formatTime(event.event_time);
    return `${event.title} (${date}, ${time})`;
  });
  return details.join("\n");
}

export function findKeywordMatches(question, posts) {
  const ignoredWords = new Set(["what", "when", "where", "which", "who", "is", "are", "the", "this", "next", "month", "current", "upcoming", "events", "event", "happening", "scheduled", "in", "for", "on", "at", "and", "or", "about", "tell", "me", "show", "list"]);
  const words = String(question || "").toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => word.length > 2 && !ignoredWords.has(word)) || [];
  if (!words.length) return [];
  return posts
    .map((post) => {
      const haystack = [post.title, post.post_type, post.description, post.venue].join(" ").toLowerCase();
      const score = words.reduce((total, word) => total + (haystack.includes(word) ? 1 : 0), 0);
      return { post, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.post);
}

export function selectRelevantPosts(questionEmbedding, posts, limit = 5) {
  if (!Array.isArray(questionEmbedding) || !questionEmbedding.length || !Array.isArray(posts) || !posts.length) {
    return [];
  }

  return posts
    .map((post) => {
      const embedding = parseEmbedding(post.ai_embedding);
      const similarity = embedding ? cosineSimilarity(questionEmbedding, embedding) : 0;
      return { ...post, similarity };
    })
    .filter((post) => Number.isFinite(post.similarity) && post.similarity > 0.05)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

export function mapRetrievedPosts(retrievedIds, approvedPosts, limit = RAG_TOP_K) {
  const postsById = new Map((approvedPosts || []).map((post) => [String(post.post_id), post]));
  const seenIds = new Set();
  const maxResults = Number.isInteger(limit) && limit > 0 ? limit : RAG_TOP_K;
  return (retrievedIds || []).filter((postId) => {
    const id = String(postId);
    if (seenIds.has(id) || !postsById.has(id)) return false;
    seenIds.add(id);
    return true;
  }).slice(0, maxResults).map((postId) => postsById.get(String(postId)));
}

export function evaluateRetrieval(retrievedIds, relevantIds, k = 5) {
  const cutoff = Number.isInteger(k) && k > 0 ? k : 5;
  const relevant = new Set((relevantIds || []).map(String));
  const ranked = [...new Set((retrievedIds || []).map(String))].slice(0, cutoff);
  const hits = ranked.filter((id) => relevant.has(id)).length;
  const firstRelevantRank = ranked.findIndex((id) => relevant.has(id));

  return {
    precisionAtK: hits / cutoff,
    recallAtK: relevant.size ? hits / relevant.size : 0,
    reciprocalRank: firstRelevantRank === -1 ? 0 : 1 / (firstRelevantRank + 1),
  };
}

export function buildRagPrompt(question, context, currentDate = new Date(), scope = getCalendarScope(question, currentDate)) {
  const date = currentDate instanceof Date ? currentDate : new Date(currentDate);
  const currentDateText = Number.isNaN(date.getTime()) ? "Current date unavailable" : date.toISOString().slice(0, 10);
  return `Current date: ${currentDateText}\nRequested calendar scope: ${scope.scope}\nOnly events dated from ${scope.start} through ${scope.end} are available.\nDo not include events outside this date range.\n\nUser question:\n${question}\n\nDepartment calendar information:\n${context}`;
}

export function buildRagSystemPrompt() {
  return `You are a KARE CSE department assistant.

Answer only using the provided department information.
The context contains only retrieved approved calendar events from the requested date scope.
Use those events for general event, date, venue, description, and schedule questions.
The current date and requested calendar scope are provided in the user message. Treat them as authoritative.
If the user asks for this month, answer only with events in this month. If the user asks for next month, answer only with events in next month.
Do not mention or recommend events whose date has already passed.
Do not assume the month or use general world knowledge.
If the answer cannot be found in the provided information, say that the information is not available.
Do not invent event dates, venues, registration links, organizers, fees, or other department information.
Keep the answer concise, clear, and helpful for a general user.
If multiple relevant events exist, list the most relevant ones clearly.
Return only the final answer text without quoting the source material.`;
}

export async function generateRagAnswer({ question, context, currentDate, scope }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        options: { temperature: 0.2, num_predict: 240 },
        messages: [
          { role: "system", content: buildRagSystemPrompt() },
          { role: "user", content: buildRagPrompt(question, context, currentDate, scope) },
        ],
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(
        response.status === 404
          ? `The local model ${OLLAMA_MODEL} is not installed. Run: ollama pull ${OLLAMA_MODEL}`
          : (data.error || `Ollama returned HTTP ${response.status}.`),
      );
      error.code = response.status === 404 ? "OLLAMA_MODEL_NOT_FOUND" : "OLLAMA_ERROR";
      throw error;
    }

    const text = String(data.message?.content || "").trim();
    if (!text) throw new Error("Ollama returned an empty response.");
    return text;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("The AI assistant timed out. Please try again.");
      timeoutError.code = "OLLAMA_TIMEOUT";
      throw timeoutError;
    }
    if (error.code === "ECONNREFUSED" || error.cause?.code === "ECONNREFUSED" || error.message?.includes("fetch failed")) {
      const unavailableError = new Error("The AI assistant is unavailable. Start Ollama and try again.");
      unavailableError.code = "OLLAMA_UNAVAILABLE";
      throw unavailableError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export { OLLAMA_MODEL, OLLAMA_URL };
