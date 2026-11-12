
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), {
  recursive: true
});

export const db = new Database(config.dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

// Safely add missing columns to existing databases.
function addColumnIfMissing(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  const exists = columns.some((item) => item.name === column);

  if (!exists) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(conversation_id)
      REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_convo_date
  ON messages(conversation_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_messages_created
  ON messages(created_at);

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(content, content='messages', content_rowid='id');

  CREATE TRIGGER IF NOT EXISTS messages_ai
  AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content)
    VALUES (new.id, new.content);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_ad
  AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES ('delete', old.id, old.content);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_au
  AFTER UPDATE OF content ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content)
    VALUES ('delete', old.id, old.content);

    INSERT INTO messages_fts(rowid, content)
    VALUES (new.id, new.content);
  END;

  CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    message_id INTEGER,
    topic TEXT,
    entity TEXT,
    claim_text TEXT NOT NULL,
    claim_type TEXT NOT NULL DEFAULT 'other',
    value TEXT,
    as_of TEXT NOT NULL,
    extracted_at TEXT NOT NULL,
    source_urls_json TEXT NOT NULL DEFAULT '[]',
    confidence REAL NOT NULL DEFAULT 0.5,
    verification_status TEXT NOT NULL DEFAULT 'unverified',
    FOREIGN KEY(conversation_id)
      REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY(message_id)
      REFERENCES messages(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS search_cache (
    cache_key TEXT PRIMARY KEY,
    response_json TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
`);

// Migrate older claims tables.
addColumnIfMissing("claims", "message_id", "INTEGER");
addColumnIfMissing("claims", "topic", "TEXT");
addColumnIfMissing("claims", "entity", "TEXT");
addColumnIfMissing("claims", "claim_text", "TEXT");
addColumnIfMissing("claims", "claim_type", "TEXT NOT NULL DEFAULT 'other'");
addColumnIfMissing("claims", "value", "TEXT");
addColumnIfMissing("claims", "as_of", "TEXT NOT NULL DEFAULT ''");
addColumnIfMissing(
  "claims",
  "extracted_at",
  "TEXT NOT NULL DEFAULT ''"
);
addColumnIfMissing(
  "claims",
  "source_urls_json",
  "TEXT NOT NULL DEFAULT '[]'"
);
addColumnIfMissing(
  "claims",
  "confidence",
  "REAL NOT NULL DEFAULT 0.5"
);
addColumnIfMissing(
  "claims",
  "verification_status",
  "TEXT NOT NULL DEFAULT 'unverified'"
);

// Backfill missing timestamps in older records.
db.exec(`
  UPDATE claims
  SET extracted_at = CURRENT_TIMESTAMP
  WHERE extracted_at IS NULL OR extracted_at = '';

  UPDATE claims
  SET as_of = extracted_at
  WHERE as_of IS NULL OR as_of = '';
`);

// Create indexes only after migrations.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_claims_entity_date
  ON claims(entity, as_of);

  CREATE INDEX IF NOT EXISTS idx_claims_conversation
  ON claims(conversation_id, extracted_at);

  CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts
  USING fts5(topic, entity, claim_text, content='');
`);

// Rebuild the message FTS index for existing messages.
const messageCount = db.prepare(
  "SELECT COUNT(*) AS count FROM messages_fts"
).get().count;

if (messageCount === 0) {
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')");
}

// Rebuild claims FTS from the claims table.
// This also repairs an index left empty by an earlier version.
db.exec("DELETE FROM claims_fts");

const existingClaims = db.prepare(`
  SELECT id, topic, entity, claim_text
  FROM claims
  WHERE claim_text IS NOT NULL
`).all();

const insertExistingClaimFts = db.prepare(`
  INSERT INTO claims_fts(rowid, topic, entity, claim_text)
  VALUES (?, ?, ?, ?)
`);

const rebuildClaimsFts = db.transaction(() => {
  for (const claim of existingClaims) {
    insertExistingClaimFts.run(
      claim.id,
      claim.topic || "",
      claim.entity || "",
      claim.claim_text
    );
  }
});

rebuildClaimsFts();
