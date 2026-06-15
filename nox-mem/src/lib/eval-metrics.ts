// R01a — Eval metrics pure functions.
// Spec: specs/2026-04-27-R01a-eval-harness.md (formulações exatas)
//
// All functions are pure (no DB, no I/O). Take retrieved chunk IDs ranked +
// gold standard (expected chunk IDs as Set). Return [0, 1] scores.

/**
 * nDCG@K — Normalized Discounted Cumulative Gain.
 * Binary relevance (1 if chunk ∈ gold, else 0).
 *
 * DCG@K  = Σ (i=1..K) [ rel(ri) / log2(i+1) ]
 * IDCG@K = Σ (i=1..min(|G|, K)) [ 1 / log2(i+1) ]
 * nDCG@K = DCG@K / IDCG@K (clamped to [0, 1])
 *
 * Returns 0 if gold standard is empty (no positives = undefined; convention 0).
 */
export function ndcgAtK(retrieved: number[], gold: Set<number>, k: number): number {
  if (gold.size === 0) return 0;
  const cutoff = Math.min(k, retrieved.length);
  let dcg = 0;
  for (let i = 0; i < cutoff; i++) {
    const rel = gold.has(retrieved[i]) ? 1 : 0;
    if (rel === 0) continue;
    // i is 0-indexed; rank is (i+1); discount log2(rank+1) = log2(i+2)
    dcg += rel / Math.log2(i + 2);
  }
  let idcg = 0;
  const idealCount = Math.min(gold.size, k);
  for (let i = 0; i < idealCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  if (idcg === 0) return 0;
  return Math.max(0, Math.min(1, dcg / idcg));
}

/**
 * MRR — Mean Reciprocal Rank (per-query; aggregate is mean of these).
 * Returns 1/rank of first gold hit, else 0.
 */
export function reciprocalRank(retrieved: number[], gold: Set<number>): number {
  if (gold.size === 0) return 0;
  for (let i = 0; i < retrieved.length; i++) {
    if (gold.has(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Recall@K — fraction of gold present in top-K retrieved.
 */
export function recallAtK(retrieved: number[], gold: Set<number>, k: number): number {
  if (gold.size === 0) return 0;
  const cutoff = Math.min(k, retrieved.length);
  let hits = 0;
  for (let i = 0; i < cutoff; i++) {
    if (gold.has(retrieved[i])) hits++;
  }
  return hits / gold.size;
}

/**
 * Precision@K — fraction of top-K that is gold.
 * Denominator is always K (not min(K, retrieved.length)) — convention.
 */
export function precisionAtK(retrieved: number[], gold: Set<number>, k: number): number {
  if (k === 0) return 0;
  const cutoff = Math.min(k, retrieved.length);
  let hits = 0;
  for (let i = 0; i < cutoff; i++) {
    if (gold.has(retrieved[i])) hits++;
  }
  return hits / k;
}

/**
 * Aggregate mean across queries. Skips NaN (gold-empty queries with conventions).
 */
export function mean(values: number[]): number {
  const valid = values.filter((v) => !Number.isNaN(v));
  if (valid.length === 0) return 0;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

export interface PerQueryMetrics {
  ndcg_at_10: number;
  mrr: number;
  recall_at_10: number;
  precision_at_5: number;
}

export function computePerQuery(retrieved: number[], gold: Set<number>): PerQueryMetrics {
  return {
    ndcg_at_10: ndcgAtK(retrieved, gold, 10),
    mrr: reciprocalRank(retrieved, gold),
    recall_at_10: recallAtK(retrieved, gold, 10),
    precision_at_5: precisionAtK(retrieved, gold, 5),
  };
}
