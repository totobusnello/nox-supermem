/**
 * metrics.ts — Observability: track daily metrics for nox-mem
 */
import { getDb } from "./db.js";

export function ensureMetricsTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      date TEXT PRIMARY KEY,
      chunks_added INTEGER DEFAULT 0,
      chunks_compacted INTEGER DEFAULT 0,
      consolidations_ok INTEGER DEFAULT 0,
      consolidations_fail INTEGER DEFAULT 0,
      searches_fts INTEGER DEFAULT 0,
      searches_semantic INTEGER DEFAULT 0,
      dedup_blocked INTEGER DEFAULT 0,
      noise_filtered INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

export function incrementMetric(metric: string, amount: number = 1): void {
  const db = getDb();
  const today = new Date().toISOString().split("T")[0];
  ensureMetricsTable();

  db.prepare(`
    INSERT INTO daily_metrics (date, ${metric}) VALUES (?, ?)
    ON CONFLICT(date) DO UPDATE SET ${metric} = ${metric} + ?, updated_at = datetime('now')
  `).run(today, amount, amount);
}

export function getMetrics(days: number = 7): string {
  const db = getDb();
  ensureMetricsTable();

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const rows = db.prepare(`
    SELECT * FROM daily_metrics WHERE date >= ? ORDER BY date DESC
  `).all(cutoff) as Array<Record<string, unknown>>;

  if (rows.length === 0) return "No metrics recorded yet.";

  const lines = ["=== nox-mem Metrics (last " + days + " days) ===\n"];
  lines.push("Date       | +Chunks | Compact | OK | Fail | FTS | Semantic | Dedup | Noise");
  lines.push("-----------|---------|---------|----|----- |-----|----------|-------|------");

  for (const r of rows) {
    lines.push(
      `${r.date} | ${String(r.chunks_added).padStart(7)} | ${String(r.chunks_compacted).padStart(7)} | ${String(r.consolidations_ok).padStart(2)} | ${String(r.consolidations_fail).padStart(4)} | ${String(r.searches_fts).padStart(3)} | ${String(r.searches_semantic).padStart(8)} | ${String(r.dedup_blocked).padStart(5)} | ${String(r.noise_filtered ?? 0).padStart(5)}`
    );
  }

  // Totals
  const totals = rows.reduce((acc, r) => ({
    chunks_added: (acc.chunks_added as number) + (r.chunks_added as number || 0),
    chunks_compacted: (acc.chunks_compacted as number) + (r.chunks_compacted as number || 0),
    consolidations_ok: (acc.consolidations_ok as number) + (r.consolidations_ok as number || 0),
    consolidations_fail: (acc.consolidations_fail as number) + (r.consolidations_fail as number || 0),
    searches_fts: (acc.searches_fts as number) + (r.searches_fts as number || 0),
    searches_semantic: (acc.searches_semantic as number) + (r.searches_semantic as number || 0),
    dedup_blocked: (acc.dedup_blocked as number) + (r.dedup_blocked as number || 0),
    noise_filtered: (acc.noise_filtered as number) + ((r.noise_filtered as number) || 0),
  }), { chunks_added: 0, chunks_compacted: 0, consolidations_ok: 0, consolidations_fail: 0, searches_fts: 0, searches_semantic: 0, dedup_blocked: 0, noise_filtered: 0 });

  lines.push(`TOTAL      | ${String(totals.chunks_added).padStart(7)} | ${String(totals.chunks_compacted).padStart(7)} | ${String(totals.consolidations_ok).padStart(2)} | ${String(totals.consolidations_fail).padStart(4)} | ${String(totals.searches_fts).padStart(3)} | ${String(totals.searches_semantic).padStart(8)} | ${String(totals.dedup_blocked).padStart(5)} | ${String(totals.noise_filtered).padStart(5)}`);

  return lines.join("\n");
}
