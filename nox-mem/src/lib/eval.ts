// R01a — Eval Harness orchestration.
// Spec: specs/2026-04-27-R01a-eval-harness.md
//
// init: ensures schema (delegated to ensureSchema in db.ts)
// importGolden: read JSONL, INSERT OR IGNORE
// runEval: execute search() per query, compute metrics, persist run + results
// compareRuns: diff two runs side-by-side
// listRuns: tail recent runs

import { readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import Database from "better-sqlite3";

import { getDb } from "../db.js";
import { searchHybrid, search as ftsSearch, searchSemantic } from "../search.js";
import { computePerQuery, mean, type PerQueryMetrics } from "./eval-metrics.js";

export type EvalVariant = "hybrid" | "fts" | "vector" | "rrf-only" | "custom" | "rerank";

export interface GoldenQuery {
  id?: number;
  query: string;
  expected_chunk_ids: number[];
  difficulty?: "easy" | "medium" | "hard";
  category?: string;
  added_by?: string;
  notes?: string;
}

export interface EvalRunRow {
  id: number;
  variant: EvalVariant;
  ran_at: string;
  git_sha: string | null;
  schema_version: number | null;
  query_count: number;
  total_duration_ms: number | null;
  notes: string | null;
}

export interface EvalAggregate {
  ndcg_at_10: number;
  mrr: number;
  recall_at_10: number;
  precision_at_5: number;
}

const REPORTS_DIR = process.env.NOX_EVAL_REPORTS_DIR ||
  join(process.env.OPENCLAW_WORKSPACE || "/root/.openclaw/workspace", "tools/nox-mem/reports/eval");

export function getGitSha(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function getSchemaVersion(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : 0;
}

/**
 * Import golden queries from JSONL file. INSERT OR IGNORE on UNIQUE(query).
 * Returns { imported, skipped, total_in_db }.
 */
export function importGolden(file: string, addedBy: string = "human"): { imported: number; skipped: number; total: number } {
  const db = getDb();
  const raw = readFileSync(file, "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO eval_queries
      (query, expected_chunk_ids, difficulty, category, added_by, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  let imported = 0;
  let skipped = 0;
  for (const line of lines) {
    let obj: GoldenQuery;
    try {
      obj = JSON.parse(line) as GoldenQuery;
    } catch (e: any) {
      console.error(`[eval] skip malformed line: ${e.message}`);
      skipped++;
      continue;
    }
    if (!obj.query || !Array.isArray(obj.expected_chunk_ids)) {
      console.error(`[eval] skip invalid shape: ${JSON.stringify(obj).slice(0, 80)}`);
      skipped++;
      continue;
    }
    const result = stmt.run(
      obj.query,
      JSON.stringify(obj.expected_chunk_ids),
      obj.difficulty || "medium",
      obj.category || null,
      obj.added_by || addedBy,
      obj.notes || null
    );
    if (result.changes === 1) imported++;
    else skipped++;
  }
  const total = (db.prepare("SELECT COUNT(*) AS c FROM eval_queries").get() as { c: number }).c;
  return { imported, skipped, total };
}

/**
 * List all golden queries in DB.
 */
export function listGolden(): GoldenQuery[] {
  const db = getDb();
  const rows = db.prepare("SELECT id, query, expected_chunk_ids, difficulty, category, notes FROM eval_queries ORDER BY id").all() as any[];
  return rows.map((r) => ({
    id: r.id,
    query: r.query,
    expected_chunk_ids: JSON.parse(r.expected_chunk_ids),
    difficulty: r.difficulty,
    category: r.category,
    notes: r.notes,
  }));
}

/**
 * Execute search variant for a query, returning ordered chunk IDs + scores.
 * Truncates to top 10 (eval cutoff).
 */
async function runVariant(query: string, variant: EvalVariant): Promise<{ ids: number[]; scores: number[] }> {
  const limit = 10;
  switch (variant) {
    case "hybrid":
    case "rrf-only":
    case "custom": {
      const results = await searchHybrid(query, limit);
      return {
        ids: results.map((r) => r.id ?? -1).filter((x) => x >= 0),
        scores: results.map((r) => r.score),
      };
    }
    case "rerank": {
      // D01 (2026-05-07): força reranker active TEMPORARIAMENTE pra esta run.
      // Permite comparação 3-run hybrid vs hybrid+rerank na mesma corrida sem
      // mudar env permanente. Restaura mode anterior pós-call.
      const prev = process.env.NOX_RERANKER_MODE;
      process.env.NOX_RERANKER_MODE = "active";
      try {
        const results = await searchHybrid(query, limit);
        return {
          ids: results.map((r) => r.id ?? -1).filter((x) => x >= 0),
          scores: results.map((r) => r.score),
        };
      } finally {
        if (prev === undefined) delete process.env.NOX_RERANKER_MODE;
        else process.env.NOX_RERANKER_MODE = prev;
      }
    }
    case "fts": {
      const results = ftsSearch(query, limit);
      return {
        ids: results.map((r) => r.id ?? -1).filter((x) => x >= 0),
        scores: results.map((r) => r.score),
      };
    }
    case "vector": {
      const results = await searchSemantic(query, limit);
      return {
        ids: results.map((r) => r.id ?? -1).filter((x) => x >= 0),
        scores: results.map((r) => r.score),
      };
    }
    default:
      throw new Error(`unknown variant: ${variant}`);
  }
}

export interface RunOptions {
  variant?: EvalVariant;
  notes?: string;
  gitSha?: string;
  reportsDir?: string;
}

export interface RunSummary {
  run_id: number;
  variant: EvalVariant;
  ran_at: string;
  git_sha: string | null;
  query_count: number;
  total_duration_ms: number;
  aggregate: EvalAggregate;
  byDifficulty: Record<string, EvalAggregate & { n: number }>;
  byCategory: Record<string, EvalAggregate & { n: number }>;
  jsonlPath: string;
  prevRunId: number | null;
  delta: EvalAggregate | null;
}

/**
 * Run eval over all golden queries with given variant.
 * Persists eval_runs + eval_results, exports JSONL, returns summary.
 */
export async function runEval(opts: RunOptions = {}): Promise<RunSummary> {
  const variant: EvalVariant = opts.variant || "hybrid";
  const db = getDb();
  const golden = listGolden();
  if (golden.length === 0) {
    throw new Error("no golden queries — run `eval golden import <file>` first");
  }

  const t0 = Date.now();
  const perQuery: Array<{ q: GoldenQuery; m: PerQueryMetrics; ids: number[]; scores: number[]; duration_ms: number }> = [];
  for (const q of golden) {
    const tq = Date.now();
    const { ids, scores } = await runVariant(q.query, variant);
    const m = computePerQuery(ids, new Set(q.expected_chunk_ids));
    perQuery.push({ q, m, ids, scores, duration_ms: Date.now() - tq });
  }
  const totalDurationMs = Date.now() - t0;

  const aggregate: EvalAggregate = {
    ndcg_at_10: mean(perQuery.map((p) => p.m.ndcg_at_10)),
    mrr: mean(perQuery.map((p) => p.m.mrr)),
    recall_at_10: mean(perQuery.map((p) => p.m.recall_at_10)),
    precision_at_5: mean(perQuery.map((p) => p.m.precision_at_5)),
  };

  // INSERT eval_run + eval_results (transaction)
  const gitSha = opts.gitSha || getGitSha();
  const schemaV = getSchemaVersion(db);
  const insertRun = db.prepare(`
    INSERT INTO eval_runs (variant, git_sha, schema_version, query_count, total_duration_ms, notes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertResult = db.prepare(`
    INSERT INTO eval_results
      (run_id, query_id, retrieved_chunk_ids, retrieved_scores, ndcg_at_10, mrr, recall_at_10, precision_at_5, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    const r = insertRun.run(variant, gitSha, schemaV, golden.length, totalDurationMs, opts.notes || null);
    const runId = Number(r.lastInsertRowid);
    for (const p of perQuery) {
      insertResult.run(
        runId,
        p.q.id!,
        JSON.stringify(p.ids),
        JSON.stringify(p.scores),
        p.m.ndcg_at_10,
        p.m.mrr,
        p.m.recall_at_10,
        p.m.precision_at_5,
        p.duration_ms
      );
    }
    return runId;
  });
  const runId = tx();
  const ranAt = (db.prepare("SELECT ran_at FROM eval_runs WHERE id=?").get(runId) as { ran_at: string }).ran_at;

  // By difficulty / category aggregates
  const byDifficulty: Record<string, any> = {};
  const byCategory: Record<string, any> = {};
  for (const p of perQuery) {
    const d = p.q.difficulty || "medium";
    if (!byDifficulty[d]) byDifficulty[d] = { ndcgs: [], mrrs: [], recalls: [], precs: [] };
    byDifficulty[d].ndcgs.push(p.m.ndcg_at_10);
    byDifficulty[d].mrrs.push(p.m.mrr);
    byDifficulty[d].recalls.push(p.m.recall_at_10);
    byDifficulty[d].precs.push(p.m.precision_at_5);

    const c = p.q.category || "uncategorized";
    if (!byCategory[c]) byCategory[c] = { ndcgs: [], mrrs: [], recalls: [], precs: [] };
    byCategory[c].ndcgs.push(p.m.ndcg_at_10);
    byCategory[c].mrrs.push(p.m.mrr);
    byCategory[c].recalls.push(p.m.recall_at_10);
    byCategory[c].precs.push(p.m.precision_at_5);
  }
  const collapseAgg = (raw: any): EvalAggregate & { n: number } => ({
    ndcg_at_10: mean(raw.ndcgs),
    mrr: mean(raw.mrrs),
    recall_at_10: mean(raw.recalls),
    precision_at_5: mean(raw.precs),
    n: raw.ndcgs.length,
  });
  const byDifficultyOut: Record<string, EvalAggregate & { n: number }> = {};
  for (const k of Object.keys(byDifficulty)) byDifficultyOut[k] = collapseAgg(byDifficulty[k]);
  const byCategoryOut: Record<string, EvalAggregate & { n: number }> = {};
  for (const k of Object.keys(byCategory)) byCategoryOut[k] = collapseAgg(byCategory[k]);

  // Delta vs previous run of SAME variant
  const prev = db.prepare(`
    SELECT id FROM eval_runs WHERE variant=? AND id < ? ORDER BY id DESC LIMIT 1
  `).get(variant, runId) as { id: number } | undefined;
  let delta: EvalAggregate | null = null;
  if (prev) {
    const prevAgg = aggregateForRun(prev.id);
    if (prevAgg) {
      delta = {
        ndcg_at_10: aggregate.ndcg_at_10 - prevAgg.ndcg_at_10,
        mrr: aggregate.mrr - prevAgg.mrr,
        recall_at_10: aggregate.recall_at_10 - prevAgg.recall_at_10,
        precision_at_5: aggregate.precision_at_5 - prevAgg.precision_at_5,
      };
    }
  }

  // JSONL export
  const reportsDir = opts.reportsDir || REPORTS_DIR;
  if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true, mode: 0o755 });
  const jsonlPath = join(reportsDir, `${runId}-${variant}-${ranAt.replace(/[:.]/g, "-")}.jsonl`);
  const jsonlLines: string[] = [];
  jsonlLines.push(JSON.stringify({
    type: "run_meta", run_id: runId, variant, ran_at: ranAt, git_sha: gitSha,
    schema_version: schemaV, query_count: golden.length, total_duration_ms: totalDurationMs,
    notes: opts.notes || null, aggregate,
  }));
  for (const p of perQuery) {
    jsonlLines.push(JSON.stringify({
      type: "result", run_id: runId, query_id: p.q.id, query: p.q.query,
      difficulty: p.q.difficulty, category: p.q.category,
      retrieved_chunk_ids: p.ids, retrieved_scores: p.scores,
      expected_chunk_ids: p.q.expected_chunk_ids,
      metrics: p.m, duration_ms: p.duration_ms,
    }));
  }
  writeFileSync(jsonlPath, jsonlLines.join("\n") + "\n", { mode: 0o644 });

  return {
    run_id: runId,
    variant,
    ran_at: ranAt,
    git_sha: gitSha,
    query_count: golden.length,
    total_duration_ms: totalDurationMs,
    aggregate,
    byDifficulty: byDifficultyOut,
    byCategory: byCategoryOut,
    jsonlPath,
    prevRunId: prev?.id ?? null,
    delta,
  };
}

/**
 * Compute aggregate for a given run from eval_results table.
 */
export function aggregateForRun(runId: number): EvalAggregate | null {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ndcg_at_10, mrr, recall_at_10, precision_at_5 FROM eval_results WHERE run_id=?
  `).all(runId) as Array<{ ndcg_at_10: number; mrr: number; recall_at_10: number; precision_at_5: number }>;
  if (rows.length === 0) return null;
  return {
    ndcg_at_10: mean(rows.map((r) => r.ndcg_at_10)),
    mrr: mean(rows.map((r) => r.mrr)),
    recall_at_10: mean(rows.map((r) => r.recall_at_10)),
    precision_at_5: mean(rows.map((r) => r.precision_at_5)),
  };
}

/**
 * List recent runs, optionally filtered by variant.
 */
export function listRuns(variant?: EvalVariant, limit: number = 10): EvalRunRow[] {
  const db = getDb();
  const sql = variant
    ? "SELECT * FROM eval_runs WHERE variant=? ORDER BY id DESC LIMIT ?"
    : "SELECT * FROM eval_runs ORDER BY id DESC LIMIT ?";
  return (variant ? db.prepare(sql).all(variant, limit) : db.prepare(sql).all(limit)) as EvalRunRow[];
}

export interface CompareRow {
  query_id: number;
  query: string;
  a_ndcg: number;
  b_ndcg: number;
  delta: number;
}

/**
 * Compare two runs query-by-query. Returns sorted by delta (regressions first).
 */
export function compareRuns(runIdA: number, runIdB: number): { regressions: CompareRow[]; improvements: CompareRow[]; aggregate_a: EvalAggregate | null; aggregate_b: EvalAggregate | null } {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      q.id AS query_id, q.query AS query,
      a.ndcg_at_10 AS a_ndcg, b.ndcg_at_10 AS b_ndcg
    FROM eval_queries q
    JOIN eval_results a ON a.query_id = q.id AND a.run_id = ?
    JOIN eval_results b ON b.query_id = q.id AND b.run_id = ?
  `).all(runIdA, runIdB) as Array<{ query_id: number; query: string; a_ndcg: number; b_ndcg: number }>;
  const all: CompareRow[] = rows.map((r) => ({ ...r, delta: r.b_ndcg - r.a_ndcg }));
  const regressions = all.filter((r) => r.delta < -0.01).sort((x, y) => x.delta - y.delta);
  const improvements = all.filter((r) => r.delta > 0.01).sort((x, y) => y.delta - x.delta);
  return {
    regressions,
    improvements,
    aggregate_a: aggregateForRun(runIdA),
    aggregate_b: aggregateForRun(runIdB),
  };
}

/**
 * Get latest run per variant for /api/health.evalMetrics surface.
 */
export function getEvalMetricsSnapshot(): {
  lastRun: (EvalRunRow & EvalAggregate) | null;
  byVariant: Record<string, { ndcg_at_10: number; ran_at: string; run_id: number }>;
} {
  const db = getDb();
  const lastRow = db.prepare("SELECT * FROM eval_runs ORDER BY id DESC LIMIT 1").get() as EvalRunRow | undefined;
  let lastRun: (EvalRunRow & EvalAggregate) | null = null;
  if (lastRow) {
    const agg = aggregateForRun(lastRow.id);
    if (agg) lastRun = { ...lastRow, ...agg };
  }
  const variants = db.prepare("SELECT DISTINCT variant FROM eval_runs").all() as Array<{ variant: string }>;
  const byVariant: Record<string, { ndcg_at_10: number; ran_at: string; run_id: number }> = {};
  for (const { variant } of variants) {
    const row = db.prepare("SELECT id, ran_at FROM eval_runs WHERE variant=? ORDER BY id DESC LIMIT 1").get(variant) as { id: number; ran_at: string } | undefined;
    if (!row) continue;
    const agg = aggregateForRun(row.id);
    if (!agg) continue;
    byVariant[variant] = { ndcg_at_10: agg.ndcg_at_10, ran_at: row.ran_at, run_id: row.id };
  }
  return { lastRun, byVariant };
}
