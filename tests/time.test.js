import test from "node:test";
import assert from "node:assert/strict";
import { resolveDatePhrases } from "../src/time.js";

const now = new Date("2026-11-11T12:00:00+05:30");

test("resolves last Tuesday to the previous week's Tuesday", () => {
  assert.equal(resolveDatePhrases("Last Tuesday I asked about hosting",now,"Asia/Kolkata")[0]?.start,"2026-11-03T00:00:00");
});
test("resolves a bare weekday to most recent past occurrence", () => {
  assert.equal(resolveDatePhrases("On Monday we shortlisted tools",now,"Asia/Kolkata")[0]?.start,"2026-11-09T00:00:00");
});
test("resolves day and month to most recent occurrence", () => {
  assert.equal(resolveDatePhrases("What did I ask on 3 November?",now,"Asia/Kolkata")[0]?.start,"2026-11-03T00:00:00");
});
