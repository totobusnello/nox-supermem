// F15b SEH (2026-05-03): Self-Evolving Hooks proper — telemetry F15a → threshold detector → action proposals.
// Não auto-applica patches (FP risk em config crítica) — gera report acionável que humano valida.

import { getDb } from "./db.js";

export type ProposalKind =
  | 'perf_regression'    // p95 dobrou WoW
  | 'error_spike'        // success_rate caiu >10pp WoW
  | 'dormant_command'    // sem usar há 30+ days
  | 'capacity_warning'   // total_runs cresceu >3× (potential overuse/loop)
  | 'first_use'          // novo comando aparecendo (informational)
  | 'recovery'           // success_rate subiu >10pp WoW (informational positive)
;

export interface SehProposal {
  kind: ProposalKind;
  command: string;
  severity: 'info' | 'warn' | 'alert';
  metric: string;
  current: number | string;
  baseline: number | string;
  delta_pct?: number;
  recommended_action: string;
  config_patch?: { env_var: string; current_value: string | null; suggested_value: string };
}

export interface SehReport {
  window_current_days: number;
  window_baseline_days: number;
  total_proposals: number;
  by_severity: Record<string, number>;
  by_kind: Record<string, number>;
  proposals: SehProposal[];
  duration_ms: number;
}

interface CommandStats {
  command: string;
  total_runs: number;
  success_runs: number;
  failed_runs: number;
  avg_ms: number;
  p95_ms: number;
  last_ts: string | null;
}

function statsForWindow(windowDays: number, offsetDays = 0): Map<string, CommandStats> {
  const db = getDb();
  // CODE-FIX HIGH (audit pós-Sessão B): boundary symmetry — `>` em ambos lados (half-open exclusive→exclusive)
  // evita double-count de timestamps no exato boundary entre current e baseline windows.
  const rows = db.prepare(
    `SELECT command, status, duration_ms, ts FROM cli_telemetry
     WHERE ts > datetime('now', '-' || ? || ' days')
       AND ts < datetime('now', '-' || ? || ' days')`
  ).all(offsetDays + windowDays, offsetDays) as Array<{ command: string; status: string; duration_ms: number; ts: string }>;

  const map = new Map<string, Array<typeof rows[0]>>();
  for (const r of rows) {
    if (!map.has(r.command)) map.set(r.command, []);
    map.get(r.command)!.push(r);
  }

  const stats = new Map<string, CommandStats>();
  for (const [cmd, runs] of map) {
    const total = runs.length;
    const success = runs.filter((r) => r.status === 'success').length;
    const sortedDur = runs.map((r) => r.duration_ms).sort((a, b) => a - b);
    const avg = Math.round(sortedDur.reduce((s, d) => s + d, 0) / total * 10) / 10;
    // CODE-FIX HIGH: nearest-rank ceil + guard pra small N — evita falso-positivo perf_regression em runs<20
    // Pra n<20, p95 não é estatisticamente significativo; usar max() como proxy honesto.
    const p95Idx = total < 20
      ? total - 1  // = max(), honest signal pra small samples
      : Math.max(0, Math.ceil(total * 0.95) - 1);
    const lastTs = runs.reduce((latest, r) => r.ts > latest ? r.ts : latest, "");
    stats.set(cmd, {
      command: cmd,
      total_runs: total,
      success_runs: success,
      failed_runs: total - success,
      avg_ms: avg,
      p95_ms: sortedDur[p95Idx] ?? avg,
      last_ts: lastTs || null,
    });
  }
  return stats;
}

function dormantCommands(thresholdDays = 30): SehProposal[] {
  const db = getDb();
  // CODE-FIX MEDIUM: filter total_runs >= 3 pra evitar flood de one-off experiments
  const rows = db.prepare(
    `SELECT command, MAX(ts) AS last_ts, COUNT(*) AS total_runs,
            ROUND(julianday('now') - julianday(MAX(ts)), 0) AS days_idle
     FROM cli_telemetry GROUP BY command
     HAVING days_idle >= ? AND total_runs >= 3
     ORDER BY days_idle DESC`
  ).all(thresholdDays) as Array<{ command: string; last_ts: string; total_runs: number; days_idle: number }>;
  return rows.map((r) => ({
    kind: 'dormant_command' as const,
    command: r.command,
    severity: r.days_idle >= 60 ? 'warn' : 'info',
    metric: 'days_since_last_run',
    current: r.days_idle,
    baseline: thresholdDays,
    recommended_action: r.days_idle >= 60
      ? `Considere depreciação ou refator. ${r.total_runs} runs históricos, último ${r.days_idle}d atrás.`
      : `Monitorar — sem uso há ${r.days_idle}d. Pode ser sazonal.`,
  }));
}

const PERF_PATCH_HINTS: Record<string, { env: string; suggest: (current: number) => string }> = {
  'reflect': { env: 'NOX_REFLECT_TIMEOUT_MS', suggest: (p95) => String(Math.ceil(p95 * 1.5 / 1000) * 1000) },
  'kg-extract': { env: 'NOX_KG_EXTRACT_BATCH_LIMIT', suggest: () => '20' },
  'consolidate-merge': { env: 'NOX_CONSOLIDATE_MAX_PER_TYPE', suggest: () => '500' },
  'api-impact': { env: 'NOX_API_IMPACT_MAX_FILES', suggest: () => '5000' },
};

export function detectAndPropose(opts: { windowDays?: number; minRuns?: number; dormantDays?: number } = {}): SehReport {
  const start = Date.now();
  const windowDays = opts.windowDays ?? 7;
  const minRuns = opts.minRuns ?? 3;
  const dormantDays = opts.dormantDays ?? 30;

  const current = statsForWindow(windowDays, 0);
  const baseline = statsForWindow(windowDays, windowDays); // same length, prior period

  const proposals: SehProposal[] = [];

  for (const [cmd, cur] of current) {
    if (cur.total_runs < minRuns) continue;
    const base = baseline.get(cmd);

    if (!base) {
      // First-use: aparece em current, não em baseline
      proposals.push({
        kind: 'first_use',
        command: cmd,
        severity: 'info',
        metric: 'introduced',
        current: cur.total_runs,
        baseline: 0,
        recommended_action: `Novo comando: ${cur.total_runs} runs em ${windowDays}d. Monitorar p95 e success rate.`,
      });
      continue;
    }

    // Perf regression: p95 dobrou
    if (base.p95_ms > 0 && cur.p95_ms >= base.p95_ms * 2) {
      const deltaPct = Math.round(((cur.p95_ms - base.p95_ms) / base.p95_ms) * 100);
      const hint = PERF_PATCH_HINTS[cmd];
      proposals.push({
        kind: 'perf_regression',
        command: cmd,
        severity: cur.p95_ms >= base.p95_ms * 4 ? 'alert' : 'warn',
        metric: 'p95_ms',
        current: cur.p95_ms,
        baseline: base.p95_ms,
        delta_pct: deltaPct,
        recommended_action: `p95 saltou ${deltaPct}% WoW (${base.p95_ms}ms → ${cur.p95_ms}ms). Investigar profile / quota / rede.`,
        config_patch: hint ? {
          env_var: hint.env,
          current_value: process.env[hint.env] || null,
          suggested_value: hint.suggest(cur.p95_ms),
        } : undefined,
      });
    }

    // Error spike: success_rate caiu >10pp
    const curSr = cur.total_runs === 0 ? 100 : (cur.success_runs / cur.total_runs) * 100;
    const baseSr = base.total_runs === 0 ? 100 : (base.success_runs / base.total_runs) * 100;
    const srDelta = curSr - baseSr;
    if (srDelta <= -10) {
      proposals.push({
        kind: 'error_spike',
        command: cmd,
        severity: srDelta <= -25 ? 'alert' : 'warn',
        metric: 'success_rate_pct',
        current: Math.round(curSr * 10) / 10,
        baseline: Math.round(baseSr * 10) / 10,
        delta_pct: Math.round(srDelta * 10) / 10,
        recommended_action: `Success rate caiu ${Math.abs(Math.round(srDelta))}pp WoW (${baseSr.toFixed(1)}% → ${curSr.toFixed(1)}%). Verificar logs últimas falhas.`,
      });
    } else if (srDelta >= 10) {
      proposals.push({
        kind: 'recovery',
        command: cmd,
        severity: 'info',
        metric: 'success_rate_pct',
        current: Math.round(curSr * 10) / 10,
        baseline: Math.round(baseSr * 10) / 10,
        delta_pct: Math.round(srDelta * 10) / 10,
        recommended_action: `Success rate recuperou ${Math.round(srDelta)}pp WoW. Validar root cause e documentar lição.`,
      });
    }

    // Capacity warning: usage 3× WoW
    if (base.total_runs > 0 && cur.total_runs >= base.total_runs * 3) {
      const deltaPct = Math.round(((cur.total_runs - base.total_runs) / base.total_runs) * 100);
      proposals.push({
        kind: 'capacity_warning',
        command: cmd,
        severity: cur.total_runs >= base.total_runs * 10 ? 'alert' : 'warn',
        metric: 'total_runs',
        current: cur.total_runs,
        baseline: base.total_runs,
        delta_pct: deltaPct,
        recommended_action: `Uso saltou ${deltaPct}% WoW (${base.total_runs} → ${cur.total_runs}). Verificar se é loop runaway, novo automation ou crescimento real.`,
      });
    }
  }

  // Add dormant detection
  proposals.push(...dormantCommands(dormantDays));

  // Aggregate
  const bySeverity: Record<string, number> = { info: 0, warn: 0, alert: 0 };
  const byKind: Record<string, number> = {};
  for (const p of proposals) {
    bySeverity[p.severity]++;
    byKind[p.kind] = (byKind[p.kind] || 0) + 1;
  }

  // Sort: alert > warn > info, then by command
  const sevOrder: Record<string, number> = { alert: 0, warn: 1, info: 2 };
  proposals.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || a.command.localeCompare(b.command));

  return {
    window_current_days: windowDays,
    window_baseline_days: windowDays,
    total_proposals: proposals.length,
    by_severity: bySeverity,
    by_kind: byKind,
    proposals,
    duration_ms: Date.now() - start,
  };
}

export function formatSehReport(r: SehReport, mode: 'json' | 'text' = 'text'): string {
  if (mode === 'json') return JSON.stringify(r, null, 2);
  const lines: string[] = [];
  lines.push(`## SEH Report (F15b — Self-Evolving Hooks proper)`);
  lines.push(`Comparing last ${r.window_current_days}d vs prior ${r.window_baseline_days}d. Proposals: ${r.total_proposals}. Computed in ${r.duration_ms}ms.`);
  lines.push(`By severity: alert=${r.by_severity.alert} warn=${r.by_severity.warn} info=${r.by_severity.info}`);
  lines.push(`By kind: ${Object.entries(r.by_kind).map(([k, n]) => `${k}=${n}`).join(", ")}`);
  if (r.total_proposals === 0) {
    lines.push(`\n✅ Nenhuma anomalia detectada. Sistema estável.`);
    return lines.join("\n");
  }
  for (const p of r.proposals) {
    const marker = p.severity === 'alert' ? '🔴' : p.severity === 'warn' ? '🟡' : 'ℹ️';
    const deltaStr = p.delta_pct !== undefined ? ` (Δ ${p.delta_pct >= 0 ? '+' : ''}${p.delta_pct}%)` : '';
    lines.push(`\n${marker} [${p.kind}] ${p.command}`);
    lines.push(`   ${p.metric}: ${p.baseline} → ${p.current}${deltaStr}`);
    lines.push(`   ▶ ${p.recommended_action}`);
    if (p.config_patch) {
      lines.push(`   📋 Config patch sugerido: ${p.config_patch.env_var}=${p.config_patch.suggested_value} (current: ${p.config_patch.current_value || '(unset)'})`);
    }
  }
  lines.push(`\n📌 SEH não auto-aplica patches (FP risk). Validar manualmente antes de exportar config_patch sugerido.`);
  return lines.join("\n");
}
