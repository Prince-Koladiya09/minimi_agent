
import { config } from "../config.js";
import { webSearch } from "../search/tavily.js";

import {
  searchTool,
  parseSearchCall,
  createSearchKey
} from "./planner.js";

import {
  deduplicateResults,
  buildRefinementInstruction
} from "./evidence.js";

import {
  buildClaimComparisonContext,
  comparisonInstructions
} from "./diff.js";

import { systemPrompt } from "./prompt.js";
import { validateCitations } from "./citations.js";

const MAX_ROUNDS = config.maxRounds;
const MAX_SEARCHES = config.maxSearches;
const MAX_CONCURRENT_SEARCHES =
  config.maxConcurrentSearches;
const MAX_COMPLETION_TOKENS =
  config.maxCompletionTokens;
const MAX_HISTORY = 2;

function compactHistory(history = []) {
  return history
    .filter((item) =>
      ["user", "assistant"].includes(item.role)
    )
    .slice(-MAX_HISTORY)
    .map((item) => ({
      role: item.role,
      content: String(item.content || "").slice(0, 300)
    }));
}

function providerError(error) {
  const status = error?.status || error?.statusCode;

  if (status === 429) {
    return "The Gemini model rate limit was reached.";
  }

  if (status === 400) {
    return "Gemini rejected the request. Check the request format or model compatibility.";
  }

  if (status === 401) {
    return "The Gemini API key is invalid.";
  }

  if (status === 403) {
    return "Gemini denied access. Check API permissions and billing.";
  }

  if (status === 404) {
    return "The configured Gemini model was not found.";
  }

  if (
    error?.name?.includes("Timeout") ||
    error?.name === "APIConnectionTimeoutError"
  ) {
    return "The Gemini request timed out.";
  }

  return error?.message || "Unknown Gemini provider error.";
}

function isRetryable(error) {
  const status = error?.status || error?.statusCode;

  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    error?.name === "APIConnectionError" ||
    error?.name === "APIConnectionTimeoutError"
  );
}

function isPermanentRequestError(error) {
  const status = error?.status || error?.statusCode;

  return (
    status === 400 ||
    status === 401 ||
    status === 403
  );
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Request cancelled."));
      return;
    }

    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Request cancelled."));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", abort, {
      once: true
    });
  });
}

async function withRetry(
  operation,
  signal,
  attempts = 2
) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) {
      throw new Error("Request cancelled.");
    }

    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (
        !isRetryable(error) ||
        attempt === attempts - 1 ||
        signal?.aborted
      ) {
        break;
      }

      const header =
        error.headers?.["retry-after"] ||
        error.headers?.get?.("retry-after");

      const retryAfter = Number(header);

      // Respect Retry-After. Do not retry too early.
      const wait = Number.isFinite(retryAfter) &&
        retryAfter > 0
        ? retryAfter * 1000 + 500
        : Math.min(8000, 1500 * (2 ** attempt));

      // If the provider requests a long wait, move to
      // another configured model instead of blocking.
      if (wait > 12000) {
        break;
      }

      console.warn(
        `[AGENT] Temporary provider error. Retrying in ${
          Math.ceil(wait / 1000)
        } seconds.`
      );

      await delay(wait, signal);
    }
  }

  throw lastError;
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function consume() {
    while (true) {
      const index = next++;

      if (index >= items.length) {
        return;
      }

      results[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.min(
    Math.max(1, limit),
    items.length
  );

  await Promise.all(
    Array.from(
      { length: workerCount },
      () => consume()
    )
  );

  return results;
}

function addUsage(metrics, usage) {
  if (!metrics || !usage) return;

  metrics.inputTokens =
    (metrics.inputTokens || 0) +
    (usage.prompt_tokens || 0);

  metrics.outputTokens =
    (metrics.outputTokens || 0) +
    (usage.completion_tokens || 0);
}

function uniqueSources(sources) {
  const seen = new Set();

  return sources.filter((source) => {
    if (!source.url || seen.has(source.url)) {
      return false;
    }

    seen.add(source.url);
    return true;
  });
}

function makeComparisonContext(memory) {
  const claims = Array.isArray(memory?.claims)
    ? memory.claims.slice(0, 5)
    : [];

  if (!claims.length) {
    return "No previous saved claims were retrieved.";
  }

  try {
    return buildClaimComparisonContext(claims);
  } catch (error) {
    console.warn(
      "[AGENT] Could not format previous claims:",
      error.message
    );

    return "Previous claims were retrieved but could not be formatted.";
  }
}

function getModelPool(primary, fallbacks = []) {
  return [
    ...new Set(
      [primary, ...fallbacks]
        .map((model) => String(model || "").trim())
        .filter(Boolean)
    )
  ];
}

export async function runAgent(opts) {
  const {
    client,
    model,
    signal
  } = opts;

  if (!client) {
    throw new Error("The Gemini client was not provided.");
  }

  if (!model) {
    throw new Error("No primary Gemini model was configured.");
  }

  const modelPool = getModelPool(
    model,
    opts.fallbackModels || []
  );

  if (!modelPool.length) {
    throw new Error("No Gemini models are configured.");
  }

  let activeModel = model;

  const sources = [];
  const seenQueries = new Set();

  let searchCount = 0;
  let sourceCounter = 0;
  let successfulSearchCount = 0;

  const metrics = opts.metrics;

  const comparisonContext = makeComparisonContext(
    opts.memory
  );

  const messages = [
    {
      role: "system",
      content: [
        systemPrompt(
          opts.now,
          opts.timezone,
          opts.dates,
          opts.memory,
          opts.routing
        ),

        comparisonInstructions,

        "PREVIOUS CLAIMS AND COMPARISON CONTEXT:",
        comparisonContext,

        "",
        "Research instructions:",
        "- Use web_search for information that must be freshly verified.",
        "- When multiple independent entities need checking, issue multiple web_search calls in the same model turn.",
        "- If search results are weak, missing, contradictory, or outdated, reformulate the query and search again.",
        "- Do not repeat an identical search query.",
        "- Compare new evidence with previous claims when relevant.",
        "- Give a separate verdict for each entity when comparing changes.",
        "- Never describe a lack of search results as proof that something has not changed.",
        "- Distinguish confirmed changes, verified unchanged information, and information that could not be verified."
      ].join("\n")
    },

    ...compactHistory(opts.history),

    {
      role: "user",
      content: String(opts.userMessage || "").slice(0, 2000)
    }
  ];

  // Try the active model first, then the other configured models.
  function orderedModels() {
    const index = modelPool.indexOf(activeModel);

    if (index <= 0) {
      return [...modelPool];
    }

    return [
      ...modelPool.slice(index),
      ...modelPool.slice(0, index)
    ];
  }

  // Shared model failover for planning and other non-streaming calls.
  async function createCompletion(request) {
    let lastError;

    for (const candidate of orderedModels()) {
      if (signal?.aborted) {
        throw new Error("Request cancelled.");
      }

      try {
        const completion = await withRetry(
          () => client.chat.completions.create(
            {
              ...request,
              model: candidate
            },
            { signal }
          ),
          signal
        );

        if (candidate !== activeModel) {
          opts.onStatus?.(
            `Switched to Gemini model: ${candidate}`
          );
        }

        activeModel = candidate;

        return completion;
      } catch (error) {
        lastError = error;

        console.error(
          `[AGENT] Model ${candidate} failed:`,
          providerError(error)
        );

        if (signal?.aborted) {
          throw error;
        }

        if (isPermanentRequestError(error)) {
          throw new Error(providerError(error));
        }

        opts.onStatus?.(
          `Gemini model ${candidate} unavailable. Trying the next model…`
        );
      }
    }

    throw new Error(
      `All configured Gemini models failed. Last error: ${
        providerError(lastError || {})
      }`
    );
  }

  async function callPlanningModel(
    requestMessages,
    requireSearch
  ) {
    const request = {
      messages: requestMessages,
      max_tokens: MAX_COMPLETION_TOKENS,
      tools: [searchTool],
      tool_choice: requireSearch ? "required" : "auto"
    };

    return createCompletion(request);
  }

  async function executeSearch({ call, args }) {
    if (signal?.aborted) {
      throw new Error("Request cancelled.");
    }

    searchCount++;

    if (metrics) {
      metrics.searches = searchCount;
    }

    opts.onStatus?.(`Searching: ${args.query}`);

    try {
      const found = await webSearch(args, { signal });

      if (found.cacheHit && metrics) {
        metrics.cacheHits =
          (metrics.cacheHits || 0) + 1;
      }

      const mapped = (found.results || []).map((result) => ({
        id: `S${++sourceCounter}`,
        title: result.title || "",
        url: result.url || "",
        published_date: result.published_date || null,
        snippet: String(result.snippet || "").slice(0, 500)
      }));

      if (mapped.length) {
        successfulSearchCount++;
        sources.push(...mapped);

        opts.onSources?.(uniqueSources(sources));
      }

      return {
        call,
        content: JSON.stringify({
          query: args.query,
          cacheHit: Boolean(found.cacheHit),
          results: mapped,
          resultCount: mapped.length
        })
      };
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }

      console.error(
        `[SEARCH] Failed for "${args.query}":`,
        error.message
      );

      return {
        call,
        content: JSON.stringify({
          query: args.query,
          error: error.message || "Search failed.",
          resultCount: 0,
          instruction:
            "This search failed. Try a different query if the research budget allows."
        })
      };
    }
  }

  const researchRequired =
    opts.routing === "research_required";

  // Bounded research loop.
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal?.aborted) {
      throw new Error("Request cancelled.");
    }

    opts.onStatus?.(
      round === 0
        ? "Assessing available knowledge…"
        : "Reviewing research evidence…"
    );

    const completion = await callPlanningModel(
      messages,
      researchRequired && round === 0
    );

    const message = completion.choices?.[0]?.message;

    if (!message) {
      throw new Error(
        "Gemini returned an empty response."
      );
    }

    addUsage(metrics, completion.usage);

    const calls = (message.tool_calls || []).filter(
      (call) =>
        call.type === "function" &&
        call.function?.name === "web_search"
    );

    // Direct answer is allowed only if code has not forced research.
    if (!calls.length) {
      if (researchRequired && searchCount === 0) {
        messages.push({
          role: "system",
          content:
            "Research is mandatory for this request. " +
            "You have not searched yet. Call web_search before answering."
        });

        continue;
      }

      const answer = String(message.content || "").trim();

      if (!answer) {
        messages.push({
          role: "system",
          content:
            "Your previous response was empty. Provide a useful answer " +
            "or explain what information could not be verified."
        });

        continue;
      }

      const finalSources = uniqueSources(sources);
      const validated = validateCitations(
        answer,
        finalSources
      );

      opts.onToken?.(validated.answer);

      return {
        answer: validated.answer,
        sources: finalSources,
        searchCount,
        citations: validated,
        metrics,
        model: activeModel
      };
    }

    const accepted = [];

    for (const call of calls) {
      if (
        searchCount + accepted.length >= MAX_SEARCHES
      ) {
        break;
      }

      try {
        const args = parseSearchCall(call);
        const key = createSearchKey(args);

        if (seenQueries.has(key)) {
          continue;
        }

        seenQueries.add(key);
        accepted.push({ call, args });
      } catch (error) {
        console.warn(
          "[AGENT] Ignoring invalid search arguments:",
          error.message
        );
      }
    }

    if (!accepted.length) {
      messages.push({
        role: "system",
        content:
          "No new valid searches remain. Do not repeat previous queries. " +
          "Prepare the best answer possible using the evidence already " +
          "retrieved. Be explicit about anything that remains unverified."
      });

      break;
    }

    // The assistant tool-call message contains exactly the calls
    // that will receive tool responses.
    messages.push({
      role: "assistant",
      content: message.content || null,
      tool_calls: accepted.map(({ call }) => call)
    });

    opts.onStatus?.(
      `Searching ${accepted.length} independent question(s) in parallel…`
    );

    const results = await runWithConcurrency(
      accepted,
      MAX_CONCURRENT_SEARCHES,
      executeSearch
    );

    for (const result of results) {
      messages.push({
        role: "tool",
        tool_call_id: result.call.id,
        content: result.content
      });
    }

    const currentSources = uniqueSources(sources);
    const evidenceSummary = deduplicateResults(
      currentSources
    );

    messages.push({
      role: "system",
      content: [
        buildRefinementInstruction(evidenceSummary),

        "",
        `Research round: ${round + 1} of ${MAX_ROUNDS}.`,
        `Searches used: ${searchCount} of ${MAX_SEARCHES}.`,
        `Successful searches: ${successfulSearchCount}.`,
        `Searches remaining: ${Math.max(
          0,
          MAX_SEARCHES - searchCount
        )}.`,

        "",
        "Evaluate evidence quality before answering:",
        "- Are the sources relevant to the exact question?",
        "- Are important entities or subquestions still missing?",
        "- Are dates and source freshness appropriate?",
        "- Do sources independently support the important claims?",
        "- Do sources conflict with each other or with previous claims?",
        "- Can a more precise query resolve an evidence gap?",

        "",
        "If evidence is insufficient and budget remains, issue new, " +
        "reformulated web_search calls. Do not repeat a query. " +
        "If evidence is sufficient, prepare the answer."
      ].join("\n")
    });
  }

  if (signal?.aborted) {
    throw new Error("Request cancelled.");
  }

  // Final response after bounded research.
  opts.onStatus?.("Writing the final answer…");

  const finalMessages = [
    ...messages,
    {
      role: "system",
      content: [
        "Do not call tools in this final response.",
        "Answer using the evidence already retrieved and relevant prior claims.",
        "Cite only source IDs that appear in the supplied search results.",
        "Never invent citations or URLs.",
        "When discussing changes, compare the new evidence with previous claims.",
        "Give a distinct verdict for each entity where applicable.",
        "Use these outcome distinctions:",
        "1. Confirmed change: new evidence demonstrates a change.",
        "2. Verified no change: authoritative evidence explicitly confirms the value or status remains the same.",
        "3. Could not verify: available evidence does not establish whether it changed.",
        "Do not claim 'no change' merely because search results did not mention a change.",
        "If research failed or was inconclusive, explain that limitation.",
        "Be concise, clear, and directly answer the user's question."
      ].join("\n")
    }
  ];

  // Try each model for final streaming generation.
  // A stream that has already emitted text cannot safely be restarted
  // without a client-side draft-reset event, so failover happens only
  // before the first token.
  let answer = "";
  let finalStreamSucceeded = false;
  let lastStreamError;

  for (const candidate of orderedModels()) {
    if (signal?.aborted) {
      throw new Error("Request cancelled.");
    }

    let stream;

    try {
      stream = await withRetry(
        () => client.chat.completions.create(
          {
            model: candidate,
            messages: finalMessages,
            max_tokens: MAX_COMPLETION_TOKENS,
            stream: true
          },
          { signal }
        ),
        signal
      );
    } catch (error) {
      lastStreamError = error;

      console.error(
        `[AGENT] Final stream could not start on ${candidate}:`,
        providerError(error)
      );

      if (signal?.aborted) {
        throw error;
      }

      if (isPermanentRequestError(error)) {
        throw new Error(providerError(error));
      }

      opts.onStatus?.(
        `Final generation unavailable on ${candidate}. Trying another model…`
      );

      continue;
    }

    if (candidate !== activeModel) {
      opts.onStatus?.(
        `Final answer using Gemini model: ${candidate}`
      );
    }

    activeModel = candidate;

    try {
      for await (const chunk of stream) {
        if (signal?.aborted) {
          throw new Error("Request cancelled.");
        }

        const token =
          chunk.choices?.[0]?.delta?.content || "";

        if (!token) {
          continue;
        }

        answer += token;
        opts.onToken?.(token);
      }

      finalStreamSucceeded = true;
      break;

    } catch (error) {
      lastStreamError = error;

      if (signal?.aborted) {
        throw error;
      }

      // Do not append another model's answer to a partial answer.
      // The server will report the interrupted generation.
      if (answer.length > 0) {
        throw new Error(
          `Gemini streaming stopped after partial output: ${
            providerError(error)
          }`
        );
      }

      console.error(
        `[AGENT] Final stream failed on ${candidate}:`,
        providerError(error)
      );

      if (isPermanentRequestError(error)) {
        throw new Error(providerError(error));
      }

      opts.onStatus?.(
        `Final stream failed on ${candidate}. Trying another model…`
      );
    }
  }

  if (!finalStreamSucceeded) {
    throw new Error(
      `All Gemini models failed during final generation. ${
        providerError(lastStreamError || {})
      }`
    );
  }

  if (!answer.trim()) {
    throw new Error(
      "Gemini returned an empty final answer."
    );
  }

  // Validate citations only after the complete answer is available.
  const finalSources = uniqueSources(sources);

  const validated = validateCitations(
    answer.trim(),
    finalSources
  );

  return {
    answer: validated.answer,
    sources: finalSources,
    searchCount,
    citations: validated,
    metrics,
    model: activeModel
  };
}
  