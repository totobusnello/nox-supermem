// E06 (2026-05-03): detect-changes — git diff --name-only <since> HEAD + identifica entidades KG afetadas.
// Read-only: zero mutation. Útil pra pré-commit hooks detectando entities que mudaram.

import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { getDb } from "./db.js";

// SEC-FIX 2026-05-03: repo allowlist (mesma idea do api-impact)
// NOX_DETECT_CHANGES_REPO_ALLOWLIST: comma-separated absolute paths that are
// permitted as `repo` arguments. Defaults to the canonical workspace root.
// Override to add additional trusted repos (e.g. /home/user/my-repo).
const REPO_ALLOWLIST = (process.env.NOX_DETECT_CHANGES_REPO_ALLOWLIST ?? "/root/.openclaw/workspace")
  .split(",").map((s) => s.trim()).filter(Boolean);

function validateRepo(repo: string): string {
  const real = fs.realpathSync(repo);
  const ok = REPO_ALLOWLIST.some((prefix) => {
    try {
      const realPrefix = fs.realpathSync(prefix);
      return real === realPrefix || real.startsWith(realPrefix + path.sep);
    } catch { return false; }
  });
  if (!ok) throw new Error(`Repo not in allowlist: ${real}. Set NOX_DETECT_CHANGES_REPO_ALLOWLIST or use a path under: ${REPO_ALLOWLIST.join(", ")}`);
  return real;
}

// SEC-FIX HIGH #4: validate that resolved abs path is contained within repo (defends against ../../../etc/passwd in git history)
function safePathJoin(repo: string, relPath: string): string | null {
  const abs = path.resolve(repo, relPath);
  const realRepo = fs.realpathSync(repo);
  // Note: realpathSync would fail if abs doesn't exist (deleted file in diff). Use logical containment check.
  const normalized = path.resolve(abs);
  if (!normalized.startsWith(realRepo + path.sep) && normalized !== realRepo) return null;
  return normalized;
}

export interface ChangedFile {
  path: string;
  status: string; // M, A, D, R, etc
  is_entity_file: boolean;
  entity_type?: string;
  entity_slug?: string;
}

export interface AffectedEntity {
  name: string;
  type: string;
  mention_count: number;
  source_files: string[];
  via: 'entity_file' | 'chunk_reference';
}

export interface DetectChangesResult {
  since: string;
  head: string;
  repo: string;
  files_changed: number;
  files: ChangedFile[];
  affected_entities: AffectedEntity[];
  scanned_chunks: number;
  duration_ms: number;
}

// SEC-FIX CRITICAL #2: execFileSync with array args (no shell expansion)
function gitCmd(repo: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).trim();
  } catch (e: any) {
    throw new Error(`git ${args.join(" ")} failed in ${repo}: ${e.message?.split("\n")[0] || e}`);
  }
}

function parseDiffNameStatus(out: string): Array<{ status: string; path: string }> {
  if (!out) return [];
  return out.split("\n").map((line) => {
    const parts = line.split("\t");
    return { status: parts[0]?.[0] || "?", path: parts[parts.length - 1] || "" };
  }).filter((f) => f.path);
}

const ENTITY_PATH_RE = /^memory\/entities\/([^/]+)\/([^/]+)\.md$/;

function detectEntityFile(filePath: string): { type: string; slug: string } | null {
  const m = filePath.match(ENTITY_PATH_RE);
  if (!m) return null;
  return { type: m[1], slug: m[2] };
}

function readFrontmatterName(absPath: string): string | null {
  try {
    if (!fs.existsSync(absPath)) return null;
    const head = fs.readFileSync(absPath, "utf8").substring(0, 2000);
    const fm = head.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fm) return null;
    const nameMatch = fm[1].match(/^name:\s*(.+)$/m);
    return nameMatch ? nameMatch[1].trim() : null;
  } catch {
    return null;
  }
}

export function detectChanges(opts: { since: string; repo: string }): DetectChangesResult {
  const start = Date.now();
  // SEC-FIX HIGH #4: confine repo path via realpath + allowlist
  if (!fs.existsSync(opts.repo)) throw new Error(`Repo path does not exist: ${opts.repo}`);
  const repo = validateRepo(opts.repo);

  if (!fs.existsSync(path.join(repo, ".git"))) {
    throw new Error(`Not a git repo: ${repo}`);
  }

  // SEC-FIX HIGH (since arg validation): defensive — allowed git ref chars only (alphanumeric + . / - _ ~ ^ : @ {})
  if (!/^[a-zA-Z0-9._/~^:@{}-]+$/.test(opts.since)) {
    throw new Error(`Invalid 'since' ref (allowed: alphanumeric + . / - _ ~ ^ : @ { }): ${opts.since}`);
  }

  const head = gitCmd(repo, ["rev-parse", "HEAD"]);
  const sinceResolved = gitCmd(repo, ["rev-parse", opts.since]);
  const diffOut = gitCmd(repo, ["diff", "--name-status", `${sinceResolved}...HEAD`]);
  const rawFiles = parseDiffNameStatus(diffOut);

  const files: ChangedFile[] = rawFiles.map((f) => {
    const ent = detectEntityFile(f.path);
    return {
      path: f.path,
      status: f.status,
      is_entity_file: !!ent,
      entity_type: ent?.type,
      entity_slug: ent?.slug,
    };
  });

  const db = getDb();
  const entityMap = new Map<string, AffectedEntity>();

  // Path 1: entity files diretos — resolve slug → name via frontmatter ou kg_entities lookup
  for (const f of files) {
    if (!f.is_entity_file || !f.entity_type || !f.entity_slug) continue;
    // SEC-FIX HIGH #4: bloqueia ../../../etc/passwd via path containment check
    const absPath = safePathJoin(repo, f.path);
    if (!absPath) continue; // path escapes repo, skip
    const fmName = readFrontmatterName(absPath);
    const candidates: string[] = fmName ? [fmName] : [];
    candidates.push(f.entity_slug.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/-/g, " "));

    let resolved: { name: string; entity_type: string; mention_count: number } | undefined;
    for (const cand of candidates) {
      const row = db.prepare(
        "SELECT name, entity_type, mention_count FROM kg_entities WHERE LOWER(name) = LOWER(?) LIMIT 1"
      ).get(cand) as any;
      if (row) { resolved = row; break; }
    }
    const key = resolved?.name || candidates[0];
    if (!entityMap.has(key)) {
      entityMap.set(key, {
        name: key,
        type: resolved?.entity_type || f.entity_type,
        mention_count: resolved?.mention_count || 0,
        source_files: [],
        via: 'entity_file',
      });
    }
    const e = entityMap.get(key)!;
    if (!e.source_files.includes(f.path)) e.source_files.push(f.path);
  }

  // Path 2: chunks que vieram desses files → entidades mencionadas via evidence_chunk_id
  // CODE-FIX HIGH: SQLite SQLITE_MAX_VARIABLE_NUMBER=999 default → batch em chunks de 500
  let scannedChunks = 0;
  const filePaths = files.map((f) => f.path);
  const BATCH = 500;
  function chunked<T>(arr: T[], n: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }
  if (filePaths.length > 0) {
    const allChunkIds: number[] = [];
    for (const batch of chunked(filePaths, BATCH)) {
      const placeholders = batch.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT id FROM chunks WHERE source_file IN (${placeholders})`
      ).all(...batch) as Array<{ id: number }>;
      for (const r of rows) allChunkIds.push(r.id);
    }
    scannedChunks = allChunkIds.length;

    if (allChunkIds.length > 0) {
      for (const batch of chunked(allChunkIds, BATCH)) {
        const chPlace = batch.map(() => "?").join(",");
        const refs = db.prepare(
          `SELECT DISTINCT e.name, e.entity_type, e.mention_count, c.source_file
           FROM kg_entities e
           JOIN kg_relations r ON r.source_entity_id = e.id OR r.target_entity_id = e.id
           JOIN chunks c ON c.id = r.evidence_chunk_id
           WHERE r.evidence_chunk_id IN (${chPlace})`
        ).all(...batch) as Array<{ name: string; entity_type: string; mention_count: number; source_file: string }>;

        for (const r of refs) {
          if (!entityMap.has(r.name)) {
            entityMap.set(r.name, {
              name: r.name,
              type: r.entity_type,
              mention_count: r.mention_count,
              source_files: [],
              via: 'chunk_reference',
            });
          }
          const e = entityMap.get(r.name)!;
          if (!e.source_files.includes(r.source_file)) e.source_files.push(r.source_file);
        }
      }
    }
  }

  const affected = Array.from(entityMap.values()).sort((a, b) => b.mention_count - a.mention_count);

  return {
    since: sinceResolved.substring(0, 8),
    head: head.substring(0, 8),
    repo,
    files_changed: files.length,
    files,
    affected_entities: affected,
    scanned_chunks: scannedChunks,
    duration_ms: Date.now() - start,
  };
}

export function formatDetectChanges(r: DetectChangesResult, mode: 'json' | 'text' = 'text'): string {
  if (mode === 'json') return JSON.stringify(r, null, 2);
  const lines: string[] = [];
  lines.push(`## detect-changes (${r.since}...${r.head})`);
  lines.push(`Repo: ${r.repo}`);
  lines.push(`Files changed: ${r.files_changed} | Chunks scanned: ${r.scanned_chunks} | Duration: ${r.duration_ms}ms`);
  lines.push(``);
  if (r.files_changed === 0) {
    lines.push(`(no changes)`);
    return lines.join("\n");
  }
  const entityFiles = r.files.filter((f) => f.is_entity_file);
  if (entityFiles.length > 0) {
    lines.push(`### Entity files (${entityFiles.length})`);
    for (const f of entityFiles) lines.push(`  ${f.status} ${f.path}  →  ${f.entity_type}/${f.entity_slug}`);
    lines.push(``);
  }
  const otherFiles = r.files.filter((f) => !f.is_entity_file);
  if (otherFiles.length > 0) {
    lines.push(`### Other files (${otherFiles.length})`);
    for (const f of otherFiles.slice(0, 20)) lines.push(`  ${f.status} ${f.path}`);
    if (otherFiles.length > 20) lines.push(`  ... +${otherFiles.length - 20} more`);
    lines.push(``);
  }
  if (r.affected_entities.length > 0) {
    lines.push(`### Affected entities (${r.affected_entities.length})`);
    for (const e of r.affected_entities.slice(0, 20)) {
      lines.push(`  [${e.type}] ${e.name} (${e.mention_count} mentions, via=${e.via}, src=${e.source_files.length})`);
    }
    if (r.affected_entities.length > 20) lines.push(`  ... +${r.affected_entities.length - 20} more`);
  } else {
    lines.push(`### Affected entities: 0 (changes don't touch indexed entities)`);
  }
  return lines.join("\n");
}
