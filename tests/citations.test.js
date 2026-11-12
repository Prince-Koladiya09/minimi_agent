
import test from "node:test";
import assert from "node:assert/strict";
import { validateCitations } from "../src/agent/citations.js";

test("accepts valid source IDs", () => {
  const result = validateCitations(
    "The price changed [S1].",
    [{ id: "S1", url: "https://example.com" }]
  );

  assert.deepEqual(result.invalidIds, []);
  assert.deepEqual(result.validIds, ["S1"]);
});

test("flags unknown source IDs", () => {
  const result = validateCitations(
    "The price changed [S8].",
    [{ id: "S1", url: "https://example.com" }]
  );

  assert.deepEqual(result.invalidIds, ["S8"]);
  assert.match(result.answer, /unverified citation/);
});
