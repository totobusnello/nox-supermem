import Database from "better-sqlite3";
import { calculateSalience, classifySalience } from "./salience.js";

/**
 * Section distribution for /api/health (Fase 1.7b-c).
 * Counts chunks by section type: frontmatter, compiled, timeline, legacy (NULL).
 */
export function getSectionDistribution(db: Database.Database): {
  compiled: number;
  frontmatter: number;
  timeline: number;
  legacy: number;
} {
  const empty = { compiled: 0, frontmatter: 0, timeline: 0, legacy: 0 };
  try {
    const rows = db.prepare(`
      SELECT COALESCE(section, 'legacy') as section, COUNT(*) as c FROM chunks GROUP BY section
    `).all() as Array<{ section: string; c: number }>;
    const out = { ...empty };
    for (const r of rows) {
      if (r.section === "compiled") out.compiled = r.c;
      else if (r.section === "frontmatter") out.frontmatter = r.c;
      else if (r.section === "timeline") out.timeline = r.c;
      else out.legacy = r.c;
    }
    return out;
  } catch {
    return empty;
  }
}

export type Tier = "core" | "working" | "peripheral";

export const TIER_BOOST: Record<Tier, number> = {
  core: 2.5,
  working: 1.5,
  peripheral: 1.0,
};

// Types that start with high importance → working tier
export const HIGH_IMPORTANCE_TYPES = new Set(["decision", "lesson", "person", "project", "team"]);

export function getInitialTier(chunkType: string): Tier {
  return HIGH_IMPORTANCE_TYPES.has(chunkType) ? "working" : "peripheral";
}

export function getInitialImportance(chunkType: string): number {
  return HIGH_IMPORTANCE_TYPES.has(chunkType) ? 0.8 : 0.5;
}

/**
 * Evaluate and adjust tiers based on access patterns.
 * Rules:
 *   peripheral → working:  access_count >= 3
 *   working → core:        access_count >= 10 (importance condition removed — default is 0.5)
 *   working → peripheral:  access_count = 0 AND age > 30 days (stale)
 *   core → working:        access_count < 5 AND not accessed in 60 days
 */
export function evaluateTiers(db: Database.Database): { promoted: number; demoted: number; archiveCandidates: number } {
  const now = new Date().toISOString();
  let promoted = 0;
  let demoted = 0;

  // peripheral → working
  const r1 = db.prepare(`
    UPDATE chunks SET tier = 'working', updated_at = ?
    WHERE tier = 'peripheral' AND access_count >= 3
  `).run(now);
  promoted += r1.changes;

  // working → core
  // Fase 1.7b-a contract: core chunks are always preserved → clear retention_days
  // on promotion so they never show up as archiveCandidates.
  const r2 = db.prepare(`
    UPDATE chunks SET tier = 'core', retention_days = NULL, updated_at = ?
    WHERE tier = 'working' AND access_count >= 10
  `).run(now);
  promoted += r2.changes;

  // working → peripheral (stale: never accessed, older than 30 days)
  const r3 = db.prepare(`
    UPDATE chunks SET tier = 'peripheral', updated_at = ?
    WHERE tier = 'working'
      AND access_count = 0
      AND created_at < datetime('now', '-30 days')
  `).run(now);
  demoted += r3.changes;

  // core → working (stale: rarely accessed, last access > 60 days ago)
  const r4 = db.prepare(`
    UPDATE chunks SET tier = 'working', updated_at = ?
    WHERE tier = 'core'
      AND access_count < 5
      AND (last_accessed_at IS NULL OR last_accessed_at < datetime('now', '-60 days'))
  `).run(now);
  demoted += r4.changes;

  // Fase 1.7b-a — count archive candidates (expired, non-core)
  // Does NOT delete yet — just reports visibility. Archive action comes in 1.7b-b+.
  const archiveCandidates = countArchiveCandidates(db);

  return { promoted, demoted, archiveCandidates };
}

/**
 * Count chunks eligible for archive:
 *   - have retention_days set (not never-decay)
 *   - created_at + retention_days < now (expired)
 *   - tier != 'core' (core is always preserved, user-declared importance)
 *
 * Read-only. Does not mutate DB.
 */
export function countArchiveCandidates(db: Database.Database): number {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) as c FROM chunks
      WHERE retention_days IS NOT NULL
        AND tier != 'core'
        AND datetime(created_at, '+' || retention_days || ' days') < datetime('now')
    `).get() as { c: number };
    return row.c;
  } catch {
    // retention_days column may not exist yet (pre-v8 schema)
    return 0;
  }
}

/**
 * Salience distribution for /api/health endpoint (shadow-mode read-only).
 * Computes salience in JS (not SQL) since formula has conditional logic.
 *
 * Returns counts bucketed by classifySalience():
 *   promote_candidates: score ≥ 0.7 and tier != 'core'
 *   retain: 0.4 ≤ score < 0.7
 *   review_needed: 0.15 ≤ score < 0.4
 *   archive_candidates: score < 0.15 and tier != 'core'
 */
export function getSalienceDistribution(db: Database.Database): {
  promote_candidates: number;
  retain: number;
  review_needed: number;
  archive_candidates: number;
  mean: number;
  median: number;
} {
  const empty = { promote_candidates: 0, retain: 0, review_needed: 0, archive_candidates: 0, mean: 0, median: 0 };
  try {
    const rows = db.prepare(`
      SELECT id, chunk_type, source_type, tier, pain, importance, retention_days, created_at, last_accessed_at
      FROM chunks
    `).all() as any[];
    if (!rows.length) return empty;

    const now = Date.now();
    const scores: number[] = new Array(rows.length);
    let promote = 0, retain = 0, review = 0, archive = 0;
    let sum = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const s = calculateSalience(r, now);
      scores[i] = s;
      sum += s;
      const action = classifySalience(s);
      const isCore = r.tier === "core";
      if (action === "promote" && !isCore) promote++;
      else if (action === "retain") retain++;
      else if (action === "review") review++;
      else if (action === "archive" && !isCore) archive++;
    }

    scores.sort((a, b) => a - b);
    const mean = sum / scores.length;
    const median = scores[Math.floor(scores.length / 2)];
    return {
      promote_candidates: promote,
      retain,
      review_needed: review,
      archive_candidates: archive,
      mean: Math.round(mean * 10000) / 10000,
      median: Math.round(median * 10000) / 10000,
    };
  } catch {
    return empty;
  }
}

/**
 * Retention distribution summary for /api/health endpoint.
 * Returns counts bucketed by expiration window.
 */
export function getRetentionDistribution(db: Database.Database): {
  never_decay: number;
  expiring_30d: number;
  expiring_90d: number;
  expiring_365d: number;
  expiring_later: number;
  already_expired: number;
} {
  const empty = { never_decay: 0, expiring_30d: 0, expiring_90d: 0, expiring_365d: 0, expiring_later: 0, already_expired: 0 };
  try {
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN retention_days IS NULL THEN 1 ELSE 0 END) as never_decay,
        SUM(CASE
          WHEN retention_days IS NOT NULL
           AND datetime(created_at, '+' || retention_days || ' days') < datetime('now')
          THEN 1 ELSE 0 END) as already_expired,
        SUM(CASE
          WHEN retention_days IS NOT NULL
           AND datetime(created_at, '+' || retention_days || ' days') >= datetime('now')
           AND datetime(created_at, '+' || retention_days || ' days') < datetime('now', '+30 days')
          THEN 1 ELSE 0 END) as expiring_30d,
        SUM(CASE
          WHEN retention_days IS NOT NULL
           AND datetime(created_at, '+' || retention_days || ' days') >= datetime('now', '+30 days')
           AND datetime(created_at, '+' || retention_days || ' days') < datetime('now', '+90 days')
          THEN 1 ELSE 0 END) as expiring_90d,
        SUM(CASE
          WHEN retention_days IS NOT NULL
           AND datetime(created_at, '+' || retention_days || ' days') >= datetime('now', '+90 days')
           AND datetime(created_at, '+' || retention_days || ' days') < datetime('now', '+365 days')
          THEN 1 ELSE 0 END) as expiring_365d,
        SUM(CASE
          WHEN retention_days IS NOT NULL
           AND datetime(created_at, '+' || retention_days || ' days') >= datetime('now', '+365 days')
          THEN 1 ELSE 0 END) as expiring_later
      FROM chunks
    `).get() as Record<string, number>;
    return {
      never_decay: row.never_decay ?? 0,
      expiring_30d: row.expiring_30d ?? 0,
      expiring_90d: row.expiring_90d ?? 0,
      expiring_365d: row.expiring_365d ?? 0,
      expiring_later: row.expiring_later ?? 0,
      already_expired: row.already_expired ?? 0,
    };
  } catch {
    return empty;
  }
}

export function getTierStats(db: Database.Database): Record<string, number> {
  const rows = db.prepare(`
    SELECT tier, COUNT(*) as count FROM chunks GROUP BY tier
  `).all() as Array<{ tier: string; count: number }>;

  const stats: Record<string, number> = { core: 0, working: 0, peripheral: 0 };
  for (const row of rows) {
    if (row.tier) stats[row.tier] = (stats[row.tier] ?? 0) + row.count;
  }
  return stats;
}
