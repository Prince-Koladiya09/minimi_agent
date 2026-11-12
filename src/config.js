
import "dotenv/config";

function positiveInt(value, fallback, name) {
  const parsed = Number(value || fallback);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function modelList(value) {
  return String(value || "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
}

export const config = {
  port: positiveInt(process.env.PORT, 3000, "PORT"),

  // Gemini primary and fallback models.
  geminiApiKey: process.env.GEMINI_API_KEY || "",

  geminiBaseUrl:
    process.env.GEMINI_BASE_URL ||
    "https://generativelanguage.googleapis.com/v1beta/openai/",

  geminiModel:
    process.env.GEMINI_MODEL ||
    "gemini-3.1-flash-lite",

  geminiFallbackModels: modelList(
    process.env.GEMINI_FALLBACK_MODELS ||
    "gemini-3.5-flash-lite,gemini-3.8-flash"
  ),

  // Keep Groq credentials optional for a possible future provider.
  groqApiKey: process.env.GROQ_API_KEY || "",
  groqBaseUrl:
    process.env.GROQ_BASE_URL ||
    "https://api.groq.com/openai/v1",

  tavilyApiKey: process.env.TAVILY_API_KEY || "",

  defaultTimezone: process.env.DEFAULT_TZ || "Asia/Kolkata",
  nowOverride: process.env.NOW_OVERRIDE || "",

  dbPath: process.env.DB_PATH || "./data/minimi.sqlite",

  enableClaimExtraction:
    process.env.ENABLE_CLAIM_EXTRACTION !== "false",

  maxSearches: positiveInt(
    process.env.MAX_SEARCHES,
    3,
    "MAX_SEARCHES"
  ),

  maxRounds: positiveInt(
    process.env.MAX_ROUNDS,
    2,
    "MAX_ROUNDS"
  ),

  maxConcurrentSearches: positiveInt(
    process.env.MAX_CONCURRENT_SEARCHES,
    2,
    "MAX_CONCURRENT_SEARCHES"
  ),

  maxCompletionTokens: positiveInt(
    process.env.MAX_COMPLETION_TOKENS,
    1200,
    "MAX_COMPLETION_TOKENS"
  ),

  searchTimeoutMs: positiveInt(
    process.env.SEARCH_TIMEOUT_MS,
    8000,
    "SEARCH_TIMEOUT_MS"
  )
};

export function assertConfig() {
  const missing = [];

  if (!config.geminiApiKey) {
    missing.push("GEMINI_API_KEY");
  }

  if (!config.tavilyApiKey) {
    missing.push("TAVILY_API_KEY");
  }

  if (missing.length) {
    throw new Error(
      `Missing environment variables: ${missing.join(", ")}`
    );
  }

  if (!config.geminiModel) {
    throw new Error("GEMINI_MODEL is required.");
  }

  if (
    config.geminiFallbackModels.includes(config.geminiModel)
  ) {
    throw new Error(
      "The primary Gemini model must not also appear in GEMINI_FALLBACK_MODELS."
    );
  }
}
