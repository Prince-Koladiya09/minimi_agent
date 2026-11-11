
import { z } from "zod";

import { webSearch } from "../search/tavily.js";
import { systemPrompt } from "./prompt.js";

// Validate model-generated search arguments.
const SearchArgs = z.object({
  query: z.string().min(3).max(300),
  recency: z.enum(["day", "week", "month", "year"]).optional(),
  after_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  domains: z.array(z.string().max(100)).max(8).optional()
});

// Token and execution limits.
const MAX_ROUNDS = 1;
const MAX_SEARCHES = 1;
const MAX_HISTORY = 3;
const MAX_COMPLETION_TOKENS = 512;
const MAX_SEARCH_RESULTS = 3;
const MAX_RESULT_CHARS = 350;
const REQUEST_TIMEOUT = 20000;

const tool = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the public web for current information. Returns a small number of relevant sources.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Specific search query, ideally 3-12 words."
        },
        recency: {
          type: "string",
          enum: ["day", "week", "month", "year"]
        },
        after_date: {
          type: "string",
          description: "Only seek developments after this ISO date."
        },
        domains: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["query"]
    }
  }
};

// Keep only recent, compact conversation history.
function trimHistory(history = []) {
  return history
    .filter(message =>
      ["user", "assistant"].includes(message.role)
    )
    .slice(-MAX_HISTORY)
    .map(message => ({
      role: message.role,
      content: String(message.content || "").slice(0, 800)
    }));
}

// Reduce search result size before passing it to the model.
function compactSearchResult(result) {
  return {
    title: String(result.title || "").slice(0, 120),
    url: String(result.url || ""),
    published_date: result.published_date || null,
    content: String(
      result.content ||
      result.snippet ||
      result.description ||
      ""
    ).slice(0, MAX_RESULT_CHARS)
  };
}

// Create timeout and browser-cancellation signal.
function createRequestSignal(parentSignal) {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT);

  return parentSignal
    ? AbortSignal.any([parentSignal, timeoutSignal])
    : timeoutSignal;
}

// Convert provider errors into useful messages.
function getProviderError(error) {
  const status = error.status || error.statusCode;

  if (status === 429) {
    return "Groq rate limit reached. Please wait before trying again.";
  }

  if (status === 401) {
    return "Invalid Groq API key. Check your .env file.";
  }

  if (status === 404) {
    return "The selected model was not found. Check OPENAI_MODEL in .env.";
  }

  if (
    error.name === "TimeoutError" ||
    error.name === "APIConnectionTimeoutError"
  ) {
    return "The AI provider took too long to respond. Please try again.";
  }

  return error.message || "Unknown AI provider error.";
}

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    throw new Error("Request was cancelled.");
  }
}

export async function runAgent(opts) {
  const sources = [];
  const signal = opts.signal;

  const prompt = systemPrompt(
    opts.now,
    opts.timezone,
    opts.dates,
    opts.memory
  );

  const messages = [
    {
      role: "system",
      content: prompt
    },
    ...trimHistory(opts.history),
    {
      role: "user",
      content: String(opts.userMessage || "").slice(0, 2000)
    }
  ];

  let searchCount = 0;

  // First model request: answer directly or request one web search.
  for (let round = 0; round < MAX_ROUNDS; round++) {
    throwIfCancelled(signal);

    console.log(
      `[AGENT] Model request ${round + 1}/${MAX_ROUNDS}`
    );

    opts.onStatus?.("Thinking and preparing an answer…");

    let completion;

    try {
      completion = await opts.client.chat.completions.create(
        {
          model: opts.model,
          messages,
          tools: [tool],
          tool_choice: "auto",
          max_completion_tokens: MAX_COMPLETION_TOKENS
        },
        {
          signal: createRequestSignal(signal)
        }
      );
    } catch (error) {
      if (signal?.aborted) {
        throw new Error("Request cancelled by the browser.");
      }

      console.error("[AGENT] Model request failed:", error);

      throw new Error(getProviderError(error));
    }

    throwIfCancelled(signal);

    const msg = completion.choices?.[0]?.message;

    if (!msg) {
      throw new Error("The model returned an empty response.");
    }

    console.log("[AGENT] Model response received.");

    // No tool call: return the normal answer.
    if (!msg.tool_calls?.length) {
      const answer =
        msg.content ||
        "I couldn't produce an answer from the available evidence.";

      opts.onToken?.(answer);

      return {
        answer,
        sources,
        searchCount
      };
    }

    // Process one web search only.
    if (searchCount >= MAX_SEARCHES) {
      break;
    }

    const call = msg.tool_calls[0];

    // Keep only the selected tool call in the conversation.
    messages.push({
      ...msg,
      tool_calls: [call]
    });

    if (
      call.type !== "function" ||
      call.function.name !== "web_search"
    ) {
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: "Unsupported tool."
      });

      break;
    }

    let args;

    try {
      args = SearchArgs.parse(
        JSON.parse(call.function.arguments)
      );
    } catch (error) {
      console.error("[AGENT] Invalid search arguments:", error);

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: "Invalid search arguments. Provide a valid query."
      });

      break;
    }

    searchCount++;

    opts.onStatus?.("Searching the web…");

    try {
      throwIfCancelled(signal);

      console.log("[AGENT] Searching:", args.query);

      // Pass the browser cancellation signal to the search provider.
      const found = await webSearch(args, {
        signal
      });

      throwIfCancelled(signal);

      const limitedResults = (
        Array.isArray(found) ? found : []
      )
        .slice(0, MAX_SEARCH_RESULTS)
        .map(compactSearchResult);

      const remapped = limitedResults.map((result, index) => ({
        ...result,
        id: `S${index + 1}`
      }));

      sources.push(...remapped);

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(remapped)
      });

      console.log(
        `[AGENT] Received ${remapped.length} search results.`
      );

    } catch (error) {
      if (signal?.aborted) {
        throw new Error("Request cancelled.");
      }

      console.error("[AGENT] Search failed:", error);

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: `Search failed: ${error.message || "Unknown error"}`
      });
    }
  }

  throwIfCancelled(signal);

  // If search was used, make a final request to summarize the evidence.
  if (searchCount > 0) {
    try {
      opts.onStatus?.("Summarizing the research…");

      console.log("[AGENT] Starting final summary request.");

      const completion = await opts.client.chat.completions.create(
        {
          model: opts.model,
          messages: [
            ...messages,
            {
              role: "system",
              content:
                "Give a concise, useful answer based on the search results " +
                "already provided. Do not request another search. " +
                "Do not invent prices, limits, features or dates. " +
                "Distinguish verified facts from uncertain information. " +
                "If the evidence is insufficient, say so. " +
                "Cite sources using their IDs, such as [S1]."
            }
          ],
          max_completion_tokens: MAX_COMPLETION_TOKENS
        },
        {
          signal: createRequestSignal(signal)
        }
      );

      throwIfCancelled(signal);

      const answer =
        completion.choices?.[0]?.message?.content;

      if (!answer) {
        throw new Error("The model returned an empty summary.");
      }

      console.log("[AGENT] Research summary completed.");

      opts.onToken?.(answer);

      return {
        answer,
        sources,
        searchCount
      };

    } catch (error) {
      if (signal?.aborted) {
        throw new Error("Request cancelled.");
      }

      console.error("[AGENT] Final summary failed:", error);

      const reason = getProviderError(error);

      const answer = sources.length > 0
        ? `I found ${sources.length} sources, but couldn't complete the research summary because the AI provider returned this error: ${reason}\n\nYou can still review the sources listed below.`
        : `I couldn't complete the research. ${reason}`;

      opts.onToken?.(answer);

      return {
        answer,
        sources,
        searchCount
      };
    }
  }

  const fallback =
    "I couldn't complete the request. Please try again with a shorter question.";

  opts.onToken?.(fallback);

  return {
    answer: fallback,
    sources,
    searchCount
  };
}
