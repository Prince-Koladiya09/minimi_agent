import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
  role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY(conversation_id) REFERENCES conversations(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_convo_date ON messages(conversation_id, created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, content='messages', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
  message_id INTEGER, topic TEXT, entity TEXT, claim_text TEXT NOT NULL,
  claim_type TEXT, value TEXT, as_of TEXT NOT NULL, source_urls_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5, verification_status TEXT NOT NULL DEFAULT 'unverified',
  created_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts USING fts5(topic, entity, claim_text);
CREATE TABLE IF NOT EXISTS search_cache (
  cache_key TEXT PRIMARY KEY, response_json TEXT NOT NULL, fetched_at TEXT NOT NULL
);
`);
