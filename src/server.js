
import express from "express";
import OpenAI from "openai";

import { config, assertConfig } from "./config.js";
import { getNow, resolveDatePhrases } from "./time.js";

import {
  ensureConversation,
  saveMessage,
  recentMessages,
  retrieveMemory,
  listConversations,
  setTitle,
  deleteConversation
} from "./memory/store.js";

import { extractClaims } from "./memory/ledger.js";
import { runAgent } from "./agent/loop.js";
import {
  inspectFreshness,
  getRoutingMode
} from "./agent/router.js";
import {
  createMetrics,
  logMetrics
} from "./evaluation/metrics.js";

assertConfig();

const client = new OpenAI({
  apiKey: config.geminiApiKey,
  baseURL: config.geminiBaseUrl,
  timeout: 60000,
  maxRetries: 0
});

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

app.get("/api/conversations", (_req, res) => {
  try {
    res.json(listConversations());
  } catch (error) {
    console.error("[MINIMI] Conversation list failed:", error);
    res.status(500).json({
      error: "Could not load conversations."
    });
  }
});

app.get("/api/history/:id", (req, res) => {
  try {
    res.json({
      id: req.params.id,
      messages: recentMessages(req.params.id, 100)
    });
  } catch (error) {
    console.error("[MINIMI] History retrieval failed:", error);
    res.status(500).json({
      error: "Could not load conversation history."
    });
  }
});

app.delete("/api/conversations/:id", (req, res) => {
  try {
    const deleted = deleteConversation(req.params.id);

    if (!deleted) {
      return res.status(404).json({
        error: "Conversation not found."
      });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("[MINIMI] Conversation deletion failed:", error);
    return res.status(500).json({
      error: "Could not delete conversation."
    });
  }
});

app.post("/api/chat", async (req, res) => {
  const userMessage = String(req.body.message || "").trim();

  if (!userMessage) {
    return res.status(400).json({
      error: "Message is required."
    });
  }

  if (userMessage.length > 12000) {
    return res.status(413).json({
      error: "Message is too long. Please shorten it."
    });
  }

  const timezone = String(
    req.body.timezone || config.defaultTimezone
  );

  try {
    Intl.DateTimeFormat("en-US", {
      timeZone: timezone
    });
  } catch {
    return res.status(400).json({
      error: "Invalid timezone."
    });
  }

  let conversationId;

  try {
    conversationId = ensureConversation(req.body.conversationId);
  } catch (error) {
    console.error("[MINIMI] Conversation creation failed:", error);

    return res.status(500).json({
      error: "Could not create conversation."
    });
  }

  // One clock snapshot is shared throughout this request.
  const now = getNow();

  // Deterministic temporal context.
  const dates = resolveDatePhrases(
    userMessage,
    now,
    timezone
  );

  // Code-enforced freshness routing.
  const freshness = inspectFreshness({
    message: userMessage,
    now,
    timezone
  });

  const routing = getRoutingMode(freshness);

  let prior;
  let memory;
  let userMessageId;

  try {
    prior = recentMessages(conversationId, 4);

    memory = retrieveMemory(
      userMessage,
      dates,
      conversationId
    );

    userMessageId = saveMessage(
      conversationId,
      "user",
      userMessage
    );

    if (!req.body.conversationId) {
      setTitle(conversationId, userMessage.slice(0, 60));
    }
  } catch (error) {
    console.error(
      "[MINIMI] Context retrieval failed:",
      error
    );

    return res.status(500).json({
      error: "Could not prepare conversation context."
    });
  }

  // Start SSE only after request validation and context preparation.
  res.status(200);
  res.setHeader(
    "Content-Type",
    "text/event-stream; charset=utf-8"
  );
  res.setHeader(
    "Cache-Control",
    "no-cache, no-transform"
  );
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const controller = new AbortController();

  let closed = false;
  let finished = false;

  const metrics = createMetrics();

  const send = (event, data) => {
    if (closed || res.destroyed || res.writableEnded) {
      return;
    }

    res.write(
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    );
  };

  const heartbeat = setInterval(() => {
    send("ping", {
      time: new Date().toISOString()
    });
  }, 15000);

  res.on("close", () => {
    if (!finished && !res.writableEnded) {
      closed = true;
      controller.abort();
    }

    clearInterval(heartbeat);
  });

  const onStatus = (message) => {
    if (metrics.firstStatusMs === null) {
      metrics.firstStatusMs = Math.round(
        performance.now() - metrics.startedAt
      );
    }

    send("status", { message });
  };

  send("meta", {
    conversationId,
    now: now.toISOString(),
    timezone,
    dates,
    routing,
    freshness
  });

  try {
    onStatus("Retrieving conversation memory…");

    const result = await runAgent({
      client,

      model: config.geminiModel,
      fallbackModels: config.geminiFallbackModels,

      userMessage,
      history: prior,
      memory,

      dates,
      now,
      timezone,

      freshness,
      routing,

      signal: controller.signal,
      metrics,

      onStatus,

      onToken: (text) => {
        if (metrics.firstTokenMs === null) {
          metrics.firstTokenMs = Math.round(
            performance.now() - metrics.startedAt
          );
        }

        send("delta", { text });
      },

      onSources: (sources) => {
        send("sources", { sources });
      }
    });

    if (closed || controller.signal.aborted) {
      return;
    }

    const finalAnswer = String(
      result.answer || ""
    ).trim();

    if (!finalAnswer) {
      throw new Error(
        "The agent returned an empty response."
      );
    }

    // Replace streamed text with the final validated answer.
    send("replace", {
      text: finalAnswer
    });

    // Persist exactly what the user sees.
    saveMessage(
      conversationId,
      "assistant",
      finalAnswer
    );

    const citationWarnings = {
      invalidIds: result.citations?.invalidIds || [],
      unverifiedUrls:
        result.citations?.unverifiedUrls || []
    };

    send("sources", {
      sources: result.sources || [],
      searchCount: result.searchCount || 0,
      citationWarnings
    });

    send("done", {
      conversationId,
      searchCount: result.searchCount || 0
    });

    finished = true;

    // Background claim extraction does not block the response.
    if (config.enableClaimExtraction) {
      setImmediate(() => {
        extractClaims(
          client,
          conversationId,
          userMessageId,
          userMessage,
          finalAnswer,
          result.sources || [],
          config.geminiFallbackModels?.[0] ||
            config.geminiModel
        ).catch((error) => {
          console.error(
            "[LEDGER] Extraction failed:",
            error.message
          );
        });
      });
    }

    logMetrics(metrics, {
      conversationId,
      searchCount: result.searchCount || 0,
      routing,
      model: result.model || config.geminiModel
    });

  } catch (error) {
    if (!closed && !controller.signal.aborted) {
      console.error("[MINIMI] Agent error:", error);

      const status = error.status || error.statusCode;

      let message =
        "The agent could not complete this request. Please try again.";

      if (status === 429) {
        message =
          "Gemini is rate-limiting requests. Please wait briefly and try again.";
      } else if (status === 401 || status === 403) {
        message =
          "Gemini rejected the API key or project permissions.";
      } else if (status === 404) {
        message =
          "A configured Gemini model was not found. Check your model IDs.";
      } else if (
        error.name === "AbortError" ||
        controller.signal.aborted
      ) {
        message = "The request was cancelled.";
      }

      send("error", { message });

      logMetrics(metrics, {
        conversationId,
        routing,
        error: error.message
      });
    }

  } finally {
    finished = true;
    clearInterval(heartbeat);

    if (!closed && !res.writableEnded) {
      res.end();
    }
  }
});

app.listen(config.port, () => {
  console.log(
    `Minimi running at http://localhost:${config.port}`
  );

  console.log("[MINIMI] Provider: Google Gemini");

  console.log(
    `[MINIMI] Primary: ${config.geminiModel}`
  );

  console.log(
    `[MINIMI] Fallbacks: ${
      config.geminiFallbackModels.join(", ") || "None"
    }`
  );

  console.log(
    `[MINIMI] Search limit: ${config.maxSearches}`
  );

  console.log(
    `[MINIMI] Research rounds: ${config.maxRounds}`
  );
});
