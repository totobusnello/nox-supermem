// R01a — Eval orchestration tests (importGolden + DB lifecycle).
//
// Run: cd /root/.openclaw/workspace/tools/nox-mem && npx tsc &&
//      node --test dist/__tests__/eval.test.js

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TMP_ROOT = mkdtempSync("/var/backups/nox-mem-eval-test-");
const TEST_DB = join(TMP_ROOT, "test.db");
process.env.NOX_DB_PATH = TEST_DB;
process.env.NOX_EVAL_REPORTS_DIR = join(TMP_ROOT, "reports/eval");

// Dynamic imports — db.ts captures NOX_DB_PATH at module-load, so we MUST set
// env BEFORE importing (ESM static imports are hoisted before body code).
let getDb: any, closeDb: any;
let importGolden: any, listGolden: any, listRuns: any, aggregateForRun: any, getEvalMetricsSnapshot: any;

before(async () => {
  const dbMod = await import("../db.js");
  const evalMod = await import("../lib/eval.js");
  getDb = dbMod.getDb;
  closeDb = dbMod.closeDb;
  importGolden = evalMod.importGolden;
  listGolden = evalMod.listGolden;
  listRuns = evalMod.listRuns;
  aggregateForRun = evalMod.aggregateForRun;
  getEvalMetricsSnapshot = evalMod.getEvalMetricsSnapshot;
  getDb(); // triggers ensureSchema → creates eval_* tables
});

after(() => {
  try { closeDb(); } catch { /* ignore */ }
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

test("schema v11+: eval_queries / eval_runs / eval_results tables created", () => {
  const db = getDb();
  for (const t of ["eval_queries", "eval_runs", "eval_results"]) {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t);
    assert.ok(row, `table ${t} missing`);
  }
  const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert.ok(v >= 11, `PRAGMA user_version is ${v}, expected ≥11`);
});

test("importGolden: reads JSONL, INSERT OR IGNORE", () => {
  const file = join(TMP_ROOT, "golden.jsonl");
  const lines = [
    { query: "test query 1", expected_chunk_ids: [1, 2], difficulty: "easy", category: "test" },
    { query: "test query 2", expected_chunk_ids: [3], difficulty: "hard", category: "entity" },
    { query: "test query 1", expected_chunk_ids: [99] }, // duplicate
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"));
  const r = importGolden(file, "test");
  assert.equal(r.imported, 2);
  assert.equal(r.skipped, 1);
  assert.equal(r.total, 2);
});

test("importGolden: skips malformed JSON lines", () => {
  const file = join(TMP_ROOT, "bad.jsonl");
  writeFileSync(file, "{broken\n{\"query\":\"valid\",\"expected_chunk_ids\":[42]}\n");
  const r = importGolden(file);
  assert.equal(r.imported, 1);
  assert.ok(r.skipped >= 1);
});

test("importGolden: skips invalid shape", () => {
  const file = join(TMP_ROOT, "shape.jsonl");
  writeFileSync(file, JSON.stringify({ query: "x" }) + "\n"); // missing expected_chunk_ids
  const r = importGolden(file);
  assert.equal(r.imported, 0);
  assert.equal(r.skipped, 1);
});

test("listGolden: returns parsed array", () => {
  const golden = listGolden();
  assert.ok(golden.length >= 2);
  const q = golden.find((g: any) => g.query === "test query 1");
  assert.ok(q);
  assert.deepEqual(q!.expected_chunk_ids, [1, 2]);
  assert.equal(q!.difficulty, "easy");
});

test("listRuns: empty when no runs persisted", () => {
  const rows = listRuns();
  assert.equal(rows.length, 0);
});

test("aggregateForRun: returns null for nonexistent run", () => {
  assert.equal(aggregateForRun(99999), null);
});

test("getEvalMetricsSnapshot: empty state shape", () => {
  const snap = getEvalMetricsSnapshot();
  assert.equal(snap.lastRun, null);
  assert.deepEqual(snap.byVariant, {});
});
