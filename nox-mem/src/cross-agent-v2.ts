/**
 * cross-agent-v2.ts — Cross-Agent Intelligence: knowledge sharing + expertise profiling
 */
import Database from "better-sqlite3";
import { resolve } from "path";
import { existsSync } from "fs";

const AGENTS_DIR = "/root/.openclaw/agents";
const WORKSPACE_DB = "/root/.openclaw/workspace/tools/nox-mem/nox-mem.db";
const AGENT_NAMES = ["nox", "atlas", "boris", "cipher", "forge", "lex"];

function getAgentDb(agent: string): Database.Database | null {
  const p = resolve(AGENTS_DIR, agent, "tools", "nox-mem", "nox-mem.db");
  if (!existsSync(p)) return null;
  try { return new Database(p, { readonly: true }); } catch { return null; }
}

// ─── Agent Expertise Profiling ───────────────────────────────────────────────

export interface AgentProfile {
  agent: string;
  totalChunks: number;
  topTypes: Array<{ type: string; count: number }>;
  topTopics: string[];
  lastActivity: string | null;
  uniqueStrength: string;
}

export function profileAgent(agentName: string): AgentProfile | null {
  const db = getAgentDb(agentName);
  if (!db) return null;

  try {
    const total = (db.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;
    
    const types = db.prepare(
      "SELECT chunk_type, COUNT(*) as c FROM chunks GROUP BY chunk_type ORDER BY c DESC LIMIT 5"
    ).all() as Array<{ chunk_type: string; c: number }>;

    // Extract top topics via FTS5 term frequency
    let topTopics: string[] = [];
    try {
      const terms = db.prepare(`
        SELECT term, SUM(cnt) as total FROM (
          SELECT DISTINCT term, cnt FROM chunks_fts_data
          WHERE col = 0 AND term NOT IN ('the','and','for','that','this','with','from','are','was','been','have','has','not','but','they','you','all')
          ORDER BY cnt DESC LIMIT 20
        ) GROUP BY term ORDER BY total DESC LIMIT 10
      `).all() as Array<{ term: string; total: number }>;
      topTopics = terms.map(t => t.term);
    } catch {
      // FTS internal tables may not be accessible
    }

    const lastDate = db.prepare(
      "SELECT MAX(source_date) as d FROM chunks WHERE source_date IS NOT NULL"
    ).get() as { d: string | null };

    // Determine unique strength based on dominant type
    const dominant = types[0]?.chunk_type || "general";
    const strengthMap: Record<string, string> = {
      "team": "team coordination & shared knowledge",
      "decision": "decision tracking & rationale",
      "lesson": "lessons learned & pattern recognition",
      "daily": "daily operations & activity logging",
      "project": "project management & tracking",
      "person": "people & relationship management",
      "other": "general knowledge & context",
    };

    db.close();
    return {
      agent: agentName,
      totalChunks: total,
      topTypes: types.map(t => ({ type: t.chunk_type, count: t.c })),
      topTopics,
      lastActivity: lastDate.d,
      uniqueStrength: strengthMap[dominant] || dominant,
    };
  } catch { db.close(); return null; }
}

export function profileAllAgents(): AgentProfile[] {
  return AGENT_NAMES.map(profileAgent).filter(Boolean) as AgentProfile[];
}

// ─── Knowledge Sharing: Pull lessons/decisions from other agents ─────────────

export interface SharedInsight {
  agent: string;
  type: string;
  text: string;
  date: string | null;
  relevance: number;
}

export function pullInsightsFrom(
  sourceAgent: string,
  types: string[] = ["decision", "lesson"],
  limit = 10
): SharedInsight[] {
  const db = getAgentDb(sourceAgent);
  if (!db) return [];

  try {
    const placeholders = types.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT chunk_text, chunk_type, source_date, source_file
      FROM chunks
      WHERE chunk_type IN (${placeholders})
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...types, limit) as Array<{
      chunk_text: string; chunk_type: string;
      source_date: string | null; source_file: string;
    }>;

    db.close();
    return rows.map(r => ({
      agent: sourceAgent,
      type: r.chunk_type,
      text: r.chunk_text,
      date: r.source_date,
      relevance: 1.0,
    }));
  } catch { db.close(); return []; }
}

export function pullAllInsights(
  excludeAgent?: string,
  types: string[] = ["decision", "lesson"],
  limitPerAgent = 5
): SharedInsight[] {
  const all: SharedInsight[] = [];
  for (const agent of AGENT_NAMES) {
    if (agent === excludeAgent) continue;
    all.push(...pullInsightsFrom(agent, types, limitPerAgent));
  }
  // Sort by date descending
  all.sort((a, b) => {
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date);
  });
  return all;
}

// ─── Cross-Agent Knowledge Graph Merge ───────────────────────────────────────

export interface CrossEntity {
  name: string;
  type: string;
  agents: string[];
  totalMentions: number;
}

export function mergeCrossKnowledgeGraphs(): { entities: CrossEntity[]; totalRelations: number } {
  const entityMap = new Map<string, CrossEntity>();
  let totalRelations = 0;

  for (const agent of AGENT_NAMES) {
    const db = getAgentDb(agent);
    if (!db) continue;

    try {
      // Check if KG tables exist
      const hasKg = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='kg_entities'"
      ).get();
      
      if (!hasKg) { db.close(); continue; }

      const entities = db.prepare(
        "SELECT name, entity_type, mention_count FROM kg_entities"
      ).all() as Array<{ name: string; entity_type: string; mention_count: number }>;

      for (const e of entities) {
        const key = `${e.entity_type}:${e.name.toLowerCase()}`;
        if (entityMap.has(key)) {
          const existing = entityMap.get(key)!;
          existing.agents.push(agent);
          existing.totalMentions += e.mention_count;
        } else {
          entityMap.set(key, {
            name: e.name,
            type: e.entity_type,
            agents: [agent],
            totalMentions: e.mention_count,
          });
        }
      }

      const relCount = (db.prepare("SELECT COUNT(*) as c FROM kg_relations").get() as { c: number }).c;
      totalRelations += relCount;
      db.close();
    } catch { db.close(); }
  }

  // Also merge workspace KG
  try {
    const wsDb = new Database(WORKSPACE_DB, { readonly: true });
    const hasKg = wsDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='kg_entities'"
    ).get();
    
    if (hasKg) {
      const entities = wsDb.prepare(
        "SELECT name, entity_type, mention_count FROM kg_entities"
      ).all() as Array<{ name: string; entity_type: string; mention_count: number }>;

      for (const e of entities) {
        const key = `${e.entity_type}:${e.name.toLowerCase()}`;
        if (entityMap.has(key)) {
          const existing = entityMap.get(key)!;
          if (!existing.agents.includes("workspace")) existing.agents.push("workspace");
          existing.totalMentions += e.mention_count;
        } else {
          entityMap.set(key, {
            name: e.name, type: e.entity_type,
            agents: ["workspace"], totalMentions: e.mention_count,
          });
        }
      }

      const relCount = (wsDb.prepare("SELECT COUNT(*) as c FROM kg_relations").get() as { c: number }).c;
      totalRelations += relCount;
    }
    wsDb.close();
  } catch {}

  const entities = Array.from(entityMap.values())
    .sort((a, b) => b.totalMentions - a.totalMentions);

  return { entities, totalRelations };
}

// ─── Graph Traversal: Find path between entities ─────────────────────────────

export function findPath(
  startName: string,
  endName: string,
  maxDepth = 4
): Array<{ entity: string; relation: string }> | null {
  const db = new Database(WORKSPACE_DB, { readonly: true });
  
  try {
    const hasKg = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='kg_entities'"
    ).get();
    if (!hasKg) { db.close(); return null; }

    const startEntity = db.prepare(
      "SELECT id, name FROM kg_entities WHERE name LIKE ? LIMIT 1"
    ).get(`%${startName}%`) as { id: number; name: string } | undefined;

    const endEntity = db.prepare(
      "SELECT id, name FROM kg_entities WHERE name LIKE ? LIMIT 1"
    ).get(`%${endName}%`) as { id: number; name: string } | undefined;

    if (!startEntity || !endEntity) { db.close(); return null; }

    // BFS
    const queue: Array<{ entityId: number; path: Array<{ entity: string; relation: string }> }> = [
      { entityId: startEntity.id, path: [{ entity: startEntity.name, relation: "START" }] }
    ];
    const visited = new Set<number>([startEntity.id]);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.path.length > maxDepth) continue;

      // Get neighbors
      const neighbors = db.prepare(`
        SELECT 
          CASE WHEN r.source_entity_id = ? THEN r.target_entity_id ELSE r.source_entity_id END as neighbor_id,
          CASE WHEN r.source_entity_id = ? THEN e2.name ELSE e1.name END as neighbor_name,
          r.relation_type
        FROM kg_relations r
        JOIN kg_entities e1 ON e1.id = r.source_entity_id
        JOIN kg_entities e2 ON e2.id = r.target_entity_id
        WHERE r.source_entity_id = ? OR r.target_entity_id = ?
      `).all(current.entityId, current.entityId, current.entityId, current.entityId) as Array<{
        neighbor_id: number; neighbor_name: string; relation_type: string;
      }>;

      for (const n of neighbors) {
        if (n.neighbor_id === endEntity.id) {
          db.close();
          return [...current.path, { entity: n.neighbor_name, relation: n.relation_type }];
        }
        if (!visited.has(n.neighbor_id)) {
          visited.add(n.neighbor_id);
          queue.push({
            entityId: n.neighbor_id,
            path: [...current.path, { entity: n.neighbor_name, relation: n.relation_type }],
          });
        }
      }
    }

    db.close();
    return null; // No path found
  } catch { db.close(); return null; }
}

// ─── Formatters ──────────────────────────────────────────────────────────────

export function formatProfiles(profiles: AgentProfile[]): string {
  return profiles.map(p => {
    const types = p.topTypes.map(t => `${t.type}:${t.count}`).join(", ");
    return `📋 ${p.agent} (${p.totalChunks} chunks)\n   Strength: ${p.uniqueStrength}\n   Types: ${types}\n   Last: ${p.lastActivity || "unknown"}`;
  }).join("\n\n");
}

export function formatPath(path: Array<{ entity: string; relation: string }> | null): string {
  if (!path) return "No path found between entities.";
  return path.map((step, i) => {
    if (i === 0) return `🟢 ${step.entity}`;
    return `  —[${step.relation}]→ ${step.entity}`;
  }).join("\n");
}

export function formatCrossKG(result: { entities: CrossEntity[]; totalRelations: number }): string {
  const lines = [
    `=== Cross-Agent Knowledge Graph ===`,
    `Total unique entities: ${result.entities.length}`,
    `Total relations: ${result.totalRelations}\n`,
    `Top entities (by mentions):`,
  ];
  for (const e of result.entities.slice(0, 15)) {
    lines.push(`  ${e.name} (${e.type}) — ${e.totalMentions} mentions [${e.agents.join(", ")}]`);
  }
  return lines.join("\n");
}
