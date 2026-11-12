
import { resolveDatePhrases } from "../time.js";

const FRESHNESS_PATTERNS = [
  /\b(latest|newest|current|currently|today|right now|real[- ]time)\b/i,
  /\b(recent|recently|this week|this month|this year)\b/i,
  /\b(changed|change|updated|update|still|status|available|availability)\b/i,
  /\b(pricing|price|cost|rate|stock|market value|exchange rate)\b/i,
  /\b(release|released|version|breaking|news|announced)\b/i,
  /\b(as of now|as of today|up to date)\b/i
];

const COMPARISON_PATTERNS = [
  /\b(since|compared with|compared to|what changed|difference since)\b/i,
  /\b(has .* changed|did .* change|still the same)\b/i
];

export function inspectFreshness({
  message,
  now,
  timezone
}) {
  const text = String(message || "").trim();

  const dateReferences = resolveDatePhrases(
    text,
    now,
    timezone
  );

  const freshnessMatches = FRESHNESS_PATTERNS
    .filter((pattern) => pattern.test(text))
    .map((pattern) => pattern.source);

  const isComparison = COMPARISON_PATTERNS.some(
    (pattern) => pattern.test(text)
  );

  const hasTemporalReference = dateReferences.length > 0;

  const requiresFreshness =
    freshnessMatches.length > 0 ||
    hasTemporalReference ||
    isComparison;

  return {
    requiresFreshness,
    hasTemporalReference,
    isComparison,
    dateReferences,
    reasons: [
      ...(freshnessMatches.length ? ["freshness_keyword"] : []),
      ...(hasTemporalReference ? ["date_reference"] : []),
      ...(isComparison ? ["change_comparison"] : [])
    ]
  };
}

/**
 * Routing policy:
 * - Explicit freshness requirement: research.
 * - Otherwise: allow the LLM to decide whether its knowledge is enough.
 *
 * "model_assessment" means the LLM can answer directly or call web_search.
 */
export function getRoutingMode(freshness) {
  if (freshness.requiresFreshness) {
    return "research_required";
  }

  return "model_assessment";
}
