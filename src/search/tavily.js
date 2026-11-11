
import { config } from "../config.js";
import { db } from "../memory/db.js";

const TTL_MS = 12 * 60 * 1000;
const MAX_RESULTS = 3;
const MAX_SNIPPET_CHARS = 500;

export async function webSearch(args, options = {}) {
  const query = String(args.query || "").trim().slice(0, 300);

  if (!query) return [];

  if (!config.tavilyApiKey) {
    throw new Error("Tavily API key is missing.");
  }

  if (options.signal?.aborted) {
    throw new Error("Search cancelled.");
  }

  // Normalize cache key so equivalent searches reuse results.
  const key = JSON.stringify({
    query: query.toLowerCase(),
    recency: args.recency || null,
    after_date: args.after_date || null,
    domains: [...(args.domains || [])].sort()
  });

  // Check cached results first.
  const cached = db.prepare(
    "SELECT response_json, fetched_at FROM search_cache WHERE cache_key = ?"
  ).get(key);

  if (
    cached &&
    Date.now() - new Date(cached.fetched_at).getTime() < TTL_MS
  ) {
    console.log("[TAVILY] Using cached search results.");

    return JSON.parse(cached.response_json);
  }

  console.log("[TAVILY] Searching:", query);

  const timeoutSignal = AbortSignal.timeout(8000);

  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  const requestBody = {
    api_key: config.tavilyApiKey,
    query,
    search_depth: "basic",
    max_results: MAX_RESULTS,
    include_answer: false,
    include_raw_content: false
  };

  // Apply domain filtering through Tavily's API.
  if (args.domains?.length) {
    requestBody.include_domains = args.domains.slice(0, 8);
  }

  // Use news search for recent developments.
  if (args.recency) {
    requestBody.topic = "news";
  } else {
    requestBody.topic = "general";
  }

  // Add a date constraint to the query when supplied.
  if (args.after_date) {
    requestBody.query += ` after:${args.after_date}`;
  }

  let response;

  try {
    response = await fetch(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody),
        signal
      }
    );
  } catch (error) {
    if (options.signal?.aborted) {
      throw new Error("Search cancelled by the browser.");
    }

    if (error.name === "TimeoutError") {
      throw new Error("Tavily search timed out. Please try again.");
    }

    throw new Error(
      `Tavily connection failed: ${error.message}`
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");

    console.error(
      "[TAVILY] API error:",
      response.status,
      errorText.slice(0, 300)
    );

    if (response.status === 401) {
      throw new Error("Invalid Tavily API key.");
    }

    if (response.status === 429) {
      throw new Error("Tavily rate limit reached. Please wait.");
    }

    throw new Error(
      `Tavily returned HTTP ${response.status}.`
    );
  }

  const data = await response.json();

  if (options.signal?.aborted) {
    throw new Error("Search cancelled.");
  }

  const results = (data.results || [])
    .slice(0, MAX_RESULTS)
    .filter((result) => result.url)
    .map((result, index) => ({
      id: `S${index + 1}`,
      title: String(result.title || "Untitled").slice(0, 150),
      url: result.url,
      published_date: result.published_date || null,
      snippet: String(result.content || "")
        .slice(0, MAX_SNIPPET_CHARS)
    }));

  // Cache successful results.
  db.prepare(`
    INSERT OR REPLACE INTO search_cache
    (cache_key, response_json, fetched_at)
    VALUES (?, ?, ?)
  `).run(
    key,
    JSON.stringify(results),
    new Date().toISOString()
  );

  console.log(
    `[TAVILY] Found ${results.length} results.`
  );

  return results;
}
