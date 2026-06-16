/**
 * knowledge-graph.ts — Extract and query entity relationships from memory chunks
 * Entities: people, projects, decisions, tools, agents
 * Relations: decided, works_on, blocked_by, depends_on, reviewed, assigned_to
 */
import { getDb } from "./db.js";

// ─── Name normalization ──────────────────────────────────────────────────────
// Canonical names: merge variants into a single entity.
// This static alias table is used only by the legacy regex-based extractor
// (buildGraph). The Gemini-powered extractor (kg-extract.ts) does not use it.
// Standalone operators: this table is origin-specific. It has no effect on
// correctness — it only avoids duplicate entities for known name variants.
// You can safely leave it as-is; unknown names simply won't be merged.

// Neutral built-in aliases (tech terms only). Operator-specific name pairs
// are loaded from NOX_NAME_ALIASES (format: "from:To,from2:To2").
// On the origin VPS set NOX_NAME_ALIASES to restore personal alias behavior.
const _builtinAliases: Record<string, string> = {
  // Agents (kept generic — configurable via NOX_AGENTS)
  "nox": "Nox",
  "atlas": "Atlas",
  "boris": "Boris",
  "cipher": "Cipher",
  "forge": "Forge",
  "lex": "Lex",
  // Core platform
  "openclaw": "OpenClaw",
  "nox-mem": "nox-mem",
  "supermem": "Supermem",
};

function _parseEnvAliases(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf(":");
    if (idx < 1) continue;
    const from = pair.slice(0, idx).trim().toLowerCase();
    const to = pair.slice(idx + 1).trim();
    if (from && to) result[from] = to;
  }
  return result;
}

const NAME_ALIASES: Record<string, string> = {
  ..._builtinAliases,
  ...(process.env.NOX_NAME_ALIASES ? _parseEnvAliases(process.env.NOX_NAME_ALIASES) : {}),
};

function normalizeName(name: string): string {
  const lower = name.toLowerCase().trim();
  return NAME_ALIASES[lower] || name;
}



// ─── Schema ──────────────────────────────────────────────────────────────────

export function ensureGraphTables(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS kg_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      attributes TEXT,
      first_seen TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now')),
      mention_count INTEGER DEFAULT 1,
      UNIQUE(name, entity_type)
    );
    CREATE TABLE IF NOT EXISTS kg_relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_entity_id INTEGER NOT NULL,
      relation_type TEXT NOT NULL,
      target_entity_id INTEGER NOT NULL,
      evidence_chunk_id INTEGER,
      confidence REAL DEFAULT 0.8,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT DEFAULT (datetime('now', '+90 days')),
      last_confirmed TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (source_entity_id) REFERENCES kg_entities(id),
      FOREIGN KEY (target_entity_id) REFERENCES kg_entities(id)
    );
    CREATE INDEX IF NOT EXISTS idx_kg_entities_name ON kg_entities(name);
    CREATE INDEX IF NOT EXISTS idx_kg_entities_type ON kg_entities(entity_type);
    CREATE INDEX IF NOT EXISTS idx_kg_relations_source ON kg_relations(source_entity_id);
    CREATE INDEX IF NOT EXISTS idx_kg_relations_target ON kg_relations(target_entity_id);
  `);

  // Idempotent: add attributes column to DBs created before this fix
  try { db.exec(`ALTER TABLE kg_entities ADD COLUMN attributes TEXT`); } catch { /* already exists */ }

  // Migrate existing tables: add TTL columns if they don't exist
  const db2 = getDb();
  try { db2.exec(`ALTER TABLE kg_relations ADD COLUMN expires_at TEXT`); } catch { /* already exists */ }
  try { db2.exec(`ALTER TABLE kg_relations ADD COLUMN last_confirmed TEXT`); } catch { /* already exists */ }
  // Backfill values for existing rows
  db2.exec(`UPDATE kg_relations SET expires_at = datetime(created_at, '+90 days') WHERE expires_at IS NULL`);
  db2.exec(`UPDATE kg_relations SET last_confirmed = created_at WHERE last_confirmed IS NULL`);
  // Index on expires_at (safe now that column exists)
  try { db2.exec(`CREATE INDEX IF NOT EXISTS idx_kg_relations_expires ON kg_relations(expires_at)`); } catch { /* ok */ }
}

// ─── Entity extraction patterns ──────────────────────────────────────────────
// These static regex patterns are used ONLY by the legacy buildGraph() extractor.
// The Gemini-powered kg-extract.ts does not use them.
// Personal-name patterns default to empty. Configure via NOX_ENTITY_PATTERNS.
// AGENT_PATTERNS is derived from NOX_AGENTS so operators get matches for
// their configured agents without touching source code.

// Personal-name patterns are driven by NOX_ENTITY_PATTERNS (comma-separated terms).
// Default is empty — no personal names ship in the open-source build.
// On the origin VPS set NOX_ENTITY_PATTERNS to restore entity-extraction behavior.
// Example: NOX_ENTITY_PATTERNS=Alice,Bob,ProjectX,CorpName,...

function _buildEntityPattern(terms: string[]): RegExp[] {
  if (terms.length === 0) return [];
  const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return [new RegExp(`(?:${escaped})`, "gi")];
}

const _envEntityTerms: string[] = process.env.NOX_ENTITY_PATTERNS
  ? process.env.NOX_ENTITY_PATTERNS.split(",").map(s => s.trim()).filter(Boolean)
  : [];

const PERSON_PATTERNS: RegExp[] = _buildEntityPattern(_envEntityTerms.filter(t => {
  // Operator must supply person/project split via NOX_PERSON_PATTERNS or we treat all terms as persons
  return true;
}));

// PROJECT_PATTERNS: loaded from NOX_PROJECT_PATTERNS (comma-separated) if set,
// otherwise falls back to the generic NOX_ENTITY_PATTERNS terms.
const _envProjectTerms: string[] = process.env.NOX_PROJECT_PATTERNS
  ? process.env.NOX_PROJECT_PATTERNS.split(",").map(s => s.trim()).filter(Boolean)
  : [];

const PROJECT_PATTERNS: RegExp[] = _buildEntityPattern(_envProjectTerms);

// Build agent pattern from configured agent list so standalone operators
// get correct entity extraction for their own agent names.
const _configuredAgents = process.env.NOX_AGENTS
  ? process.env.NOX_AGENTS.split(",").map(s => s.trim()).filter(Boolean)
  : ["Nox", "Atlas", "Boris", "Cipher", "Forge", "Lex"];

const AGENT_PATTERNS: RegExp[] = _configuredAgents.length > 0
  ? [new RegExp(`(?:${_configuredAgents.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "g")]
  : [];

const DECISION_PATTERNS = [
  /\*\*Decisão:\*\*\s*(.+?)(?:\n|$)/gi,
  /Decidiu?\s+(.+?)(?:\.|$)/gi,
];

const RELATION_PATTERNS: Array<{ pattern: RegExp; relationType: string }> = [
  { pattern: /(\w+)\s+(?:decidiu|definiu|aprovou)\s+(.+?)(?:\.|$)/gi, relationType: "decided" },
  { pattern: /(\w+)\s+(?:trabalha|atua|responsável)\s+(?:em|por|no|na)\s+(.+?)(?:\.|$)/gi, relationType: "works_on" },
  { pattern: /(\w+)\s+(?:revisou|analisou|auditou)\s+(.+?)(?:\.|$)/gi, relationType: "reviewed" },
  { pattern: /(\w+)\s+(?:bloqueado|aguardando|depende)\s+(?:por|de)\s+(.+?)(?:\.|$)/gi, relationType: "blocked_by" },
];

// ─── Extract entities from text ──────────────────────────────────────────────

interface ExtractedEntity {
  name: string;
  entityType: string;
}

function extractEntities(text: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();

  for (const pattern of PERSON_PATTERNS) {
    for (const match of text.matchAll(new RegExp(pattern))) {
      const name = match[0].trim();
      const key = `person:${normalizeName(name).toLowerCase()}`;
      if (!seen.has(key)) { seen.add(key); entities.push({ name: normalizeName(name), entityType: "person" }); }
    }
  }

  for (const pattern of PROJECT_PATTERNS) {
    for (const match of text.matchAll(new RegExp(pattern))) {
      const name = match[0].trim();
      const key = `project:${normalizeName(name).toLowerCase()}`;
      if (!seen.has(key)) { seen.add(key); entities.push({ name: normalizeName(name), entityType: "project" }); }
    }
  }

  for (const pattern of AGENT_PATTERNS) {
    for (const match of text.matchAll(new RegExp(pattern))) {
      const name = match[0].trim();
      const key = `agent:${normalizeName(name).toLowerCase()}`;
      if (!seen.has(key)) { seen.add(key); entities.push({ name: normalizeName(name), entityType: "agent" }); }
    }
  }

  return entities;
}

// ─── Upsert entity ───────────────────────────────────────────────────────────

function upsertEntity(name: string, entityType: string): number {
  const db = getDb();
  const existing = db.prepare(
    "SELECT id FROM kg_entities WHERE name = ? AND entity_type = ?"
  ).get(name, entityType) as { id: number } | undefined;

  if (existing) {
    db.prepare(
      "UPDATE kg_entities SET mention_count = mention_count + 1, last_seen = datetime('now') WHERE id = ?"
    ).run(existing.id);
    return existing.id;
  }

  const info = db.prepare(
    "INSERT INTO kg_entities (name, entity_type) VALUES (?, ?)"
  ).run(name, entityType);
  return Number(info.lastInsertRowid);
}

// ─── Add relation ────────────────────────────────────────────────────────────

function addRelation(sourceId: number, relationType: string, targetId: number, chunkId?: number): void {
  const db = getDb();
  // Check for existing relation
  const existing = db.prepare(
    "SELECT id FROM kg_relations WHERE source_entity_id = ? AND relation_type = ? AND target_entity_id = ?"
  ).get(sourceId, relationType, targetId);

  if (!existing) {
    db.prepare(
      "INSERT INTO kg_relations (source_entity_id, relation_type, target_entity_id, evidence_chunk_id) VALUES (?, ?, ?, ?)"
    ).run(sourceId, relationType, targetId, chunkId || null);
  }
}

// ─── Build graph from chunks ─────────────────────────────────────────────────

export function buildGraph(limit: number = 100): { entities: number; relations: number } {
  const db = getDb();
  ensureGraphTables();

  // Get recent chunks that havent been processed
  const lastProcessed = (db.prepare(
    "SELECT value FROM meta WHERE key = 'kg_last_chunk_id'"
  ).get() as { value: string } | undefined)?.value || "0";

  const chunks = db.prepare(`
    SELECT id, chunk_text, chunk_type, source_file, source_date
    FROM chunks WHERE id > ? ORDER BY id ASC LIMIT ?
  `).all(parseInt(lastProcessed), limit) as Array<{
    id: number; chunk_text: string; chunk_type: string;
    source_file: string; source_date: string | null;
  }>;

  if (chunks.length === 0) {
    console.log("[KG] No new chunks to process");
    return { entities: 0, relations: 0 };
  }

  let totalEntities = 0;
  let totalRelations = 0;
  let maxChunkId = parseInt(lastProcessed);

  for (const chunk of chunks) {
    const entities = extractEntities(chunk.chunk_text);

    // Upsert all entities
    const entityIds: Map<string, number> = new Map();
    for (const e of entities) {
      const id = upsertEntity(e.name, e.entityType);
      entityIds.set(`${e.entityType}:${e.name}`, id);
      totalEntities++;
    }

    // Extract relations from chunk context
    // If chunk mentions a person + project, create "works_on" or "mentioned_with"
    const people = entities.filter(e => e.entityType === "person");
    const projects = entities.filter(e => e.entityType === "project");
    const agents = entities.filter(e => e.entityType === "agent");

    // Person ↔ Project co-occurrence
    for (const person of people) {
      for (const project of projects) {
        const pId = entityIds.get(`person:${person.name}`)!;
        const projId = entityIds.get(`project:${project.name}`)!;
        const relType = chunk.chunk_type === "decision" ? "decided_on" : "mentioned_with";
        addRelation(pId, relType, projId, chunk.id);
        totalRelations++;
      }
    }

    // Agent ↔ Project co-occurrence
    for (const agent of agents) {
      for (const project of projects) {
        const aId = entityIds.get(`agent:${agent.name}`)!;
        const projId = entityIds.get(`project:${project.name}`)!;
        addRelation(aId, "works_on", projId, chunk.id);
        totalRelations++;
      }
    }

    maxChunkId = Math.max(maxChunkId, chunk.id);
  }

  // Update cursor
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('kg_last_chunk_id', ?)"
  ).run(String(maxChunkId));

  return { entities: totalEntities, relations: totalRelations };
}

// ─── Query graph ─────────────────────────────────────────────────────────────

export interface GraphNode {
  id: number;
  name: string;
  entityType: string;
  mentionCount: number;
}

export interface GraphEdge {
  source: string;
  relation: string;
  target: string;
}

export function queryEntity(name: string): { entity: GraphNode | null; relations: GraphEdge[] } {
  const db = getDb();
  ensureGraphTables();

  const entity = db.prepare(
    "SELECT * FROM kg_entities WHERE name LIKE ? ORDER BY mention_count DESC LIMIT 1"
  ).get(`%${name}%`) as { id: number; name: string; entity_type: string; mention_count: number } | undefined;

  if (!entity) return { entity: null, relations: [] };

  const node: GraphNode = {
    id: entity.id, name: entity.name,
    entityType: entity.entity_type, mentionCount: entity.mention_count,
  };

  const rels = db.prepare(`
    SELECT e1.name as source_name, r.relation_type, e2.name as target_name
    FROM kg_relations r
    JOIN kg_entities e1 ON e1.id = r.source_entity_id
    JOIN kg_entities e2 ON e2.id = r.target_entity_id
    WHERE r.source_entity_id = ? OR r.target_entity_id = ?
    ORDER BY r.created_at DESC LIMIT 20
  `).all(entity.id, entity.id) as Array<{
    source_name: string; relation_type: string; target_name: string;
  }>;

  const relations: GraphEdge[] = rels.map(r => ({
    source: r.source_name, relation: r.relation_type, target: r.target_name,
  }));

  return { entity: node, relations };
}


// ─── Merge duplicate entities ────────────────────────────────────────────────

export function mergeEntities(): { merged: number } {
  const db = getDb();
  ensureGraphTables();

  let totalMerged = 0;

  const allEntities = db.prepare(
    "SELECT id, name, entity_type, mention_count FROM kg_entities ORDER BY mention_count DESC"
  ).all() as Array<{ id: number; name: string; entity_type: string; mention_count: number }>;

  const canonical = new Map<string, { id: number; name: string; count: number }>();
  const toMerge: Array<{ fromId: number; toId: number }> = [];

  for (const e of allEntities) {
    const normalizedName = normalizeName(e.name);
    const key = `${e.entity_type}:${normalizedName.toLowerCase()}`;

    if (canonical.has(key)) {
      const target = canonical.get(key)!;
      toMerge.push({ fromId: e.id, toId: target.id });
      db.prepare(
        "UPDATE kg_entities SET mention_count = mention_count + ? WHERE id = ?"
      ).run(e.mention_count, target.id);
    } else {
      canonical.set(key, { id: e.id, name: normalizedName, count: e.mention_count });
      if (e.name !== normalizedName) {
        try {
          db.prepare("UPDATE kg_entities SET name = ? WHERE id = ?").run(normalizedName, e.id);
        } catch {
          // Name already exists as canonical — mark for merge instead
          const existing = db.prepare(
            "SELECT id FROM kg_entities WHERE name = ? AND entity_type = ? AND id != ?"
          ).get(normalizedName, e.entity_type, e.id) as { id: number } | undefined;
          if (existing) {
            toMerge.push({ fromId: e.id, toId: existing.id });
            db.prepare(
              "UPDATE kg_entities SET mention_count = mention_count + ? WHERE id = ?"
            ).run(e.mention_count, existing.id);
          }
        }
      }
    }
  }

  for (const { fromId, toId } of toMerge) {
    db.prepare(
      "UPDATE kg_relations SET source_entity_id = ? WHERE source_entity_id = ?"
    ).run(toId, fromId);
    db.prepare(
      "UPDATE kg_relations SET target_entity_id = ? WHERE target_entity_id = ?"
    ).run(toId, fromId);
    db.prepare("DELETE FROM kg_entities WHERE id = ?").run(fromId);
    totalMerged++;
  }

  // Deduplicate relations
  db.prepare(`
    DELETE FROM kg_relations WHERE id NOT IN (
      SELECT MIN(id) FROM kg_relations
      GROUP BY source_entity_id, relation_type, target_entity_id
    )
  `).run();

  return { merged: totalMerged };
}

/**
 * Read-only preview of mergeEntities() — reports what would be merged without
 * mutating the graph. Backs `kg-merge --dry-run` (CLAUDE.md rule #6: destructive
 * ops must support dry-run). Mirrors the canonicalization logic of mergeEntities.
 */
export function previewMergeEntities(): {
  wouldMerge: number;
  groups: Array<{ entityType: string; canonicalName: string; duplicates: number }>;
} {
  const db = getDb();
  ensureGraphTables();

  const allEntities = db.prepare(
    "SELECT id, name, entity_type, mention_count FROM kg_entities ORDER BY mention_count DESC"
  ).all() as Array<{ id: number; name: string; entity_type: string; mention_count: number }>;

  const canonical = new Map<string, { name: string; duplicates: number; entityType: string }>();
  for (const e of allEntities) {
    const normalizedName = normalizeName(e.name);
    const key = `${e.entity_type}:${normalizedName.toLowerCase()}`;
    const existing = canonical.get(key);
    if (existing) {
      existing.duplicates++;
    } else {
      canonical.set(key, { name: normalizedName, duplicates: 0, entityType: e.entity_type });
    }
  }

  const groups = [...canonical.values()]
    .filter((g) => g.duplicates > 0)
    .map((g) => ({ entityType: g.entityType, canonicalName: g.name, duplicates: g.duplicates }));
  const wouldMerge = groups.reduce((sum, g) => sum + g.duplicates, 0);

  return { wouldMerge, groups };
}

export function getGraphStats(): string {
  const db = getDb();
  ensureGraphTables();

  const entityCount = (db.prepare("SELECT COUNT(*) as c FROM kg_entities").get() as { c: number }).c;
  const relationCount = (db.prepare("SELECT COUNT(*) as c FROM kg_relations").get() as { c: number }).c;

  const byType = db.prepare(
    "SELECT entity_type, COUNT(*) as c FROM kg_entities GROUP BY entity_type ORDER BY c DESC"
  ).all() as Array<{ entity_type: string; c: number }>;

  const topEntities = db.prepare(
    "SELECT name, entity_type, mention_count FROM kg_entities ORDER BY mention_count DESC LIMIT 10"
  ).all() as Array<{ name: string; entity_type: string; mention_count: number }>;

  const lines = [
    `=== Knowledge Graph ===\n`,
    `Entities: ${entityCount}`,
    `Relations: ${relationCount}\n`,
    `By type:`,
    ...byType.map(t => `  ${t.entity_type}: ${t.c}`),
    `\nTop entities:`,
    ...topEntities.map(e => `  ${e.name} (${e.entity_type}) — ${e.mention_count} mentions`),
  ];

  return lines.join("\n");
}

export function formatEntityQuery(name: string): string {
  const { entity, relations } = queryEntity(name);
  if (!entity) return `Entity "${name}" not found in knowledge graph.`;

  const lines = [
    `=== ${entity.name} (${entity.entityType}) ===`,
    `Mentions: ${entity.mentionCount}\n`,
    `Relations:`,
    ...relations.map(r => `  ${r.source} —[${r.relation}]→ ${r.target}`),
  ];

  return lines.join("\n");
}

// ─── TTL / Confidence Decay ──────────────────────────────────────────────────

export interface PruneResult {
  expired: number;
  decayed: number;
  confirmed: number;
}

/**
 * Decay confidence on relations not recently confirmed.
 * Relations lose 0.1 confidence every 30 days without re-confirmation.
 * Relations below 0.3 confidence are marked for expiry.
 * Relations past expires_at are deleted.
 */
export function pruneKnowledgeGraph(dryRun = false): PruneResult {
  ensureGraphTables(); // ensure columns exist (migration)
  const db = getDb();
  const now = new Date().toISOString();

  // 1. Expire relations past their TTL
  const expiredRows = db.prepare(
    `SELECT id FROM kg_relations WHERE expires_at < ?`
  ).all(now) as Array<{ id: number }>;

  if (!dryRun && expiredRows.length > 0) {
    const ids = expiredRows.map(r => r.id).join(",");
    db.exec(`DELETE FROM kg_relations WHERE id IN (${ids})`);
    console.log(`[KG-PRUNE] Deleted ${expiredRows.length} expired relations`);
  }

  // 2. Decay confidence on stale relations (not confirmed in >30 days)
  const staleRows = db.prepare(`
    SELECT id, confidence, last_confirmed
    FROM kg_relations
    WHERE last_confirmed < datetime('now', '-30 days')
    AND expires_at > ?
  `).all(now) as Array<{ id: number; confidence: number; last_confirmed: string }>;

  let decayed = 0;
  let markedExpiry = 0;

  for (const row of staleRows) {
    const daysSinceConfirm = Math.floor(
      (Date.now() - new Date(row.last_confirmed).getTime()) / (1000 * 60 * 60 * 24)
    );
    const periods = Math.floor(daysSinceConfirm / 30);
    const newConfidence = Math.max(0, row.confidence - periods * 0.1);

    if (!dryRun) {
      if (newConfidence < 0.3) {
        // Accelerate expiry for low-confidence relations
        db.prepare(
          `UPDATE kg_relations SET confidence = ?, expires_at = datetime('now', '+7 days') WHERE id = ?`
        ).run(newConfidence, row.id);
        markedExpiry++;
      } else {
        db.prepare(
          `UPDATE kg_relations SET confidence = ? WHERE id = ?`
        ).run(newConfidence, row.id);
      }
    }
    decayed++;
  }

  if (decayed > 0) {
    console.log(`[KG-PRUNE] Decayed ${decayed} relations (${markedExpiry} marked for early expiry)`);
  }

  return { expired: expiredRows.length, decayed, confirmed: 0 };
}

/**
 * Re-confirm a relation (reset confidence to 0.9, extend TTL 90 days).
 * Call this when a relation is observed again in new chunks.
 */
export function confirmRelation(sourceId: number, targetId: number, relationType: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE kg_relations
    SET confidence = 0.9,
        last_confirmed = datetime('now'),
        expires_at = datetime('now', '+90 days')
    WHERE source_entity_id = ? AND target_entity_id = ? AND relation_type = ?
  `).run(sourceId, targetId, relationType);
}

export function formatPruneResult(result: PruneResult): string {
  const lines = [
    `=== KG Prune Result ===`,
    `Expired (deleted): ${result.expired}`,
    `Confidence decayed: ${result.decayed}`,
  ];
  return lines.join("\n");
}

// ─── Decision Versioning ──────────────────────────────────────────────────────

export function ensureDecisionVersionTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS decision_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_key TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      content TEXT NOT NULL,
      source_file TEXT,
      author TEXT DEFAULT 'system',
      created_at TEXT DEFAULT (datetime('now')),
      superseded_at TEXT,
      is_current INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_dv_key ON decision_versions(decision_key);
    CREATE INDEX IF NOT EXISTS idx_dv_current ON decision_versions(decision_key, is_current);
  `);
}

export function upsertDecision(key: string, content: string, sourceFile?: string, author = "system"): number {
  ensureDecisionVersionTable();
  const db = getDb();

  // Mark previous version as superseded
  const prev = db.prepare(
    "SELECT id, version FROM decision_versions WHERE decision_key = ? AND is_current = 1"
  ).get(key) as { id: number; version: number } | undefined;

  const newVersion = prev ? prev.version + 1 : 1;

  if (prev) {
    db.prepare(
      "UPDATE decision_versions SET is_current = 0, superseded_at = datetime('now') WHERE id = ?"
    ).run(prev.id);
  }

  // Insert new version
  const result = db.prepare(`
    INSERT INTO decision_versions (decision_key, version, content, source_file, author)
    VALUES (?, ?, ?, ?, ?)
  `).run(key, newVersion, content, sourceFile ?? null, author);

  console.log(`[DECISION] ${key} → v${newVersion}${prev ? " (supersedes v" + prev.version + ")" : " (new)"}`);
  return newVersion;
}

export function getDecisionHistory(key: string): Array<{ version: number; content: string; created_at: string; superseded_at: string | null; is_current: number }> {
  ensureDecisionVersionTable();
  const db = getDb();
  return db.prepare(
    "SELECT version, content, created_at, superseded_at, is_current FROM decision_versions WHERE decision_key = ? ORDER BY version DESC"
  ).all(key) as Array<{ version: number; content: string; created_at: string; superseded_at: string | null; is_current: number }>;
}

export function getCurrentDecision(key: string): string | null {
  ensureDecisionVersionTable();
  const db = getDb();
  const row = db.prepare(
    "SELECT content FROM decision_versions WHERE decision_key = ? AND is_current = 1"
  ).get(key) as { content: string } | undefined;
  return row?.content ?? null;
}

export function listDecisions(): Array<{ decision_key: string; version: number; content: string; created_at: string }> {
  ensureDecisionVersionTable();
  const db = getDb();
  return db.prepare(
    "SELECT decision_key, version, content, created_at FROM decision_versions WHERE is_current = 1 ORDER BY created_at DESC"
  ).all() as Array<{ decision_key: string; version: number; content: string; created_at: string }>;
}
