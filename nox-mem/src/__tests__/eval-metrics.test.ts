// R01a — Eval metrics unit tests.
// Cobre 3 cenários canônicos: perfect ranking, reverse ranking, partial overlap +
// edge cases (empty gold, no overlap).
//
// Run: cd /root/.openclaw/workspace/tools/nox-mem && npx tsc &&
//      node --test dist/__tests__/eval-metrics.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ndcgAtK,
  reciprocalRank,
  recallAtK,
  precisionAtK,
  mean,
  computePerQuery,
} from "../lib/eval-metrics.js";

// ─────────────────────────────────────────────────────────────────────
// nDCG@10 — 3 canonical cases
// ─────────────────────────────────────────────────────────────────────

test("ndcgAtK: perfect ranking (gold all in top, in same order) → 1.0", () => {
  const gold = new Set([1, 2, 3]);
  const retrieved = [1, 2, 3, 99, 98];
  assert.equal(ndcgAtK(retrieved, gold, 10), 1.0);
});

test("ndcgAtK: reverse ranking (gold present but at bottom) → < perfect", () => {
  const gold = new Set([1, 2, 3]);
  const retrieved = [99, 98, 97, 96, 1, 2, 3, 95, 94, 93];
  const score = ndcgAtK(retrieved, gold, 10);
  assert.ok(score > 0 && score < 1.0, `score ${score} should be (0,1)`);
  // Manual: DCG = 1/log2(6) + 1/log2(7) + 1/log2(8) = 0.387 + 0.356 + 0.333 = 1.076
  // IDCG = 1/log2(2) + 1/log2(3) + 1/log2(4) = 1 + 0.631 + 0.5 = 2.131
  // nDCG ≈ 0.505
  assert.ok(Math.abs(score - 0.505) < 0.01, `expected ~0.505, got ${score}`);
});

test("ndcgAtK: partial overlap (1 of 3 gold present) → mid range", () => {
  const gold = new Set([1, 2, 3]);
  const retrieved = [1, 99, 98, 97, 96, 95, 94, 93, 92, 91];
  const score = ndcgAtK(retrieved, gold, 10);
  // DCG = 1/log2(2) = 1.0; IDCG = 2.131; nDCG ≈ 0.469
  assert.ok(Math.abs(score - 0.469) < 0.01, `expected ~0.469, got ${score}`);
});

test("ndcgAtK: empty gold returns 0 (convention)", () => {
  assert.equal(ndcgAtK([1, 2, 3], new Set(), 10), 0);
});

test("ndcgAtK: zero overlap returns 0", () => {
  assert.equal(ndcgAtK([99, 98, 97], new Set([1, 2, 3]), 10), 0);
});

// ─────────────────────────────────────────────────────────────────────
// MRR
// ─────────────────────────────────────────────────────────────────────

test("reciprocalRank: gold at position 1 → 1.0", () => {
  assert.equal(reciprocalRank([5, 99, 98], new Set([5])), 1.0);
});

test("reciprocalRank: gold at position 3 → 1/3", () => {
  assert.ok(Math.abs(reciprocalRank([99, 98, 5], new Set([5])) - 1 / 3) < 0.001);
});

test("reciprocalRank: no gold in retrieved → 0", () => {
  assert.equal(reciprocalRank([99, 98, 97], new Set([1, 2])), 0);
});

test("reciprocalRank: takes FIRST gold hit (not all)", () => {
  // Gold at positions 2 and 5 → returns 1/2
  assert.equal(reciprocalRank([99, 5, 98, 97, 6], new Set([5, 6])), 0.5);
});

// ─────────────────────────────────────────────────────────────────────
// Recall@10
// ─────────────────────────────────────────────────────────────────────

test("recallAtK: all gold in top-K → 1.0", () => {
  assert.equal(recallAtK([1, 2, 3, 99], new Set([1, 2, 3]), 10), 1.0);
});

test("recallAtK: half gold in top-K → 0.5", () => {
  assert.equal(recallAtK([1, 2, 99, 98], new Set([1, 2, 3, 4]), 10), 0.5);
});

test("recallAtK: cutoff truncates retrieved", () => {
  // Gold [1,2], retrieved [99, 1, 2], K=2 → only [99, 1] considered → 1 hit / 2 gold = 0.5
  assert.equal(recallAtK([99, 1, 2], new Set([1, 2]), 2), 0.5);
});

test("recallAtK: empty gold returns 0", () => {
  assert.equal(recallAtK([1, 2], new Set(), 10), 0);
});

// ─────────────────────────────────────────────────────────────────────
// Precision@5
// ─────────────────────────────────────────────────────────────────────

test("precisionAtK: 3 of top-5 are gold → 0.6", () => {
  assert.equal(precisionAtK([1, 2, 3, 99, 98], new Set([1, 2, 3]), 5), 0.6);
});

test("precisionAtK: denominator is K not min(K, retrieved)", () => {
  // Only 2 retrieved, both gold; precision@5 = 2/5 = 0.4
  assert.equal(precisionAtK([1, 2], new Set([1, 2]), 5), 0.4);
});

test("precisionAtK: K=0 returns 0 (avoid div by zero)", () => {
  assert.equal(precisionAtK([1, 2], new Set([1]), 0), 0);
});

// ─────────────────────────────────────────────────────────────────────
// mean + computePerQuery
// ─────────────────────────────────────────────────────────────────────

test("mean: simple average", () => {
  assert.equal(mean([1, 2, 3, 4]), 2.5);
});

test("mean: filters NaN", () => {
  assert.equal(mean([1, NaN, 3]), 2);
});

test("mean: all NaN returns 0", () => {
  assert.equal(mean([NaN, NaN]), 0);
});

test("computePerQuery: returns all 4 metrics", () => {
  const m = computePerQuery([1, 2, 99], new Set([1, 2]));
  assert.ok(m.ndcg_at_10 > 0);
  assert.equal(m.mrr, 1.0);
  assert.equal(m.recall_at_10, 1.0);
  assert.equal(m.precision_at_5, 0.4); // 2/5
});
