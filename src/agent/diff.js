
export function buildClaimComparisonContext(claims = []) {
  if (!Array.isArray(claims) || claims.length === 0) {
    return "No relevant previously stored claims were found.";
  }

  return claims.slice(0, 30).map((claim, index) => ({
    index: index + 1,
    entity: claim.entity || "",
    topic: claim.topic || "",
    previousClaim: claim.claim_text || "",
    previousValue: claim.value || "",
    previousAsOf: claim.as_of || "",
    previousStatus: claim.verification_status || "unverified"
  }));
}

export const comparisonInstructions = `
When comparing new evidence with remembered claims:

1. Compare the same entity and same property.
2. Compare values, not just wording.
3. Respect dates and the time period of each claim.
4. Do not call a claim changed unless the new evidence supports a different value.
5. Do not call a claim unchanged merely because no contradictory result was found.
6. If the new evidence does not establish the current value, use "could_not_verify".
7. Distinguish a genuine change from a difference in units, naming, or scope.

For each entity return one verdict:
- changed
- unchanged_verified
- could_not_verify

Include the old claim, new evidence, and supporting source IDs.
`;
