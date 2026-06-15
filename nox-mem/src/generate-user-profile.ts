#!/usr/bin/env node
/**
 * generate-user-profile.ts — Fase 1.7a
 *
 * Generates `shared/USER-PROFILE.md` from KG + chunks. Agents read this file
 * at boot to have rich context without a search round-trip each turn.
 *
 * Sections:
 *   1. Top 20 entities (by mention_count) with relevant attributes
 *   2. Active projects (status != closed)
 *   3. Decisions in the last 30 days
 *   4. Declared preferences (chunks of type lesson/preference)
 *
 * Run: node dist/generate-user-profile.js
 * NOX_PROFILE_OUTPUT: optional absolute path for the output file.
 *   Defaults to $OPENCLAW_WORKSPACE/shared/USER-PROFILE.md (or ./USER-PROFILE.md).
 */

import { getDb, closeDb } from "./db.js";
import { writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";

interface EntityRow {
  id: number;
  name: string;
  entity_type: string;
  mention_count: number;
  attributes: string | null;
  last_seen: string;
}

interface ChunkRow {
  id: number;
  chunk_text: string;
  chunk_type: string;
  source_date: string | null;
  source_file: string;
}

function parseAttrs(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try { return JSON.parse(json) as Record<string, unknown>; } catch { return {}; }
}

function formatAttrs(attrs: Record<string, unknown>, keys: string[]): string {
  const parts: string[] = [];
  for (const k of keys) {
    const v = attrs[k];
    if (v !== undefined && v !== null && v !== "") parts.push(`${k}: ${String(v)}`);
  }
  return parts.join(" · ");
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}\n`;
}

export function generateUserProfile(): string {
  const db = getDb();
  const nowIso = new Date().toISOString().split("T")[0];

  // ─── Top 20 entidades ────────────────────────────────────────────────
  const topEntities = db.prepare(`
    SELECT id, name, entity_type, mention_count, attributes, last_seen
    FROM kg_entities
    ORDER BY mention_count DESC
    LIMIT 20
  `).all() as EntityRow[];

  const topByType: Record<string, EntityRow[]> = {};
  for (const e of topEntities) {
    if (!topByType[e.entity_type]) topByType[e.entity_type] = [];
    topByType[e.entity_type].push(e);
  }

  const topFmt = Object.entries(topByType)
    .map(([type, ents]) => {
      const lines = ents.map((e) => {
        const a = parseAttrs(e.attributes);
        const attrKeys = type === "person"
          ? ["role", "organization", "email", "whatsapp_number"]
          : type === "project"
          ? ["status", "stage", "value_brl", "value_usd", "key_person", "industry"]
          : type === "organization"
          ? ["type", "country", "sector"]
          : type === "document"
          ? ["doc_type", "date", "parties"]
          : ["category", "domain"];
        const details = formatAttrs(a, attrKeys);
        return `- **${e.name}** (${e.mention_count} mentions)${details ? " — " + details : ""}`;
      }).join("\n");
      return `### ${type}s\n${lines}`;
    })
    .join("\n\n");

  // ─── Projects ativos ─────────────────────────────────────────────────
  const activeProjects = db.prepare(`
    SELECT id, name, entity_type, mention_count, attributes, last_seen
    FROM kg_entities
    WHERE entity_type = 'project'
    ORDER BY mention_count DESC
    LIMIT 30
  `).all() as EntityRow[];

  const activeFiltered = activeProjects.filter((p) => {
    const a = parseAttrs(p.attributes);
    return a.status !== "closed" && a.status !== "completed";
  });

  const projectsFmt = activeFiltered.length > 0
    ? activeFiltered.slice(0, 15).map((p) => {
        const a = parseAttrs(p.attributes);
        const details = formatAttrs(a, ["status", "stage", "value_brl", "value_usd", "key_person", "industry", "ebitda_multiple"]);
        return `- **${p.name}** (${p.mention_count}m)${details ? " — " + details : ""}`;
      }).join("\n")
    : "_(nenhum project com status explícito — rodar kg-build pra enriquecer)_";

  // ─── Decisões últimos 30 dias ────────────────────────────────────────
  const decisions = db.prepare(`
    SELECT id, chunk_text, chunk_type, source_date, source_file
    FROM chunks
    WHERE chunk_type = 'decision'
      AND source_date >= date('now', '-30 days')
    ORDER BY source_date DESC
    LIMIT 15
  `).all() as ChunkRow[];

  const decisionsFmt = decisions.length > 0
    ? decisions.map((d) => {
        const summary = d.chunk_text.substring(0, 150).replace(/\n/g, " ");
        return `- [${d.source_date}] ${summary}${d.chunk_text.length > 150 ? "..." : ""}`;
      }).join("\n")
    : "_(nenhuma decisão registrada nos últimos 30 dias)_";

  // ─── Preferências declaradas ─────────────────────────────────────────
  const prefs = db.prepare(`
    SELECT id, chunk_text, chunk_type, source_date, source_file
    FROM chunks
    WHERE chunk_type IN ('lesson', 'preference', 'pattern')
    ORDER BY source_date DESC
    LIMIT 20
  `).all() as ChunkRow[];

  const prefsFmt = prefs.length > 0
    ? prefs.map((p) => {
        const summary = p.chunk_text.substring(0, 200).replace(/\n/g, " ");
        return `- [${p.chunk_type}] ${summary}${p.chunk_text.length > 200 ? "..." : ""}`;
      }).join("\n")
    : "_(nenhuma preferência/lição registrada)_";

  // ─── Monta documento ─────────────────────────────────────────────────
  const stats = db.prepare(`
    SELECT COUNT(*) as total FROM kg_entities
  `).get() as { total: number };

  const md = `# USER-PROFILE.md (auto-generated ${nowIso})

> Generated by \`generate-user-profile.ts\`. Do not edit manually — next run overwrites.
> KG: ${stats.total} entities.

${section("Top 20 entities by mention count", topFmt)}
${section("Active projects", projectsFmt)}
${section("Decisions (last 30 days)", decisionsFmt)}
${section("Preferences / declared lessons", prefsFmt)}

---

_End of USER-PROFILE. Regenerates weekly via cron._
`;

  return md;
}

// CLI
// NOX_PROFILE_OUTPUT: explicit output path (takes precedence).
// Falls back to $OPENCLAW_WORKSPACE/shared/USER-PROFILE.md, then ./USER-PROFILE.md.
const _ws = process.env.OPENCLAW_WORKSPACE;
const outputPath = process.env.NOX_PROFILE_OUTPUT
  ?? (_ws ? resolve(_ws, "shared", "USER-PROFILE.md") : resolve(process.cwd(), "USER-PROFILE.md"));

try {
  mkdirSync(dirname(outputPath), { recursive: true });
  const md = generateUserProfile();
  writeFileSync(outputPath, md, "utf-8");
  console.log(`[USER-PROFILE] Generated: ${outputPath} (${md.length} bytes)`);
  closeDb();
} catch (err) {
  console.error(`[USER-PROFILE] Failed: ${(err as Error).message}`);
  closeDb();
  process.exit(1);
}
