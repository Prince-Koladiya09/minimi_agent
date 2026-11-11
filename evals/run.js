import { readFile } from "node:fs/promises";
const cases = JSON.parse(await readFile(new URL("./cases.json", import.meta.url), "utf8"));
console.log(`Loaded ${cases.length} smoke-evaluation cases.`);
for (const c of cases) console.log(`- ${c.id}: ${c.expected}`);
console.log("These are scenario specifications, not automated model-quality scores yet.");
