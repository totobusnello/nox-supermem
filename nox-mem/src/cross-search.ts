/**
 * cross-search.ts — Search across ALL agent memory databases
 * Enables any agent to query memories from other agents
 */
import Database from "better-sqlite3";
import { resolve } from "path";
import { existsSync } from "fs";

// NOX_AGENTS_DIR: base directory for agent sub-dirs. Defaults to the OpenClaw layout.
// NOX_AGENTS: comma-separated agent name list.
// NOX_WORKSPACE_DB: explicit path to the workspace DB (overrides OPENCLAW_WORKSPACE derivation).
// When AGENTS_DIR doesn't exist on disk, searchInDb() already returns [] via existsSync guard.
const _WORKSPACE = process.env.OPENCLAW_WORKSPACE ?? "/root/.openclaw/workspace";
const AGENTS_DIR = process.env.NOX_AGENTS_DIR ?? "/root/.openclaw/agents";
const WORKSPACE_DB = process.env.NOX_WORKSPACE_DB ?? resolve(_WORKSPACE, "tools/nox-mem/nox-mem.db");
const AGENT_NAMES = process.env.NOX_AGENTS
  ? process.env.NOX_AGENTS.split(",").map(s => s.trim()).filter(Boolean)
  : ["nox", "atlas", "boris", "cipher", "forge", "lex"];

export interface CrossSearchResult {
  agent: string;
  score: number;
  source_file: string;
  chunk_type: string;
  chunk_text: string;
  source_date: string | null;
}

function getAgentDbPath(agent: string): string {
  return resolve(AGENTS_DIR, agent, "tools", "nox-mem", "nox-mem.db");
}

function searchInDb(dbPath: string, agentName: string, query: string, limit: number): CrossSearchResult[] {
  if (!existsSync(dbPath)) return [];
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const sanitized = query.replace(/['"{}()\[\]:*^~&|!]/g, " ").trim();
    if (!sanitized) return [];

    const rows = db.prepare(`
      SELECT c.source_file, c.chunk_type, c.chunk_text, c.source_date,
             bm25(chunks_fts, 1.0, 0.5, 0.5) as rank
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH ?
      ORDER BY rank LIMIT ?
    `).all(sanitized, limit) as Array<{
      source_file: string; chunk_type: string; chunk_text: string;
      source_date: string | null; rank: number;
    }>;

    return rows.map(r => ({
      agent: agentName,
      score: Math.round(Math.abs(r.rank) * 100) / 100,
      source_file: r.source_file,
      chunk_type: r.chunk_type,
      chunk_text: r.chunk_text,
      source_date: r.source_date,
    }));
  } catch (err) {
    console.error(`[WARN] Failed to search ${agentName}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  } finally {
    if (db) db.close();
  }
}

export function crossSearch(query: string, limit: number = 10): CrossSearchResult[] {
  const allResults: CrossSearchResult[] = [];

  // Search workspace
  allResults.push(...searchInDb(WORKSPACE_DB, "workspace", query, limit));

  // Search all agent DBs
  for (const agent of AGENT_NAMES) {
    const dbPath = getAgentDbPath(agent);
    allResults.push(...searchInDb(dbPath, agent, query, limit));
  }

  // Sort by score descending, deduplicate by content similarity
  allResults.sort((a, b) => b.score - a.score);

  // Simple dedup: skip if same first 100 chars exist
  const seen = new Set<string>();
  const deduped: CrossSearchResult[] = [];
  for (const r of allResults) {
    const key = r.chunk_text.substring(0, 100);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(r);
    }
  }

  return deduped.slice(0, limit);
}

export function formatCrossResults(results: CrossSearchResult[]): string {
  if (results.length === 0) return "No results found across agents.";
  return results
    .map((r, i) => {
      const preview = r.chunk_text.substring(0, 200).replace(/\n/g, " ");
      return `#${i + 1} [${r.score} @${r.agent}] ${r.source_file}\n   "${preview}..."`;
    })
    .join("\n\n");
}

export function getCrossStats(): string {
  const stats: string[] = ["=== Cross-Agent Memory Stats ===\n"];

  // Workspace
  try {
    const db = new Database(WORKSPACE_DB, { readonly: true });
    const count = (db.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;
    stats.push(`workspace: ${count} chunks`);
    db.close();
  } catch { stats.push("workspace: unavailable"); }

  // Agents
  for (const agent of AGENT_NAMES) {
    const dbPath = getAgentDbPath(agent);
    try {
      if (!existsSync(dbPath)) { stats.push(`${agent}: no DB`); continue; }
      const db = new Database(dbPath, { readonly: true });
      const count = (db.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;
      stats.push(`${agent}: ${count} chunks`);
      db.close();
    } catch { stats.push(`${agent}: error`); }
  }

  return stats.join("\n");
}
