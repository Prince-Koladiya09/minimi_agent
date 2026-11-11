
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

assertConfig();

const client = new OpenAI({
  apiKey: config.openaiApiKey,
  baseURL: process.env.OPENAI_BASE_URL,
  timeout: 30000,
  maxRetries: 0
});

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

// List conversations
app.get("/api/conversations", (_req, res) => {
  res.json(listConversations());
});


// Delete a conversation and its stored data.
app.delete("/api/conversations/:id", (req, res) => {
  const id = String(req.params.id || "").trim();

  if (!id) {
    return res.status(400).json({
      error: "Conversation ID is required."
    });
  }

  try {
    const deleted = deleteConversation(id);

    if (!deleted) {
      return res.status(404).json({
        error: "Conversation not found."
      });
    }

    console.log("[MINIMI] Conversation deleted:", id);

    return res.json({
      success: true,
      conversationId: id
    });
  } catch (error) {
    console.error("[MINIMI] Conversation deletion failed:", error);

    return res.status(500).json({
      error: "Could not delete conversation."
    });
  }
});


// Load conversation history
app.get("/api/history/:id", (req, res) => {
  res.json({
    id: req.params.id,
    messages: recentMessages(req.params.id, 100)
  });
});

// Main chat endpoint
app.post("/api/chat", async (req, res) => {
  console.log("[MINIMI] Chat request received");

  const userMessage = String(req.body.message || "").trim();

  if (!userMessage) {
    return res.status(400).json({
      error: "Message is required."
    });
  }

  const timezone = String(
    req.body.timezone || config.defaultTimezone
  );

  const conversationId = ensureConversation(
    req.body.conversationId
  );

  const now = getNow();

  const dates = resolveDatePhrases(
    userMessage,
    now,
    timezone
  );

  // Reduce history to save model tokens.
  const prior = recentMessages(conversationId, 4);

  const memory = retrieveMemory(
    userMessage,
    dates,
    conversationId
  );

  saveMessage(conversationId, "user", userMessage);

  if (!req.body.conversationId) {
    setTitle(conversationId, userMessage.slice(0, 60));
  }

  // Configure Server-Sent Events.
  res.status(200);
  res.setHeader(
    "Content-Type",
    "text/event-stream; charset=utf-8"
  );
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  res.flushHeaders?.();

  const controller = new AbortController();

  let closed = false;

  const send = (event, data) => {
    if (closed || res.destroyed || res.writableEnded) {
      return;
    }

    res.write(
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    );
  };

  // Send a heartbeat every 15 seconds.
  const heartbeat = setInterval(() => {
    send("ping", {
      time: new Date().toISOString()
    });
  }, 15000);

  // Detect browser disconnection.
  res.on("close", () => {
    if (!res.writableEnded) {
      console.log("[MINIMI] Client disconnected");

      closed = true;
      controller.abort();
    }

    clearInterval(heartbeat);
  });

  send("meta", {
    conversationId,
    now: now.toISOString(),
    timezone
  });

  send("status", {
    message: "Checking conversation memory and preparing research…"
  });

  try {
    console.log("[MINIMI] Starting agent");

    const result = await runAgent({
      client,
      model: config.openaiModel,
      userMessage,
      history: prior,
      memory,
      dates,
      now,
      timezone,
      signal: controller.signal,

      onStatus: (message) => {
        console.log("[MINIMI] Status:", message);

        send("status", {
          message
        });
      },

      onToken: (text) => {
        console.log("[MINIMI] Answer received");

        send("delta", {
          text
        });
      }
    });

    if (closed || controller.signal.aborted) {
      return;
    }

    // Save assistant response.
    saveMessage(
      conversationId,
      "assistant",
      result.answer
    );

    send("sources", {
      sources: result.sources,
      searchCount: result.searchCount
    });

    send("done", {
      conversationId
    });

    // Optional background claim extraction.
    // Disabled by default to conserve free API tokens.
    if (process.env.ENABLE_CLAIM_EXTRACTION === "true") {
      void extractClaims(
        client,
        conversationId,
        result.answer,
        result.sources
      ).catch((error) => {
        console.error(
          "[MINIMI] Claim extraction failed:",
          error.message
        );
      });
    }

  } catch (error) {
    console.error("[MINIMI] Agent error:", error);

    if (!closed && !controller.signal.aborted) {
      send("error", {
        message: error instanceof Error
          ? error.message
          : "Unexpected server error"
      });
    }

  } finally {
    clearInterval(heartbeat);

    if (!closed && !res.writableEnded) {
      res.end();
    }

    console.log("[MINIMI] Chat request finished");
  }
});

app.listen(config.port, () => {
  console.log(
    `Minimi running at http://localhost:${config.port}`
  );

  console.log(
    `[MINIMI] Model: ${config.openaiModel}`
  );

  console.log(
    `[MINIMI] Provider: ${process.env.OPENAI_BASE_URL || "OpenAI default"}`
  );
});
