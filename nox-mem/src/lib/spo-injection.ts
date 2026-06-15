// E03a — Entity-Facts SPO Injection (`<vault-facts>` block)
// 2026-05-02 impl. Spec: specs/2026-05-01-E03a-spo-injection.md
//
// Read-only KG → context surface. Top-K SPO triples surfaced as XML-like
// block, injected as `vaultFacts` field in /api/search response (envelope).
//
// Schema reality: kg_relations uses FK ids (source_entity_id, target_entity_id,
// relation_type) — NOT inline strings as spec assumed. JOIN with kg_entities
// resolves names.
//
// Modes (env NOX_VAULT_FACTS_MODE):
//   off     — disabled, no compute, no surface
//   shadow  — compute + log telemetry, but DO NOT surface in response (default v1)
//   active  — compute + log + surface in response (E03b activate after 7d)

import Database from "better-sqlite3";

export type VaultFactsMode = "off" | "shadow" | "active";

export interface VaultTriple {
  subject: string;
  relation: string;
  object: string;
  confidence: number | null;
  reason?: string | null; // E05: edge typing FULL — populated when relation_reason != 'unknown'
}

const TOKEN_BUDGET = {
  balanced: 200,
  deep: 250,
} as const;

const DEEP_MARKER = /(?<=^|\s)(explicar?|como funciona|por qu[eê]|deep dive|detalh)(?=\s|[.,?!]|$)/i;

const APPROX_TOKENS_PER_TRIPLE = 25;

export function getMode(): VaultFactsMode {
  const v = (process.env.NOX_VAULT_FACTS_MODE || "shadow").toLowerCase();
  if (v === "off" || v === "shadow" || v === "active") return v;
  return "shadow";
}

export function getK(): number {
  const v = parseInt(process.env.NOX_VAULT_FACTS_K || "8", 10);
  if (Number.isNaN(v) || v < 1 || v > 32) return 8;
  return v;
}

export function pickBudget(query: string): number {
  return DEEP_MARKER.test(query) ? TOKEN_BUDGET.deep : TOKEN_BUDGET.balanced;
}

/**
 * Match query tokens against kg_entities.name (case-insensitive exact match).
 * v1 minimal: no NER, no fuzzy. Returns deduped list of matched entity names.
 */
export function extractCandidateEntities(query: string, db: Database.Database): string[] {
  const tokens = query
    .toLowerCase()
    .split(/[\s,;.!?()[\]{}'"]+/)
    .filter((t) => t.length >= 2)
    .slice(0, 32); // hard limit to bound query size
  if (tokens.length === 0) return [];

  const placeholders = tokens.map(() => "?").join(",");
  const stmt = db.prepare(
    `SELECT DISTINCT name FROM kg_entities WHERE LOWER(name) IN (${placeholders})`
  );
  const rows = stmt.all(...tokens) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * Lookup top-K SPO triples touching given entity names.
 * JOIN with kg_entities to resolve FK ids → names.
 * ORDER BY confidence DESC NULLS LAST, then created_at DESC.
 */
export function lookupTopK(
  entityNames: string[],
  db: Database.Database,
  k: number
): VaultTriple[] {
  if (entityNames.length === 0) return [];
  const placeholders = entityNames.map(() => "?").join(",");
  const sql = `
    SELECT
      src.name AS subject,
      r.relation_type AS relation,
      tgt.name AS object,
      r.confidence AS confidence,
      r.relation_reason AS reason
    FROM kg_relations r
    JOIN kg_entities src ON r.source_entity_id = src.id
    JOIN kg_entities tgt ON r.target_entity_id = tgt.id
    WHERE src.name IN (${placeholders}) OR tgt.name IN (${placeholders})
    ORDER BY
      CASE WHEN r.relation_reason = 'unknown' OR r.relation_reason IS NULL THEN 1 ELSE 0 END,
      CASE WHEN r.confidence IS NULL THEN 1 ELSE 0 END,
      r.confidence DESC,
      r.created_at DESC
    LIMIT ?
  `;
  const stmt = db.prepare(sql);
  const rows = stmt.all(...entityNames, ...entityNames, k) as VaultTriple[];
  return rows;
}

/**
 * Format triples as <vault-facts> XML-like block.
 * Returns null if no triples (avoid empty block).
 * Truncates each field to 80 chars to bound token usage.
 */
export function formatVaultFacts(triples: VaultTriple[]): string | null {
  if (triples.length === 0) return null;
  const lines = triples.map((t) => {
    const subject = sanitize(t.subject).slice(0, 80);
    const relation = sanitize(t.relation).slice(0, 40);
    const object = sanitize(t.object).slice(0, 80);
    // E05: append reason annotation when classified (omit 'unknown' to keep output clean)
    const reason = t.reason && t.reason !== 'unknown' ? ` [${sanitize(t.reason).slice(0, 20)}]` : '';
    return `${subject} ${relation} ${object}${reason}`;
  });
  return `<vault-facts>\n${lines.join("\n")}\n</vault-facts>`;
}

/**
 * Sanitize a KG field — collapse whitespace, strip newlines and angle brackets.
 * Prevents prompt injection via second-order data (e.g. KG value containing
 * `</vault-facts>` to escape the block). Security review M1 (2026-05-02).
 */
function sanitize(s: string): string {
  return s.replace(/[<>\n\r]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Estimate token usage roughly (chars/4 heuristic).
 * Used to enforce budget cap.
 */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/**
 * Trim triples list to fit token budget.
 */
export function applyBudget(triples: VaultTriple[], budget: number): VaultTriple[] {
  const trimmed: VaultTriple[] = [];
  let totalTokens = 20; // wrapper overhead (<vault-facts>...</vault-facts>)
  for (const t of triples) {
    const tripleTokens = APPROX_TOKENS_PER_TRIPLE;
    if (totalTokens + tripleTokens > budget) break;
    trimmed.push(t);
    totalTokens += tripleTokens;
  }
  return trimmed;
}

/**
 * Top-level orchestrator. Returns VaultFacts result or null if disabled/empty.
 * Logs telemetry when enabled (shadow or active).
 */
export interface VaultFactsResult {
  block: string | null;
  mode: VaultFactsMode;
  surface: boolean; // true if should be returned to client (active mode + non-null block)
  entities: number;
  triples: number;
  tokens: number;
  budget: number;
}

export function getVaultFacts(query: string, db: Database.Database): VaultFactsResult {
  const mode = getMode();
  const budget = pickBudget(query);

  if (mode === "off") {
    return { block: null, mode, surface: false, entities: 0, triples: 0, tokens: 0, budget };
  }

  const entities = extractCandidateEntities(query, db);
  if (entities.length === 0) {
    logTelemetry(query, mode, 0, 0, 0, budget);
    return { block: null, mode, surface: false, entities: 0, triples: 0, tokens: 0, budget };
  }

  const k = getK();
  const triples = lookupTopK(entities, db, k);
  const trimmed = applyBudget(triples, budget);
  const block = formatVaultFacts(trimmed);
  const tokens = block ? estimateTokens(block) : 0;

  logTelemetry(query, mode, entities.length, trimmed.length, tokens, budget);

  const surface = mode === "active" && block !== null;
  return {
    block,
    mode,
    surface,
    entities: entities.length,
    triples: trimmed.length,
    tokens,
    budget,
  };
}

function logTelemetry(
  query: string,
  mode: VaultFactsMode,
  entities: number,
  triples: number,
  tokens: number,
  budget: number
): void {
  if (process.env.NOX_VAULT_FACTS_LOG !== "1") return;
  const safeQuery = query.replace(/[\r\n"]/g, " ").slice(0, 100);
  // eslint-disable-next-line no-console
  console.log(
    `[vault-facts] mode=${mode} query="${safeQuery}" entities=${entities} triples=${triples} tokens=${tokens} budget=${budget}`
  );
}
