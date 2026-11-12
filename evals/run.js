
import fs from "node:fs";

const cases = JSON.parse(
  fs.readFileSync(new URL("./cases.json", import.meta.url), "utf8")
);

let failed = 0;

for (const item of cases) {
  if (!item.id || !item.category || !item.question) {
    console.error("[FAIL]", item.id || "unknown", "Invalid evaluation case");
    failed++;
    continue;
  }

  console.log("[CASE]", item.id, "-", item.category);
}

// This validates the fixture format only.
// Add seeded DB and mocked agent assertions before calling this
// a behavioral evaluation suite.
if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log(`Loaded ${cases.length} evaluation cases.`);
  console.log("Fixture validation passed.");
}
