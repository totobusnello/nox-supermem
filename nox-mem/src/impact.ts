// E07 (2026-05-03): impact — 1-hop blast radius via kg_relations agrupado por relation_reason.
// Read-only. Usa E05 reasons enriquecidos pra priorizar dependency chains.

import { getDb } from "./db.js";

export interface ImpactNeighbor {
  entity_id: number;
  name: string;
  entity_type: string;
  mention_count: number;
  direction: 'outgoing' | 'incoming';
  relation_type: string;
  relation_reason: string;
  confidence: number;
}

export interface ImpactGroup {
  reason: string;
  count: number;
  neighbors: ImpactNeighbor[];
}

export interface ImpactResult {
  query: string;
  resolved_entity: { id: number; name: string; type: string; mention_count: number } | null;
  ambiguous_matches?: Array<{ id: number; name: string; type: string; mention_count: number }>;
  total_neighbors: number;
  unique_entities: number;
  by_reason: ImpactGroup[];
  blast_radius_score: number;
  duration_ms: number;
}

const REASON_PRIORITY: Record<string, number> = {
  depends_on: 5,    // mexer aqui quebra coisas downstream
  replaces: 4,      // mexer pode reabrir o que substituiu
  extends: 3,       // mexer afeta extensions
  derived_from: 2,  // mexer invalida derivações
  opposes: 2,       // mexer reativa contradições
  mentions: 1,      // soft reference
  unknown: 1,
};

function resolveEntity(query: string): { id: number; name: string; type: string; mention_count: number } | null {
  const db = getDb();
  // Exact match (case-insensitive) primeiro
  let row = db.prepare(
    "SELECT id, name, entity_type as type, mention_count FROM kg_entities WHERE LOWER(name) = LOWER(?) ORDER BY mention_count DESC LIMIT 1"
  ).get(query) as any;
  if (row) return row;
  // Fallback: substring match com mais alto mention_count
  row = db.prepare(
    "SELECT id, name, entity_type as type, mention_count FROM kg_entities WHERE LOWER(name) LIKE LOWER(?) ORDER BY mention_count DESC LIMIT 1"
  ).get(`%${query}%`) as any;
  return row || null;
}

function findAmbiguous(query: string, excludeId: number): Array<{ id: number; name: string; type: string; mention_count: number }> {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, name, entity_type as type, mention_count FROM kg_entities WHERE LOWER(name) LIKE LOWER(?) AND id != ? ORDER BY mention_count DESC LIMIT 5"
  ).all(`%${query}%`, excludeId) as any[];
  return rows;
}

export function computeImpact(opts: { query: string }): ImpactResult {
  const start = Date.now();
  const db = getDb();
  const resolved = resolveEntity(opts.query);

  if (!resolved) {
    return {
      query: opts.query,
      resolved_entity: null,
      total_neighbors: 0,
      unique_entities: 0,
      by_reason: [],
      blast_radius_score: 0,
      duration_ms: Date.now() - start,
    };
  }

  const ambiguous = findAmbiguous(opts.query, resolved.id);

  // BFS 1-hop: outgoing (this is source) + incoming (this is target)
  const outgoing = db.prepare(
    `SELECT r.id as rel_id, r.relation_type, r.relation_reason, r.confidence,
            e.id as entity_id, e.name, e.entity_type, e.mention_count
     FROM kg_relations r
     JOIN kg_entities e ON e.id = r.target_entity_id
     WHERE r.source_entity_id = ?
       AND (r.expires_at IS NULL OR r.expires_at > datetime('now'))`
  ).all(resolved.id) as any[];

  const incoming = db.prepare(
    `SELECT r.id as rel_id, r.relation_type, r.relation_reason, r.confidence,
            e.id as entity_id, e.name, e.entity_type, e.mention_count
     FROM kg_relations r
     JOIN kg_entities e ON e.id = r.source_entity_id
     WHERE r.target_entity_id = ?
       AND (r.expires_at IS NULL OR r.expires_at > datetime('now'))`
  ).all(resolved.id) as any[];

  const neighbors: ImpactNeighbor[] = [
    ...outgoing.map((r) => ({
      entity_id: r.entity_id,
      name: r.name,
      entity_type: r.entity_type,
      mention_count: r.mention_count,
      direction: 'outgoing' as const,
      relation_type: r.relation_type,
      relation_reason: r.relation_reason || 'unknown',
      confidence: r.confidence,
    })),
    ...incoming.map((r) => ({
      entity_id: r.entity_id,
      name: r.name,
      entity_type: r.entity_type,
      mention_count: r.mention_count,
      direction: 'incoming' as const,
      relation_type: r.relation_type,
      relation_reason: r.relation_reason || 'unknown',
      confidence: r.confidence,
    })),
  ];

  // Group by reason
  const byReason = new Map<string, ImpactNeighbor[]>();
  for (const n of neighbors) {
    if (!byReason.has(n.relation_reason)) byReason.set(n.relation_reason, []);
    byReason.get(n.relation_reason)!.push(n);
  }

  const groups: ImpactGroup[] = Array.from(byReason.entries())
    .map(([reason, list]) => ({
      reason,
      count: list.length,
      neighbors: list.sort((a, b) => b.mention_count - a.mention_count),
    }))
    .sort((a, b) => (REASON_PRIORITY[b.reason] || 0) - (REASON_PRIORITY[a.reason] || 0));

  // Blast radius: sum(neighbor.mention_count * reason_priority * confidence)
  const blastScore = neighbors.reduce(
    (acc, n) => acc + (n.mention_count * (REASON_PRIORITY[n.relation_reason] || 1) * n.confidence),
    0,
  );

  const uniqueEntities = new Set(neighbors.map((n) => n.entity_id)).size;

  const result: ImpactResult = {
    query: opts.query,
    resolved_entity: resolved,
    total_neighbors: neighbors.length,
    unique_entities: uniqueEntities,
    by_reason: groups,
    blast_radius_score: Math.round(blastScore * 10) / 10,
    duration_ms: Date.now() - start,
  };

  if (ambiguous.length > 0) result.ambiguous_matches = ambiguous;
  return result;
}

export function formatImpact(r: ImpactResult, mode: 'json' | 'text' = 'text'): string {
  if (mode === 'json') return JSON.stringify(r, null, 2);
  const lines: string[] = [];
  if (!r.resolved_entity) {
    return `## impact: "${r.query}"\nEntity not found in KG. Try \`nox-mem kg-query <name>\` to verify.`;
  }
  const e = r.resolved_entity;
  lines.push(`## impact: "${e.name}" [${e.type}, ${e.mention_count} mentions]`);
  lines.push(`Total neighbors: ${r.total_neighbors} | Unique entities: ${r.unique_entities} | Blast radius score: ${r.blast_radius_score} | Duration: ${r.duration_ms}ms`);
  if (r.ambiguous_matches && r.ambiguous_matches.length > 0) {
    lines.push(`\n⚠️  Ambiguous: ${r.ambiguous_matches.length} other entities match "${r.query}":`);
    for (const a of r.ambiguous_matches.slice(0, 3)) {
      lines.push(`   - [${a.type}] ${a.name} (${a.mention_count} mentions, id=${a.id})`);
    }
  }
  if (r.by_reason.length === 0) {
    lines.push(`\n(no relations — entity is isolated in the graph)`);
    return lines.join("\n");
  }
  lines.push(``);
  for (const g of r.by_reason) {
    const priority = REASON_PRIORITY[g.reason] || 1;
    const marker = priority >= 4 ? "🔴" : priority >= 2 ? "🟡" : "⚪";
    lines.push(`### ${marker} ${g.reason} (${g.count}, priority=${priority})`);
    for (const n of g.neighbors.slice(0, 10)) {
      const arrow = n.direction === 'outgoing' ? '→' : '←';
      lines.push(`   ${arrow} [${n.entity_type}] ${n.name} (${n.mention_count} m, conf=${n.confidence}, via=${n.relation_type})`);
    }
    if (g.neighbors.length > 10) lines.push(`   ... +${g.neighbors.length - 10} more`);
    lines.push(``);
  }
  return lines.join("\n");
}
