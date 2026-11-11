
import { randomUUID } from "node:crypto";
import { db } from "./db.js";

export function ensureConversation(id) {
  const conversationId = id || randomUUID();

  const found = db
    .prepare("SELECT id FROM conversations WHERE id=?")
    .get(conversationId);

  if (!found) {
    db.prepare(
      "INSERT INTO conversations(id,title,created_at) VALUES(?,?,?)"
    ).run(
      conversationId,
      "New conversation",
      new Date().toISOString()
    );
  }

  return conversationId;
}

export function saveMessage(conversationId, role, content) {
  return db.prepare(
    `INSERT INTO messages(conversation_id,role,content,created_at)
     VALUES(?,?,?,?)`
  ).run(
    conversationId,
    role,
    content,
    new Date().toISOString()
  ).lastInsertRowid;
}

export function recentMessages(conversationId, limit = 12) {
  return db.prepare(
    `SELECT role,content,created_at
     FROM messages
     WHERE conversation_id=?
     ORDER BY id DESC
     LIMIT ?`
  ).all(conversationId, limit).reverse();
}

export function retrieveMemory(query, dates, conversationId) {
  const byDate = [];

  for (const w of dates) {
    byDate.push(
      ...db.prepare(
        `SELECT role,content,created_at
         FROM messages
         WHERE created_at >= ? AND created_at <= ?
         ORDER BY created_at
         LIMIT 40`
      ).all(w.start, w.end)
    );
  }

  let relevant = [];

  const terms = query
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(x => x.length > 2)
    .slice(0, 8);

  if (terms.length) {
    const match = terms
      .map(x => `"${x.replace(/"/g, "")}"`)
      .join(" OR ");

    try {
      relevant = db.prepare(
        `SELECT m.role,m.content,m.created_at
         FROM messages_fts f
         JOIN messages m ON m.id=f.rowid
         WHERE messages_fts MATCH ?
         ORDER BY rank
         LIMIT 8`
      ).all(match);
    } catch {
      // If FTS syntax fails, continue with date and recent memory.
    }
  }

  const claims = db.prepare(
    `SELECT topic,entity,claim_text,claim_type,value,as_of,
            source_urls_json,confidence
     FROM claims
     WHERE conversation_id=?
     ORDER BY created_at DESC
     LIMIT 30`
  ).all(conversationId);

  const dedup = new Map();

  [...byDate, ...relevant].forEach(message => {
    dedup.set(
      `${message.created_at}:${message.content}`,
      message
    );
  });

  return {
    messages: [...dedup.values()].slice(0, 30),
    claims
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
  ).run(title.slice(0, 70), id);
}

// Delete a conversation and its dependent records atomically.
export function deleteConversation(id) {
  const conversation = db
    .prepare("SELECT id FROM conversations WHERE id=?")
    .get(id);

  if (!conversation) {
    return false;
  }

  const remove = db.transaction(() => {
    db.prepare(
      "DELETE FROM claims WHERE conversation_id=?"
    ).run(id);

    db.prepare(
      "DELETE FROM messages WHERE conversation_id=?"
    ).run(id);

    db.prepare(
      "DELETE FROM conversations WHERE id=?"
    ).run(id);
  });

  remove();

  return true;
}
