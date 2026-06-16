// D01 — Cross-encoder Reranker tests.
// Spec: memoria-nox/specs/2026-05-07-D01-cross-encoder-reranker.md
//
// Run: cd /root/.openclaw/workspace/tools/nox-mem && npx tsc &&
//      node --test dist/__tests__/reranker.test.js

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Use OS tmp (cross-platform). VPS test pode override via NOX_TEST_TMP_ROOT.
const TMP_BASE = process.env.NOX_TEST_TMP_ROOT || tmpdir();
const TMP_ROOT = mkdtempSync(join(TMP_BASE, "nox-mem-reranker-test-"));
const TEST_DB = join(TMP_ROOT, "test.db");
process.env.NOX_DB_PATH = TEST_DB;

let getDb: any, closeDb: any;
let rerank: any;
let __setRerankerFnForTesting: any;
let computePositionChanges: any;
let computeLiftScore: any;
let getMode: any, getTopKIn: any, getTopKOut: any;

before(async () => {
  const dbMod = await import("../db.js");
  const rrMod = await import("../lib/reranker.js");
  getDb = dbMod.getDb;
  closeDb = dbMod.closeDb;
  rerank = rrMod.rerank;
  __setRerankerFnForTesting = rrMod.__setRerankerFnForTesting;
  computePositionChanges = rrMod.computePositionChanges;
  computeLiftScore = rrMod.computeLiftScore;
  getMode = rrMod.getMode;
  getTopKIn = rrMod.getTopKIn;
  getTopKOut = rrMod.getTopKOut;

  // Bootstrap schema (ensures v16 applied).
  const db = getDb();
  const v = (db.prepare("PRAGMA user_version").get() as any).user_version;
  assert.equal(v >= 16, true, `expected schema ≥16, got ${v}`);

  // Confirma que as 6 cols existem em search_telemetry.
  const cols = db.prepare("PRAGMA table_info(search_telemetry)").all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name);
  for (const expected of [
    "reranker_mode",
    "reranker_top_k_in",
    "reranker_top_k_out",
    "reranker_latency_ms",
    "reranker_position_changes",
    "reranker_lift_score",
  ]) {
    assert.equal(names.includes(expected), true, `column ${expected} missing in search_telemetry`);
  }
});

beforeEach(() => {
  // Reset env entre tests
  delete process.env.NOX_RERANKER_MODE;
  delete process.env.NOX_RERANKER_TOP_K_IN;
  delete process.env.NOX_RERANKER_TOP_K_OUT;
  delete process.env.NOX_RERANKER_TIMEOUT_MS;
  delete process.env.NOX_RERANKER_LOG;
  __setRerankerFnForTesting(null);
});

after(() => {
  __setRerankerFnForTesting(null);
  closeDb();
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────

function makeCandidates(n: number): Array<{
  id: number; score: number; rrfScore: number; chunk_text: string;
  source_file: string; chunk_type: string; source_date: string | null;
}> {
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: i + 1,
      score: 100 - i,
      rrfScore: 100 - i,
      chunk_text: `chunk text ${i + 1}: content about item ${i + 1}`,
      source_file: `file-${i + 1}.md`,
      chunk_type: "concept",
      source_date: null,
    });
  }
  return out;
}

// Mock fn: REAL inversão (idx 0 → score baixo, idx N-1 → score alto).
// Sorted desc pelo reranker → ordem invertida em relação ao input.
function makeReverseRerankerFn() {
  return async (pairs: Array<{ text: string; text_pair: string }>) => {
    return pairs.map((_, i) => ({ score: i / pairs.length }));
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 1. mode=off: rerank não chamado, retorna candidates intactos
// ─────────────────────────────────────────────────────────────────────────

test("rerank: mode=off bypass — fn não chamada, retorna candidates intactos", async () => {
  process.env.NOX_RERANKER_MODE = "off";
  let called = false;
  __setRerankerFnForTesting(async () => {
    called = true;
    return [];
  });
  const cands = makeCandidates(5);
  const { results, summary } = await rerank("test query", cands, 3);
  assert.equal(called, false, "fn should not be called in off mode");
  assert.equal(results.length, 3);
  assert.equal(results[0].id, 1);
  assert.equal(results[2].id, 3);
  assert.equal(summary.mode, "off");
  assert.equal(summary.positionChanges, 0);
});

// ─────────────────────────────────────────────────────────────────────────
// 2. mode=shadow: fn chamada, telemetria, ranking original retornado
// ─────────────────────────────────────────────────────────────────────────

test("rerank: mode=shadow — fn chamada, retorna ORIGINAL top-K (não muta)", async () => {
  process.env.NOX_RERANKER_MODE = "shadow";
  __setRerankerFnForTesting(makeReverseRerankerFn());
  const cands = makeCandidates(5);
  const { results, summary } = await rerank("test query", cands, 3);
  // Reranker invertido reordenaria pra [5,4,3,2,1] mas shadow retorna ORIGINAL
  assert.equal(results.length, 3);
  assert.equal(results[0].id, 1, "shadow preserves original top");
  assert.equal(results[1].id, 2);
  assert.equal(results[2].id, 3);
  assert.equal(summary.mode, "shadow");
  assert.equal(summary.failed, false);
  assert.equal(summary.topKOut, 3);
  // Position changes computed entre orig top-3 [1,2,3] vs new top-3 [5,4,3]:
  //   id=1 saiu (orig:0, new:undef) → 1 change
  //   id=2 saiu (orig:1, new:undef) → 1 change
  //   id=3 ficou (orig:2, new:2) → 0 change
  //   id=4 entrou (orig:undef, new:1) → 1 change
  //   id=5 entrou (orig:undef, new:0) → 1 change
  // Total: 4 changes (id=3 unchanged).
  assert.equal(summary.positionChanges, 4, `expected 4, got ${summary.positionChanges}`);
});

// ─────────────────────────────────────────────────────────────────────────
// 3. mode=active: fn chamada, ranking substituído pelo reranker
// ─────────────────────────────────────────────────────────────────────────

test("rerank: mode=active — substitui ranking pelo output do reranker", async () => {
  process.env.NOX_RERANKER_MODE = "active";
  // Reverse mock: idx N-1 ganha score máximo → top-3 do reranker = [5,4,3]
  __setRerankerFnForTesting(makeReverseRerankerFn());
  const cands = makeCandidates(5);
  const { results, summary } = await rerank("test query", cands, 3);
  assert.equal(results.length, 3);
  assert.equal(results[0].id, 5, "active mode: highest reranker score wins");
  assert.equal(results[1].id, 4);
  assert.equal(results[2].id, 3);
  assert.equal(summary.mode, "active");
  assert.equal(summary.failed, false);
});

// ─────────────────────────────────────────────────────────────────────────
// 4. computePositionChanges helper
// ─────────────────────────────────────────────────────────────────────────

test("computePositionChanges: pos 0↔1 → 2 changes", () => {
  const orig = [
    { id: 1, chunk_text: "" },
    { id: 2, chunk_text: "" },
    { id: 3, chunk_text: "" },
  ];
  const next = [
    { id: 2, chunk_text: "" },
    { id: 1, chunk_text: "" },
    { id: 3, chunk_text: "" },
  ];
  assert.equal(computePositionChanges(orig, next), 2);
});

test("computePositionChanges: ranking idêntico → 0", () => {
  const cands = makeCandidates(3);
  assert.equal(computePositionChanges(cands, cands), 0);
});

test("computePositionChanges: disjoint → 6 changes (3 left + 3 entered)", () => {
  const orig = [
    { id: 1, chunk_text: "" },
    { id: 2, chunk_text: "" },
    { id: 3, chunk_text: "" },
  ];
  const next = [
    { id: 4, chunk_text: "" },
    { id: 5, chunk_text: "" },
    { id: 6, chunk_text: "" },
  ];
  assert.equal(computePositionChanges(orig, next), 6);
});

// ─────────────────────────────────────────────────────────────────────────
// 5. computeLiftScore helper
// ─────────────────────────────────────────────────────────────────────────

test("computeLiftScore: identical ranking → 0", () => {
  const cands = makeCandidates(5);
  assert.equal(computeLiftScore(cands, cands), 0);
});

test("computeLiftScore: swap pos 0↔4 em K=5 → 8/(5*5) = 0.32", () => {
  const orig = [
    { id: 1, chunk_text: "" },
    { id: 2, chunk_text: "" },
    { id: 3, chunk_text: "" },
    { id: 4, chunk_text: "" },
    { id: 5, chunk_text: "" },
  ];
  const next = [
    { id: 5, chunk_text: "" },
    { id: 2, chunk_text: "" },
    { id: 3, chunk_text: "" },
    { id: 4, chunk_text: "" },
    { id: 1, chunk_text: "" },
  ];
  // allIds=5; deltas: id=1 |0-4|=4, id=5 |4-0|=4, ids 2,3,4 = 0. sum=8.
  // norm = 8 / (5 * 5) = 0.32
  const lift = computeLiftScore(orig, next);
  assert.equal(Math.abs(lift - 0.32) < 0.001, true, `expected 0.32, got ${lift}`);
});

test("computeLiftScore: disjoint sets → 1 (max lift)", () => {
  const orig = [{ id: 1, chunk_text: "" }, { id: 2, chunk_text: "" }];
  const next = [{ id: 3, chunk_text: "" }, { id: 4, chunk_text: "" }];
  assert.equal(computeLiftScore(orig, next), 1);
});

// ─────────────────────────────────────────────────────────────────────────
// 6. fail-open: rerank fn lança → retorna candidates originais, summary.failed
// ─────────────────────────────────────────────────────────────────────────

test("rerank: fail-open — fn throws → retorna originais, summary.failed=true", async () => {
  process.env.NOX_RERANKER_MODE = "active";
  __setRerankerFnForTesting(async () => {
    throw new Error("simulated ONNX crash");
  });
  const cands = makeCandidates(5);
  const { results, summary } = await rerank("test query", cands, 3);
  assert.equal(results.length, 3);
  assert.equal(results[0].id, 1, "fail-open returns original ranking");
  assert.equal(results[1].id, 2);
  assert.equal(results[2].id, 3);
  assert.equal(summary.failed, true);
  assert.ok(summary.failureReason);
  assert.ok(summary.failureReason.includes("simulated"));
});

// ─────────────────────────────────────────────────────────────────────────
// 7. timeout: fn excede NOX_RERANKER_TIMEOUT_MS → fail-open
// ─────────────────────────────────────────────────────────────────────────

test("rerank: timeout — fn lenta excede timeout → fail-open", async () => {
  process.env.NOX_RERANKER_MODE = "active";
  process.env.NOX_RERANKER_TIMEOUT_MS = "100";
  __setRerankerFnForTesting(async (pairs: any) => {
    await new Promise((r) => setTimeout(r, 500));
    return pairs.map(() => ({ score: 0.5 }));
  });
  const cands = makeCandidates(5);
  const t0 = Date.now();
  const { results, summary } = await rerank("test query", cands, 3);
  const elapsed = Date.now() - t0;
  assert.equal(results[0].id, 1, "timeout fail-open returns original ranking");
  assert.equal(summary.failed, true);
  assert.ok(summary.failureReason && summary.failureReason.includes("timeout"));
  assert.ok(elapsed < 400, `should bail before fn completes (got ${elapsed}ms)`);
});

// ─────────────────────────────────────────────────────────────────────────
// 8. K_IN clip: candidates < K_IN → reranker vê todos (não pad)
// ─────────────────────────────────────────────────────────────────────────

test("rerank: K_IN clip — candidates.length < K_IN → fn recebe todos", async () => {
  process.env.NOX_RERANKER_MODE = "active";
  process.env.NOX_RERANKER_TOP_K_IN = "50";
  let receivedCount = -1;
  __setRerankerFnForTesting(async (pairs: any) => {
    receivedCount = pairs.length;
    return pairs.map(() => ({ score: 0.5 }));
  });
  const cands = makeCandidates(20);
  await rerank("test query", cands, 10);
  assert.equal(receivedCount, 20, "fn should see all 20 candidates (not padded to 50)");
});

// ─────────────────────────────────────────────────────────────────────────
// 9. K_OUT clip
// ─────────────────────────────────────────────────────────────────────────

test("rerank: K_OUT clip — candidates=50 + K_OUT=10 → final.length=10", async () => {
  process.env.NOX_RERANKER_MODE = "active";
  __setRerankerFnForTesting(async (pairs: any) =>
    pairs.map((_: any, i: number) => ({ score: 1 - i / pairs.length }))
  );
  const cands = makeCandidates(50);
  const { results, summary } = await rerank("test query", cands, 10);
  assert.equal(results.length, 10);
  assert.equal(summary.topKOut, 10);
});

// ─────────────────────────────────────────────────────────────────────────
// 10. empty candidates → no-op, latency=0
// ─────────────────────────────────────────────────────────────────────────

test("rerank: candidates vazio → no-op, latency baixa", async () => {
  process.env.NOX_RERANKER_MODE = "active";
  let called = false;
  __setRerankerFnForTesting(async () => {
    called = true;
    return [];
  });
  const { results, summary } = await rerank("test query", [], 10);
  assert.equal(results.length, 0);
  assert.equal(called, false, "fn should not be called for empty candidates");
  assert.equal(summary.failed, false);
  assert.ok(summary.latencyMs < 50, `latency should be small (got ${summary.latencyMs}ms)`);
});

// ─────────────────────────────────────────────────────────────────────────
// 11. shadow mode preserves rrfScore-style rank metadata; only summary differs
// ─────────────────────────────────────────────────────────────────────────

test("rerank: shadow mode — summary captura lift mas resultados intactos", async () => {
  process.env.NOX_RERANKER_MODE = "shadow";
  __setRerankerFnForTesting(async (pairs: any) =>
    // Inverte completamente: idx 0 → score 0, idx N-1 → score 1
    pairs.map((_: any, i: number) => ({ score: i / pairs.length }))
  );
  const cands = makeCandidates(5);
  const { results, summary } = await rerank("test query", cands, 3);
  // Shadow: results = original top-3 = [1,2,3]
  assert.equal(results[0].id, 1);
  assert.equal(results[1].id, 2);
  assert.equal(results[2].id, 3);
  // Summary captura o que TERIA sido: position changes >0
  assert.equal(summary.mode, "shadow");
  assert.ok(summary.positionChanges > 0, `expected position_changes>0, got ${summary.positionChanges}`);
  assert.ok(summary.liftScore > 0, `expected liftScore>0, got ${summary.liftScore}`);
});

// ─────────────────────────────────────────────────────────────────────────
// 12. mode helpers expostos
// ─────────────────────────────────────────────────────────────────────────

test("getMode/getTopKIn/getTopKOut: env parsing + defaults", () => {
  delete process.env.NOX_RERANKER_MODE;
  assert.equal(getMode(), "off");
  process.env.NOX_RERANKER_MODE = "shadow";
  assert.equal(getMode(), "shadow");
  process.env.NOX_RERANKER_MODE = "ACTIVE"; // case-insensitive
  assert.equal(getMode(), "active");
  process.env.NOX_RERANKER_MODE = "garbage";
  assert.equal(getMode(), "off"); // fail-safe

  delete process.env.NOX_RERANKER_TOP_K_IN;
  assert.equal(getTopKIn(), 50);
  process.env.NOX_RERANKER_TOP_K_IN = "30";
  assert.equal(getTopKIn(), 30);
  process.env.NOX_RERANKER_TOP_K_IN = "not-a-number";
  assert.equal(getTopKIn(), 50);

  delete process.env.NOX_RERANKER_TOP_K_OUT;
  assert.equal(getTopKOut(), 10);
});
