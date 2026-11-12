
export function createMetrics() {
  const startedAt = performance.now();

  return {
    startedAt,
    firstStatusMs: null,
    firstTokenMs: null,
    searches: 0,
    cacheHits: 0,
    inputTokens: 0,
    outputTokens: 0
  };
}

export function logMetrics(metrics, extra = {}) {
  const totalMs = Math.round(performance.now() - metrics.startedAt);

  console.log(JSON.stringify({
    type: "minimi_turn_metrics",
    totalMs,
    firstStatusMs: metrics.firstStatusMs,
    firstTokenMs: metrics.firstTokenMs,
    searches: metrics.searches,
    cacheHits: metrics.cacheHits,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    ...extra
  }));
}
