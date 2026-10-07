const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:3b";

function buildCaptionPrompt(event) {
  return `You are an AI caption generator for the KARE CSE Department Event Manager.

Generate a professional and engaging social-media caption using ONLY the information provided below.

Event Title: ${event.title || "Not provided"}
Description: ${event.description || "Not provided"}
Category: ${event.category || event.type || "Not provided"}
Date: ${event.date || "Not provided"}
Time: ${event.time || "Not provided"}
Venue: ${event.venue || "Not provided"}

Requirements:
1. Start with an engaging event heading.
2. Clearly mention the event purpose.
3. Include the provided date, time, and venue.
4. Use a professional college tone.
5. Add a short call-to-action.
6. Add 3 to 6 relevant hashtags.
7. Do not invent speakers, guests, prizes, registration links, organizers, or other information.
8. Keep the caption concise, under 120 words.
9. Return only the final caption, without quotation marks or commentary.`;
}

function buildDescriptionPrompt(event) {
  return `You are an AI event description writer for the KARE CSE Department Event Manager.

Write a clear, informative description using ONLY the information provided below.

Event Title: ${event.title || "Not provided"}
Category: ${event.category || event.type || "Not provided"}
Date: ${event.date || "Not provided"}
Time: ${event.time || "Not provided"}
Venue: ${event.venue || "Not provided"}

Requirements:
1. Explain the purpose and value of the event without inventing facts.
2. Use a professional college tone.
3. Mention the provided event details naturally.
4. Keep it between 40 and 80 words.
5. Return only the description, without a heading or commentary.`;
}

async function generateText(prompt, systemMessage) {
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
        options: { temperature: 0.4, num_predict: 220 },
        messages: [
          { role: "system", content: systemMessage },
          { role: "user", content: prompt },
        ],
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(response.status === 404
        ? `The local model ${OLLAMA_MODEL} is not installed. Run: ollama pull ${OLLAMA_MODEL}`
        : (data.error || `Ollama returned HTTP ${response.status}.`));
      error.code = response.status === 404 ? "OLLAMA_MODEL_NOT_FOUND" : "OLLAMA_ERROR";
      throw error;
    }
    const text = String(data.message?.content || "").trim();
    if (!text) throw new Error("Ollama returned an empty response.");
    return text;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("AI generation timed out. Please try again.");
      timeoutError.code = "OLLAMA_TIMEOUT";
      throw timeoutError;
    }
    if (error.code === "ECONNREFUSED" || error.cause?.code === "ECONNREFUSED" || error.message?.includes("fetch failed")) {
      const unavailableError = new Error("AI generator is unavailable. Start Ollama and try again.");
      unavailableError.code = "OLLAMA_UNAVAILABLE";
      throw unavailableError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateCaption(event) {
  return generateText(buildCaptionPrompt(event), "You write accurate, concise college event captions.");
}

export async function generateDescription(event) {
  return generateText(buildDescriptionPrompt(event), "You write accurate, informative college event descriptions.");
}

export { OLLAMA_MODEL, OLLAMA_URL };
