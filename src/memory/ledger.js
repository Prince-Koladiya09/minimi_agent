import OpenAI from "openai";
import { config } from "../config.js";
import { db } from "./db.js";

export async function extractClaims(client, conversationId, answer, sources) {
  try {
    const response = await client.chat.completions.create({
      model: config.openaiModel,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: `Extract only concrete, checkable factual claims from the assistant answer.
Return JSON {"claims":[{"topic":"","entity":"","claim_text":"","claim_type":"pricing|feature|version|limit|other","value":"","confidence":0.0,"source_urls":[]}]}.
Do not invent claims or URLs. source_urls must be selected from this list: ${JSON.stringify(sources.map(s=>s.url))}.` },
        { role: "user", content: answer }
      ]
    });
    const parsed = JSON.parse(response.choices[0]?.message.content || '{"claims":[]}');
    const insert = db.prepare(`INSERT INTO claims(conversation_id,topic,entity,claim_text,claim_type,value,as_of,
      source_urls_json,confidence,verification_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    const tx = db.transaction(claims => {
      for (const c of claims.slice(0,20)) insert.run(conversationId,c.topic||"",c.entity||"",c.claim_text,
        c.claim_type||"other",c.value||"",new Date().toISOString(),JSON.stringify(c.source_urls||[]),
        Math.max(0,Math.min(1,Number(c.confidence)||0.5)),"unverified",new Date().toISOString());
    });
    tx(parsed.claims || []);
  } catch (err) {
    console.error("Claim extraction skipped:", err instanceof Error ? err.message : err);
  }
}
