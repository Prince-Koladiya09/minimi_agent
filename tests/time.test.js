
import test from "node:test";
import assert from "node:assert/strict";
import { resolveDatePhrases } from "../src/time.js";

const now = new Date("2026-11-11T12:00:00Z");
const timezone = "Asia/Kolkata";

test("resolves yesterday in IST", () => {
  const result = resolveDatePhrases("What happened yesterday?", now, timezone);

  assert.equal(result[0].date, "2026-11-10");
  assert.equal(result[0].start, "2026-11-09T18:30:00.000Z");
});

test("resolves last week", () => {
  const result = resolveDatePhrases("What changed last week?", now, timezone);

  assert.equal(result[0].date, "2026-11-02");
});

test("resolves two days ago", () => {
  const result = resolveDatePhrases("What happened two days ago?", now, timezone);

  assert.equal(result[0].date, "2026-11-09");
});

test("resolves next Monday in the future", () => {
  const result = resolveDatePhrases("Check next Monday", now, timezone);

  assert.equal(result[0].date, "2026-11-16");
});

test("resolves multiple weekdays", () => {
  const result = resolveDatePhrases("Compare Monday and Tuesday", now, timezone);

  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map(item => item.date),
    ["2026-11-09", "2026-11-10"]
  );
});

test("marks bare weekday as medium confidence", () => {
  const result = resolveDatePhrases("What happened Monday?", now, timezone);

  assert.equal(result[0].confidence, "medium");
});
