
export function assessSearchResults(results = []) {
  const usable = results.filter((item) =>
    item &&
    typeof item.url === "string" &&
    typeof item.title === "string" &&
    typeof item.snippet === "string"
  );

  return {
    sufficientToReview: usable.length > 0,
    resultCount: usable.length,
    results: usable
  };
}

export function buildRefinementInstruction(results = []) {
  if (!results.length) {
    return [
      "The previous search returned no usable results.",
      "Reformulate the query using alternative terminology,",
      "official documentation, or the exact entity name.",
      "Do not repeat the same query."
    ].join(" ");
  }

  return [
    "Review the retrieved evidence.",
    "Identify which parts of the question remain unanswered.",
    "If more research is needed, search only for the missing information.",
    "Use a materially different query or a more authoritative domain.",
    "Do not repeat searches that have already returned the same evidence."
  ].join(" ");
}

export function deduplicateResults(results = []) {
  const seen = new Set();

  return results.filter((item) => {
    if (!item?.url) return false;

    const key = item.url.trim().toLowerCase();

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}
