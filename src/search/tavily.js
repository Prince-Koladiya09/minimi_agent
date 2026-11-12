
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { db } from "../memory/db.js";

const CACHE_TTL = 10 * 60 * 1000;
const MAX_RESULTS = 5;

function normalizeDate(value) {
  if (!value) return null;

  const match = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function normalizeRecency(value) {
  const allowed = new Set(["day", "week", "month", "year"]);
  const normalized = String(value || "").toLowerCase();

  return allowed.has(normalized) ? normalized : null;
}

function cacheKey(args, query) {
  const normalized = {
    query,
    recency: normalizeRecency(args.recency),
    after_date: normalizeDate(args.after_date),
    end_date: normalizeDate(args.end_date),
    domains: Array.isArray(args.domains)
      ? [...args.domains].map(String).sort()
      : []
  };

  return createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex");
}

function withinDateRange(result, afterDate, endDate) {
  const published = normalizeDate(result.published_date);

  // Do not treat an undated result as date-verified.
  if (!published && (afterDate || endDate)) return false;
  if (!published) return true;

  if (afterDate && published < afterDate) return false;
  if (endDate && published > endDate) return false;

  return true;
}

function normalizeResult(result) {
  return {
    title: String(result.title || "Untitled").slice(0, 150),
    url: String(result.url || ""),
    published_date: result.published_date || null,
    snippet: String(result.content || "").slice(0, 700)
  };
}

export async function webSearch(args = {}, options = {}) {
  const query = String(args.query || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 300);

  if (query.length < 3) {
    throw new Error("Search query must contain at least 3 characters.");
  }

  if (!config.tavilyApiKey) {
    throw new Error("TAVILY_API_KEY is not configured.");
  }

  const afterDate = normalizeDate(args.after_date);
  const endDate = normalizeDate(args.end_date);
  const recency = normalizeRecency(args.recency);

  const key = cacheKey(args, query);

  // Never return cached data for an already-aborted request.
  if (options.signal?.aborted) {
    throw new Error("Search request was aborted.");
  }

  const cached = db.prepare(
    `SELECT response_json,fetched_at
     FROM search_cache
     WHERE cache_key=?`
  ).get(key);

  if (
    cached &&
    Date.now() - new Date(cached.fetched_at).getTime() < CACHE_TTL
  ) {
    return {
      results: JSON.parse(cached.response_json),
      cacheHit: true
    };
  }

  const body = {
    api_key: config.tavilyApiKey,
    query,
    search_depth: "basic",
    topic: recency ? "news" : "general",
    max_results: MAX_RESULTS,
    include_answer: false,
    include_raw_content: false
  };

  if (afterDate) body.start_date = afterDate;
  if (endDate) body.end_date = endDate;
  if (recency) body.time_range = recency;

  if (Array.isArray(args.domains) && args.domains.length) {
    body.include_domains = args.domains
      .map((domain) => String(domain).trim())
      .filter(Boolean)
      .slice(0, 10);
  }

  const timeoutSignal = AbortSignal.timeout(config.searchTimeoutMs);
  const signals = [timeoutSignal];

  if (options.signal) {
    signals.push(options.signal);
  }

  const response = await fetch(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals)
    }
  );

  if (!response.ok) {
    const error = new Error(
      `Tavily returned HTTP ${response.status}`
    );

    error.status = response.status;
    throw error;
  }

  const data = await response.json();

  const results = (data.results || [])
    .filter((result) => result.url)
    .filter((result) =>
      withinDateRange(result, afterDate, endDate)
    )
    .map(normalizeResult)
    .slice(0, MAX_RESULTS);

  // Cache only successful responses.
  // Do not cache a response if the caller cancelled during the request.
  if (!options.signal?.aborted) {
    db.prepare(
      `INSERT OR REPLACE INTO search_cache(
         cache_key,response_json,fetched_at
       ) VALUES(?,?,?)`
    ).run(
      key,
      JSON.stringify(results),
      new Date().toISOString()
    );
  }

  return {
    results,
    cacheHit: false
  };
}
