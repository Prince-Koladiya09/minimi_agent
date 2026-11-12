
function normalizeUrl(value) {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString().replace(/[.,;!?]+$/, "");
  } catch {
    return String(value || "").replace(/[.,;!?]+$/, "");
  }
}

export function validateCitations(answer, sources = []) {
  const safeSources = Array.isArray(sources) ? sources : [];

  const validIds = new Set(
    safeSources
      .map((source) => source?.id)
      .filter(Boolean)
  );

  const sourceUrls = new Set(
    safeSources
      .map((source) => source?.url)
      .filter(Boolean)
      .map(normalizeUrl)
  );

  const usedIds = new Set();
  const invalidIds = new Set();

  const text = String(answer || "").replace(
    /\[(S\d+)\]/g,
    (match, id) => {
      if (validIds.has(id)) {
        usedIds.add(id);
        return match;
      }

      invalidIds.add(id);
      return `[unverified citation: ${id}]`;
    }
  );

  const urls = text.match(/https?:\/\/[^\s<>"']+/g) || [];

  const unverifiedUrls = [
    ...new Set(
      urls
        .map(normalizeUrl)
        .filter((url) => !sourceUrls.has(url))
    )
  ];

  return {
    answer: text,
    validIds: [...usedIds],
    invalidIds: [...invalidIds],
    unverifiedUrls
  };
}
