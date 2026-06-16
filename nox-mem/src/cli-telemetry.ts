// F15 SEH (2026-05-03): self-evolving hooks via CLI telemetry.
// Cada subcomando registra stats; insights derivados detectam regressions e features dormentes.

import { getDb } from "./db.js";

export function ensureCliTelemetry(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS cli_telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command TEXT NOT NULL,
      args_summary TEXT,
      status TEXT NOT NULL CHECK(status IN ('success','failed','timeout')),
      duration_ms INTEGER NOT NULL,
      ts TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cli_telemetry_cmd ON cli_telemetry(command, ts);
    CREATE INDEX IF NOT EXISTS idx_cli_telemetry_ts ON cli_telemetry(ts);
    -- CODE-FIX HIGH: covering index for p95 single-pass per command
    CREATE INDEX IF NOT EXISTS idx_cli_telemetry_cmd_dur ON cli_telemetry(command, duration_ms);
  `);
}

// SEC-FIX HIGH #5: redaction defensiva — bloqueia secrets em args_summary
const SECRET_PATTERN = /(api[_-]?key|token|password|passwd|secret|bearer|auth)[=\s:]+\S+/gi;
function redactSecrets(s: string | undefined): string | null {
  if (!s) return null;
  return s.replace(SECRET_PATTERN, "$1=***").substring(0, 200); // cap length
}

export function recordCliRun(opts: {
  command: string;
  argsSummary?: string;
  status: 'success' | 'failed' | 'timeout';
  durationMs: number;
}): void {
  if (process.env.NOX_CLI_TELEMETRY === "0") return; // opt-out
  try {
    const db = getDb();
    ensureCliTelemetry();
    // SEC-FIX HIGH #5: SEMPRE redact mesmo que caller passe raw (defesa em camadas)
    const safeArgs = redactSecrets(opts.argsSummary);
    db.prepare(
      "INSERT INTO cli_telemetry (command, args_summary, status, duration_ms) VALUES (?, ?, ?, ?)"
    ).run(opts.command, safeArgs, opts.status, Math.round(opts.durationMs));
  } catch {
    // fail-open: telemetry never blocks user work
  }
}

export interface CliStats {
  command: string;
  total_runs: number;
  success_rate: number;
  failed_runs: number;
  avg_duration_ms: number;
  p95_duration_ms: number;
  last_run_at: string;
  days_since_last_run: number;
}

export interface CliInsights {
  total_runs_7d: number;
  total_runs_alltime: number;
  unique_commands: number;
  by_command: CliStats[];
  slow_commands: CliStats[];
  error_prone_commands: CliStats[];
  dormant_commands: CliStats[];
  recent_errors: Array<{ command: string; ts: string; duration_ms: number }>;
  duration_ms: number;
}

export function computeCliInsights(opts: { windowDays?: number } = {}): CliInsights {
  const start = Date.now();
  const db = getDb();
  ensureCliTelemetry();
  const windowDays = opts.windowDays ?? 7;

  const total7dRow = db.prepare(
    `SELECT COUNT(*) AS c FROM cli_telemetry WHERE ts > datetime('now', '-' || ? || ' days')`
  ).get(windowDays) as { c: number };
  const totalAllRow = db.prepare("SELECT COUNT(*) AS c FROM cli_telemetry").get() as { c: number };
  const uniqueRow = db.prepare("SELECT COUNT(DISTINCT command) AS c FROM cli_telemetry").get() as { c: number };

  // Per-command stats — CODE-FIX HIGH: single-pass com all rows + agrupamento in-memory
  // (era N+1 query: 1 GROUP BY + 1 OFFSET por comando). Agora 1 query covering index.
  // CODE-FIX MEDIUM: julianday em vez de naive Date+Z (timezone-safe)
  const allRuns = db.prepare(
    `SELECT command, status, duration_ms, ts,
            ROUND((julianday('now') - julianday(ts)), 0) AS days_ago
     FROM cli_telemetry ORDER BY command, duration_ms ASC`
  ).all() as Array<{ command: string; status: string; duration_ms: number; ts: string; days_ago: number }>;

  const groupMap = new Map<string, Array<typeof allRuns[0]>>();
  for (const r of allRuns) {
    if (!groupMap.has(r.command)) groupMap.set(r.command, []);
    groupMap.get(r.command)!.push(r);
  }

  const byCommand: CliStats[] = Array.from(groupMap.entries()).map(([cmd, runs]) => {
    const total = runs.length;
    const success = runs.filter((r) => r.status === 'success').length;
    const failed = total - success;
    const avg = Math.round((runs.reduce((s, r) => s + r.duration_ms, 0) / total) * 10) / 10;
    // p95 via in-memory sorted access (runs already sorted asc por SQL ORDER BY)
    const p95Idx = Math.max(0, Math.floor(total * 0.95) - 1);
    const p95 = runs[p95Idx]?.duration_ms ?? avg;
    const lastRun = runs.reduce((latest, r) => r.ts > latest ? r.ts : latest, "");
    const daysSince = Math.min(...runs.map((r) => r.days_ago));
    return {
      command: cmd,
      total_runs: total,
      success_rate: total === 0 ? 0 : Math.round((success / total) * 1000) / 10,
      failed_runs: failed,
      avg_duration_ms: avg,
      p95_duration_ms: p95,
      last_run_at: lastRun,
      days_since_last_run: daysSince,
    };
  }).sort((a, b) => b.total_runs - a.total_runs);

  const slowCommands = [...byCommand]
    .filter((c) => c.p95_duration_ms > 5000) // > 5s
    .sort((a, b) => b.p95_duration_ms - a.p95_duration_ms)
    .slice(0, 5);

  const errorProne = [...byCommand]
    .filter((c) => c.total_runs >= 3 && c.success_rate < 90)
    .sort((a, b) => a.success_rate - b.success_rate)
    .slice(0, 5);

  const dormantCommands = [...byCommand]
    .filter((c) => c.days_since_last_run >= 14)
    .sort((a, b) => b.days_since_last_run - a.days_since_last_run)
    .slice(0, 5);

  const recentErrors = db.prepare(
    `SELECT command, ts, duration_ms FROM cli_telemetry
     WHERE status != 'success' AND ts > datetime('now', '-' || ? || ' days')
     ORDER BY ts DESC LIMIT 10`
  ).all(windowDays) as Array<{ command: string; ts: string; duration_ms: number }>;

  return {
    total_runs_7d: total7dRow.c,
    total_runs_alltime: totalAllRow.c,
    unique_commands: uniqueRow.c,
    by_command: byCommand,
    slow_commands: slowCommands,
    error_prone_commands: errorProne,
    dormant_commands: dormantCommands,
    recent_errors: recentErrors,
    duration_ms: Date.now() - start,
  };
}

export function formatCliInsights(insights: CliInsights, mode: 'json' | 'text' = 'text'): string {
  if (mode === 'json') return JSON.stringify(insights, null, 2);
  const lines: string[] = [];
  lines.push(`## CLI Telemetry Insights (F15 SEH)`);
  lines.push(`Total runs 7d: ${insights.total_runs_7d} | All-time: ${insights.total_runs_alltime} | Unique commands: ${insights.unique_commands} | Computed in ${insights.duration_ms}ms`);
  if (insights.total_runs_alltime === 0) {
    lines.push(`\n(no telemetry data yet — run a few subcomandos pra populate)`);
    return lines.join("\n");
  }
  lines.push(`\n### 📊 Top 10 most-used commands`);
  for (const c of insights.by_command.slice(0, 10)) {
    const sr = c.success_rate.toFixed(1);
    lines.push(`   ${c.command.padEnd(20)} runs=${String(c.total_runs).padStart(5)} sr=${sr}% avg=${c.avg_duration_ms}ms p95=${c.p95_duration_ms}ms last=${c.days_since_last_run}d`);
  }
  if (insights.slow_commands.length > 0) {
    lines.push(`\n### 🐢 Slow commands (p95 > 5s)`);
    for (const c of insights.slow_commands) {
      lines.push(`   ${c.command} — p95=${c.p95_duration_ms}ms (avg=${c.avg_duration_ms}ms, runs=${c.total_runs})`);
    }
  }
  if (insights.error_prone_commands.length > 0) {
    lines.push(`\n### ⚠️ Error-prone commands (success_rate < 90%, runs ≥ 3)`);
    for (const c of insights.error_prone_commands) {
      lines.push(`   ${c.command} — sr=${c.success_rate}% (${c.failed_runs}/${c.total_runs} failed)`);
    }
  }
  if (insights.dormant_commands.length > 0) {
    lines.push(`\n### 💤 Dormant commands (last run > 14d)`);
    for (const c of insights.dormant_commands) {
      lines.push(`   ${c.command} — last=${c.days_since_last_run}d ago (total runs=${c.total_runs})`);
    }
  }
  if (insights.recent_errors.length > 0) {
    lines.push(`\n### 🔴 Recent errors (last ${insights.recent_errors.length})`);
    for (const e of insights.recent_errors) {
      lines.push(`   ${e.ts}  ${e.command}  (${e.duration_ms}ms)`);
    }
  }
  return lines.join("\n");
}
