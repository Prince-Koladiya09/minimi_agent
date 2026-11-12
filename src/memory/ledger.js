
import { db } from "./db.js";

const insertClaim = db.prepare(`
  INSERT INTO claims (
    conversation_id,
    message_id,
    topic,
    entity,
    claim_text,
    claim_type,
    value,
    as_of,
    extracted_at,
    source_urls_json,
    confidence,
    verification_status
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertFts = db.prepare(`
  INSERT INTO claims_fts (
    rowid,
    topic,
    entity,
    claim_text
  )
  VALUES (?, ?, ?, ?)
`);

const allowedClaimTypes = new Set([
  "pricing",
  "feature",
  "version",
  "limit",
  "other"
]);

export async function extractClaims(
  client,
  conversationId,
  messageId,
  originalMessage,
  assistantAnswer,
  sources = [],
  model
) {
  if (!client || !model) return;

  const message = db.prepare(`
    SELECT created_at
    FROM messages
    WHERE id = ? AND conversation_id = ?
  `).get(messageId, conversationId);

  if (!message) return;

  const allowedUrls = sources
    .map((source) => source?.url)
    .filter((url) => typeof url === "string");

  let completion;

  try {
    completion = await client.chat.completions.create({
      model,
      temperature: 0,
      max_completion_tokens: 500,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Extract only concrete, checkable facts explicitly stated " +
            "by the user or assistant. Do not invent details. " +
            'Return JSON: {"claims":[{"topic":"","entity":",' +
            '"claim_text":"","claim_type":"pricing|feature|version|limit|other",' +
            '"value":"","confidence":0.0,"source_urls":[]}]}.' +
            "Only use URLs from this allowed list: " +
            JSON.stringify(allowedUrls)
        },
        {
          role: "user",
          content:
            `Original user message:\n${String(originalMessage || "").slice(0, 1000)}\n\n` +
            `Assistant answer:\n${String(assistantAnswer || "").slice(0, 2000)}`
        }
      ]
    });
  } catch (error) {
    console.error("Claim extraction failed:", error.message);
    return;
  }

  const raw = completion.choices?.[0]?.message?.content || "{}";

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("Claim extraction returned invalid JSON");
    return;
  }

  const claims = Array.isArray(parsed.claims)
    ? parsed.claims.slice(0, 10)
    : [];

  const now = new Date().toISOString();
  const asOf = message.created_at || now;

  const saveClaims = db.transaction(() => {
    for (const claim of claims) {
      if (
        !claim ||
        typeof claim.claim_text !== "string" ||
        !claim.claim_text.trim()
      ) {
        continue;
      }

      const entity = String(claim.entity || "").slice(0, 150);
      const topic = String(claim.topic || "").slice(0, 150);
      const claimText = claim.claim_text.trim().slice(0, 500);

      const claimType = allowedClaimTypes.has(claim.claim_type)
        ? claim.claim_type
        : "other";

      const value = String(claim.value || "").slice(0, 200);

      const urls = Array.isArray(claim.source_urls)
        ? claim.source_urls.filter(
            (url) =>
              typeof url === "string" &&
              allowedUrls.includes(url)
          )
        : [];

      const parsedConfidence = Number(claim.confidence);

      const confidence = Number.isFinite(parsedConfidence)
        ? Math.max(0, Math.min(1, parsedConfidence))
        : 0.5;

      const result = insertClaim.run(
        conversationId,
        messageId,
        topic,
        entity,
        claimText,
        claimType,
        value,
        asOf,
        now,
        JSON.stringify(urls),
        confidence,
        "unverified"
      );

      insertFts.run(
        result.lastInsertRowid,
        topic,
        entity,
        claimText
      );
    }
  });

  try {
    saveClaims();
  } catch (error) {
    console.error("Saving extracted claims failed:", error.message);
  }
}

export function searchClaims(query, limit = 10) {
  const terms = String(query || "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((term) => term.length > 2)
    .slice(0, 8);

  if (!terms.length) return [];

  const match = terms
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" OR ");

  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));

  return db.prepare(`
    SELECT c.*
    FROM claims_fts f
    JOIN claims c ON c.id = f.rowid
    WHERE claims_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all(match, safeLimit);
}
