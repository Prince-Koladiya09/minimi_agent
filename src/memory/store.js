
import { randomUUID } from "node:crypto";
import { db } from "./db.js";

function getSearchTerms(value, limit = 8) {
  return [...new Set(
    String(value || "")
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .trim()
      .split(/\s+/)
      .filter((term) => term.length > 2)
      .map((term) => term.slice(0, 50).toLowerCase())
  )].slice(0, limit);
}

export function ensureConversation(id) {
  const conversationId = id || randomUUID();

  const found = db.prepare(
    "SELECT id FROM conversations WHERE id=?"
  ).get(conversationId);

  if (!found) {
    db.prepare(
      `INSERT INTO conversations(id,title,created_at)
       VALUES(?,?,?)`
    ).run(
      conversationId,
      "New conversation",
      new Date().toISOString()
    );
  }

  return conversationId;
}

export function saveMessage(conversationId, role, content) {
  const result = db.prepare(
    `INSERT INTO messages(conversation_id,role,content,created_at)
     VALUES(?,?,?,?)`
  ).run(
    conversationId,
    role,
    String(content || ""),
    new Date().toISOString()
  );

  return result.lastInsertRowid;
}

export function recentMessages(conversationId, limit = 8) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 50));

  return db.prepare(
    `SELECT role,content,created_at
     FROM messages
     WHERE conversation_id=?
     ORDER BY id DESC
     LIMIT ?`
  ).all(conversationId, safeLimit).reverse();
}

export function retrieveMemory(query, dates = [], conversationId) {
  const byDate = [];

  for (const window of dates || []) {
    if (!window?.start || !window?.end) continue;

    const rows = db.prepare(
      `SELECT m.role,m.content,m.created_at,m.conversation_id
       FROM messages m
       WHERE m.created_at >= ? AND m.created_at <= ?
       ORDER BY m.created_at DESC
       LIMIT 30`
    ).all(window.start, window.end);

    byDate.push(...rows);
  }

  const terms = getSearchTerms(query);
  let relevant = [];

  if (terms.length) {
    const match = terms
      .map((term) => `"${term.replace(/"/g, "")}"`)
      .join(" OR ");

    try {
      relevant = db.prepare(
        `SELECT m.role,m.content,m.created_at,m.conversation_id
         FROM messages_fts
         JOIN messages m ON m.id=messages_fts.rowid
         WHERE messages_fts MATCH ?
         ORDER BY rank
         LIMIT 12`
      ).all(match);
    } catch (error) {
      console.warn("[MEMORY] Message FTS query failed:", error.message);
    }
  }

  // Search claims across the question's meaningful terms.
  // Values remain parameterized; user text is never interpolated into SQL.
  let claims = [];

  if (terms.length) {
    const conditions = terms.map(
      () => `(lower(COALESCE(topic,'')) LIKE ?
          OR lower(COALESCE(entity,'')) LIKE ?
          OR lower(COALESCE(claim_text,'')) LIKE ?)`
    );

    const parameters = terms.flatMap((term) => {
      const pattern = `%${term}%`;
      return [pattern, pattern, pattern];
    });

    try {
      claims = db.prepare(
        `SELECT id,conversation_id,message_id,topic,entity,
                claim_text,claim_type,value,as_of,
                extracted_at,source_urls_json,confidence
         FROM claims
         WHERE ${conditions.join(" OR ")}
         ORDER BY
           CASE WHEN conversation_id = ? THEN 0 ELSE 1 END,
           COALESCE(as_of, extracted_at) DESC
         LIMIT 20`
      ).all(...parameters, conversationId || "");
    } catch (error) {
      console.warn("[MEMORY] Claims retrieval failed:", error.message);
    }
  }

  const dedup = new Map();

  [...byDate, ...relevant].forEach((message) => {
    const key = [
      message.conversation_id,
      message.created_at,
      message.content
    ].join(":");

    dedup.set(key, message);
  });

  const messages = [...dedup.values()]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 8)
    .map((message) => ({
      ...message,
      content: String(message.content || "").slice(0, 300)
    }));

  return {
    messages,
    claims: claims.map((claim) => ({
      ...claim,
      claim_text: String(claim.claim_text || "").slice(0, 300)
    })),
    activeConversationId: conversationId || null
  };
}

export function listConversations() {
  return db.prepare(
    `SELECT c.id,c.title,c.created_at,
       (SELECT content
        FROM messages m
        WHERE m.conversation_id=c.id
        ORDER BY id DESC
        LIMIT 1) AS last_message
     FROM conversations c
     ORDER BY c.created_at DESC
     LIMIT 50`
  ).all();
}

export function setTitle(id, title) {
  db.prepare(
    `UPDATE conversations
     SET title=?
     WHERE id=? AND title='New conversation'`
  ).run(String(title || "").slice(0, 70), id);
}

export function deleteConversation(id) {
  const exists = db.prepare(
    "SELECT id FROM conversations WHERE id=?"
  ).get(id);

  if (!exists) return false;

  db.transaction(() => {
    db.prepare(
      "DELETE FROM claims WHERE conversation_id=?"
    ).run(id);

    db.prepare(
      "DELETE FROM messages WHERE conversation_id=?"
    ).run(id);

    db.prepare(
      "DELETE FROM conversations WHERE id=?"
    ).run(id);
  })();

  return true;
}
