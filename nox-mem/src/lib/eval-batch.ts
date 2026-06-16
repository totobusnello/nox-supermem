// R02 replication (2026-05-03): N-run batch para mean ± std variance estimate.
// Wraps runEval N vezes + agrega métricas por iteração.

import { runEval, type EvalVariant, type RunSummary } from "./eval.js";

export interface BatchMetricStats {
  mean: number;
  std: number;
  min: number;
  max: number;
  values: number[];
}

export interface BatchSummary {
  variant: EvalVariant;
  runs: number;
  query_count: number;
  total_duration_ms: number;
  individual_runs: Array<{ run_id: number; nDCG: number; MRR: number; Recall: number; Precision: number; duration_ms: number }>;
  stats: {
    nDCG: BatchMetricStats;
    MRR: BatchMetricStats;
    Recall: BatchMetricStats;
    Precision: BatchMetricStats;
  };
}

function statsFor(values: number[]): BatchMetricStats {
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  // CODE-FIX MEDIUM: Bessel's correction (n-1) for sample variance — paper R02 reports uncertainty
  // from sample, not population. Falls back to population variance only if n=1 (degenerate).
  const denom = n > 1 ? n - 1 : 1;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / denom;
  const std = Math.sqrt(variance);
  // CODE-FIX MEDIUM: reduce-based min/max evita stack blowup com large N (Math.min/max(...values) crash ~100k)
  const min = values.reduce((a, b) => (a < b ? a : b));
  const max = values.reduce((a, b) => (a > b ? a : b));
  return {
    mean: Math.round(mean * 10000) / 10000,
    std: Math.round(std * 10000) / 10000,
    min: Math.round(min * 10000) / 10000,
    max: Math.round(max * 10000) / 10000,
    values: values.map((v) => Math.round(v * 10000) / 10000),
  };
}

export async function runBatch(opts: { variant?: EvalVariant; runs?: number; notes?: string }): Promise<BatchSummary> {
  const variant: EvalVariant = opts.variant || "hybrid";
  const runs = opts.runs ?? 3;
  if (runs < 2) throw new Error("--runs must be ≥ 2 for variance estimate");

  const t0 = Date.now();
  const summaries: RunSummary[] = [];
  const ndcgs: number[] = [];
  const mrrs: number[] = [];
  const recalls: number[] = [];
  const precs: number[] = [];
  const errors: Array<{ iter: number; error: string }> = [];

  for (let i = 0; i < runs; i++) {
    // CODE-FIX MEDIUM: try/catch per iteration — não perde N-1 successful runs em 1 falha
    try {
      const s = await runEval({
        variant,
        notes: `${opts.notes || 'batch'} (iter ${i + 1}/${runs})`,
      });
      summaries.push(s);
      ndcgs.push(s.aggregate.ndcg_at_10);
      mrrs.push(s.aggregate.mrr);
      recalls.push(s.aggregate.recall_at_10);
      precs.push(s.aggregate.precision_at_5);
    } catch (e: any) {
      errors.push({ iter: i + 1, error: e.message?.substring(0, 200) || String(e) });
      console.error(`[eval-batch] iter ${i + 1}/${runs} failed: ${errors[errors.length - 1].error}`);
    }
  }

  if (summaries.length < 2) {
    throw new Error(`eval-batch: ${summaries.length}/${runs} runs succeeded — need ≥2 for variance estimate. Errors: ${errors.map((e) => `iter${e.iter}=${e.error}`).join("; ")}`);
  }

  // CODE-FIX MEDIUM: assert query_count uniformity (golden set may mutate mid-batch via concurrent ingest)
  const qCounts = summaries.map((s) => s.query_count);
  const qCountsUniform = qCounts.every((c) => c === qCounts[0]);
  if (!qCountsUniform) {
    console.warn(`[eval-batch] WARN: query_count varies across runs ${JSON.stringify(qCounts)} — golden set mutated mid-batch?`);
  }

  return {
    variant,
    runs,
    query_count: qCountsUniform ? summaries[0].query_count : Math.max(...qCounts),
    total_duration_ms: Date.now() - t0,
    individual_runs: summaries.map((s) => ({
      run_id: s.run_id,
      nDCG: s.aggregate.ndcg_at_10,
      MRR: s.aggregate.mrr,
      Recall: s.aggregate.recall_at_10,
      Precision: s.aggregate.precision_at_5,
      duration_ms: s.total_duration_ms,
    })),
    stats: {
      nDCG: statsFor(ndcgs),
      MRR: statsFor(mrrs),
      Recall: statsFor(recalls),
      Precision: statsFor(precs),
    },
  };
}

export function formatBatchSummary(b: BatchSummary, mode: 'json' | 'text' = 'text'): string {
  if (mode === 'json') return JSON.stringify(b, null, 2);
  const lines: string[] = [];
  lines.push(`## Eval Batch (variant=${b.variant}) — ${b.runs} runs over ${b.query_count} queries`);
  lines.push(`Total duration: ${(b.total_duration_ms / 1000).toFixed(1)}s`);
  lines.push(``);
  lines.push(`| Run | nDCG@10 | MRR | Recall@10 | Prec@5 | Duration |`);
  lines.push(`|-----|---------|-----|-----------|--------|----------|`);
  for (const r of b.individual_runs) {
    lines.push(`| #${r.run_id} | ${r.nDCG.toFixed(4)} | ${r.MRR.toFixed(4)} | ${r.Recall.toFixed(4)} | ${r.Precision.toFixed(4)} | ${(r.duration_ms / 1000).toFixed(1)}s |`);
  }
  lines.push(``);
  lines.push(`### Aggregate (mean ± std)`);
  lines.push(`| Metric | Mean | Std | Min | Max | Values |`);
  lines.push(`|--------|------|-----|-----|-----|--------|`);
  for (const [name, s] of Object.entries(b.stats)) {
    lines.push(`| ${name.padEnd(8)} | ${s.mean.toFixed(4)} | ±${s.std.toFixed(4)} | ${s.min.toFixed(4)} | ${s.max.toFixed(4)} | ${s.values.map(v => v.toFixed(3)).join(", ")} |`);
  }
  return lines.join("\n");
}
