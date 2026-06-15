// Fase 1.7b-c — Compiled Truth + Timeline Append-Only (paper "Claude Memory Setup")
//
// Parser for memory/entities/<type>/<entity>.md files following the 3-section format:
//
//   ---
//   name: Nox
//   description: Chief of Staff & COO
//   type: reference
//   ---
//
//   {Compiled truth — CURRENT best understanding. REWRITTEN as evidence changes.}
//
//   - Role: Chief of Staff & COO
//   - SessionKey: agent:nox:discord:channel:...
//
//   ---
//
//   ## Timeline
//
//   - **2026-04-21** — [user-feedback] operator confirmed delegation
//   - **2026-04-20** — [implementation] Heartbeat migrated
//
// Each file produces N+2 chunks: 1 frontmatter + 1 compiled + N timeline entries.

import { readFileSync } from "fs";
import { relative } from "path";
import Database from "better-sqlite3";
import { getDb } from "./db.js";
import { getInitialTier } from "./tier-manager.js";
import { resolveRetention } from "./retention.js";
import { inferPain, inferImportance } from "./salience.js";
import { redact as _redactPrivacy } from "./privacy/filter.js";

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || "/root/.openclaw/workspace";

export interface EntityFrontmatter {
  name?: string;
  description?: string;
  type?: string;
  [key: string]: unknown;
}

export interface ParsedEntity {
  frontmatter: EntityFrontmatter;
  frontmatterRaw: string;
  compiled: string;
  timeline: string[];
}

/**
 * Section boost values by section type. Multiplicative in search ranking but
 * applied additively when combined with tier/importance boosts to avoid
 * stacking (v3.4 lesson). Compiled is the current truth → highest weight.
 */
export const SECTION_BOOST: Record<string, number> = {
  compiled: 2.0,
  frontmatter: 1.5,
  timeline: 0.8,
};

/**
 * Parse an entity file into frontmatter + compiled truth + timeline entries.
 * Returns null if the file doesn't match the expected format (caller falls
 * back to regular ingest).
 *
 * Expected structure:
 *   1. YAML frontmatter block (--- ... ---) at top
 *   2. Compiled truth section (free-form markdown until "## Timeline" or EOF)
 *   3. Optional "## Timeline" section with `- **DATE** — [tag] description` bullets
 */
export function parseEntityFile(content: string): ParsedEntity | null {
  const normalized = content.replace(/\r\n/g, "\n");

  // Frontmatter — must be first thing in file
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) return null;

  const frontmatterRaw = fmMatch[1];
  const frontmatter = parseSimpleYaml(frontmatterRaw);

  const afterFm = normalized.slice(fmMatch[0].length);

  // Split on "## Timeline" heading (anywhere in the doc, case-insensitive)
  const timelineHeaderRe = /\n##\s+Timeline\s*\n/i;
  const timelineMatch = afterFm.match(timelineHeaderRe);

  let compiled: string;
  let timelineBlock: string;
  if (timelineMatch && typeof timelineMatch.index === "number") {
    compiled = afterFm.slice(0, timelineMatch.index).trim();
    timelineBlock = afterFm.slice(timelineMatch.index + timelineMatch[0].length);
  } else {
    compiled = afterFm.trim();
    timelineBlock = "";
  }

  // Timeline entries: each is a bullet starting with "- **DATE**" or "- DATE"
  const timeline: string[] = [];
  if (timelineBlock) {
    // Split on "\n- " but keep the bullet marker reconstructed
    const lines = timelineBlock.split(/\n(?=- )/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- ") && trimmed.length > 2) {
        timeline.push(trimmed);
      }
    }
  }

  return { frontmatter, frontmatterRaw, compiled, timeline };
}

/**
 * Minimal YAML frontmatter parser — handles `key: value` lines.
 * Does NOT handle nested structures, arrays, or multiline — keep entity
 * frontmatters flat per paper convention.
 */
function parseSimpleYaml(raw: string): EntityFrontmatter {
  const out: EntityFrontmatter = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, valRaw] = m;
    // Strip surrounding quotes if present
    let val: string | number | boolean = valRaw;
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val === "true") val = true as any;
    else if (val === "false") val = false as any;
    else if (/^-?\d+(\.\d+)?$/.test(val as string)) val = Number(val);
    out[key] = val;
  }
  return out;
}

/**
 * Ingest a single entity file as 1 frontmatter chunk + 1 compiled chunk
 * + N timeline chunks. All chunks share the same source_file relative path.
 *
 * chunk_type is inferred from directory:
 *   memory/entities/agents/   → 'person' (never-decay)
 *   memory/entities/projects/ → 'project' (365d retention)
 *   memory/entities/systems/  → 'other' (90d — system state evolves)
 *   memory/entities/people/   → 'person'
 */
export async function ingestEntityFile(
  filePath: string,
  externalDb?: Database.Database,
): Promise<{ parsed: boolean; chunks: number }> {
  const relPath = relative(WORKSPACE, filePath);
  const content = readFileSync(filePath, "utf-8");

  const entity = parseEntityFile(content);
  if (!entity) {
    return { parsed: false, chunks: 0 };
  }

  const db = externalDb ?? getDb();

  const chunkType = inferChunkTypeFromPath(relPath);
  const tier = getInitialTier(chunkType);
  const importance = inferImportance(chunkType);
  // Compiled truth represents user-declared current state → bump importance
  const compiledImportance = Math.max(importance, 0.9);
  const retentionDays = resolveRetention(chunkType, content);

  // Delete previous chunks from this file (idempotent re-ingest)
  db.prepare("DELETE FROM chunks WHERE source_file = ?").run(relPath);

  const insert = db.prepare(`
    INSERT INTO chunks (source_file, chunk_text, chunk_type, source_date, metadata, tier, importance, retention_days, pain, section, section_boost)
    VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
  `);

  const today = new Date().toISOString().slice(0, 10);

  let count = 0;
  db.transaction(() => {
    // 1. Frontmatter chunk
    let fmText = `---\n${entity.frontmatterRaw}\n---`;
    // Privacy filter: redact before INSERT (staged-privacy follow-up Wave Q)
    const _rFm = _redactPrivacy(fmText);
    fmText = _rFm.text;
    if (_rFm.redactionCount > 0) {
      console.warn(
        `[privacy-filter] redacted ${_rFm.redactionCount} secret(s) in entity frontmatter — kinds: ${_rFm.kinds.join(", ")}`
      );
    }
    insert.run(
      relPath, fmText, chunkType,
      JSON.stringify({ section: "frontmatter", entity: entity.frontmatter.name ?? null }),
      tier, importance, retentionDays, inferPain(chunkType, fmText),
      "frontmatter", SECTION_BOOST.frontmatter,
    );
    count++;

    // 2. Compiled truth chunk — single chunk, the "current state"
    if (entity.compiled) {
      let compiledText = entity.compiled;
      // Privacy filter: redact before INSERT (staged-privacy follow-up Wave Q)
      const _rCo = _redactPrivacy(compiledText);
      compiledText = _rCo.text;
      if (_rCo.redactionCount > 0) {
        console.warn(
          `[privacy-filter] redacted ${_rCo.redactionCount} secret(s) in entity compiled — kinds: ${_rCo.kinds.join(", ")}`
        );
      }
      insert.run(
        relPath, compiledText, chunkType,
        JSON.stringify({ section: "compiled", entity: entity.frontmatter.name ?? null, recompiled_at: today }),
        tier, compiledImportance, retentionDays, inferPain(chunkType, compiledText),
        "compiled", SECTION_BOOST.compiled,
      );
      count++;
    }

    // 3. Timeline entries — one chunk each, reverse-chronological preserved as-is
    for (const entry of entity.timeline) {
      let entryText = entry;
      // Privacy filter: redact before INSERT (staged-privacy follow-up Wave Q)
      const _rTl = _redactPrivacy(entryText);
      entryText = _rTl.text;
      if (_rTl.redactionCount > 0) {
        console.warn(
          `[privacy-filter] redacted ${_rTl.redactionCount} secret(s) in entity timeline — kinds: ${_rTl.kinds.join(", ")}`
        );
      }
      insert.run(
        relPath, entryText, chunkType,
        JSON.stringify({ section: "timeline", entity: entity.frontmatter.name ?? null }),
        tier, importance, retentionDays, inferPain(chunkType, entryText),
        "timeline", SECTION_BOOST.timeline,
      );
      count++;
    }
  })();

  if (!externalDb) db.close();

  return { parsed: true, chunks: count };
}

function inferChunkTypeFromPath(relPath: string): string {
  if (/entities\/agents\//.test(relPath)) return "person";
  if (/entities\/projects\//.test(relPath)) return "project";
  if (/entities\/people\//.test(relPath)) return "person";
  if (/entities\/systems\//.test(relPath)) return "other";
  return "other";
}
