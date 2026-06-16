// E08 (2026-05-03): api-impact — multi-arquivo grep + import graph pra signature changes.
// Read-only, scope = source code repo (não corpus de memória).

import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

// SEC-FIX 2026-05-03: scope allowlist (prefix paths permitidos pra grep — bloqueia /etc/, /root/.openclaw/.env, etc)
const _defaultWorkspace = process.env.OPENCLAW_WORKSPACE ?? "/root/.openclaw/workspace";
const SCOPE_ALLOWLIST = (process.env.NOX_API_IMPACT_SCOPE_ALLOWLIST ?? _defaultWorkspace)
  .split(",").map((s) => s.trim()).filter(Boolean);

function validateScope(scope: string): string {
  const real = fs.realpathSync(scope);
  const ok = SCOPE_ALLOWLIST.some((prefix) => {
    try {
      const realPrefix = fs.realpathSync(prefix);
      return real === realPrefix || real.startsWith(realPrefix + path.sep);
    } catch { return false; }
  });
  if (!ok) throw new Error(`Scope not in allowlist: ${real}. Set NOX_API_IMPACT_SCOPE_ALLOWLIST or use a path under: ${SCOPE_ALLOWLIST.join(", ")}`);
  return real;
}

// Validate extensions: alphanum only, no shell metachars
function validateExtensions(extensions: string[]): string[] {
  const re = /^[a-zA-Z0-9]+$/;
  for (const e of extensions) {
    if (!re.test(e)) throw new Error(`Invalid extension (alphanum only): ${e}`);
  }
  return extensions;
}

export interface FileMatch {
  file: string;
  total_refs: number;
  import_lines: number;
  usage_lines: number;
  is_definition_file: boolean;
  sample_lines: Array<{ line: number; text: string; kind: 'import' | 'usage' | 'definition' }>;
}

export interface ApiImpactResult {
  signature: string;
  scope: string;
  extensions: string[];
  files_scanned: number;
  files_affected: number;
  total_refs: number;
  total_imports: number;
  total_usages: number;
  matches: FileMatch[];
  duration_ms: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function classifyLine(text: string, signature: string): 'import' | 'definition' | 'usage' {
  const t = text.trim();
  if (/^\s*(import|from)\b/.test(t) || /\brequire\s*\(/.test(t)) return 'import';
  const sig = escapeRegex(signature);
  // Definitions: function/class/const/let/var/export pattern
  const defRe = new RegExp(`\\b(function|class|interface|type|enum|const|let|var|export\\s+(default\\s+)?(function|class|interface|type|const|let|var)?)\\s+${sig}\\b`);
  if (defRe.test(t)) return 'definition';
  return 'usage';
}

export function computeApiImpact(opts: { signature: string; scope: string; extensions?: string[] }): ApiImpactResult {
  const start = Date.now();
  if (!fs.existsSync(opts.scope)) throw new Error(`Scope path does not exist: ${opts.scope}`);
  // SEC-FIX CRITICAL #1 + HIGH #3: scope confined via realpath + allowlist (blocks /etc, /root/.openclaw/.env, etc)
  const scope = validateScope(opts.scope);
  const extensions = validateExtensions(
    opts.extensions && opts.extensions.length > 0
      ? opts.extensions
      : ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py']
  );

  // SEC-FIX CRITICAL #1: defensive signature validation (no shell metachars)
  if (/[`$;|&<>(){}\\"']/.test(opts.signature)) {
    throw new Error(`Signature contains forbidden characters (shell metachars not allowed): ${opts.signature}`);
  }

  const sig = escapeRegex(opts.signature);
  const pattern = `\\b${sig}\\b`;

  // SEC-FIX CRITICAL #1: execFileSync with array args — zero shell expansion
  const grepArgs: string[] = [
    "-RnE",
    ...extensions.map((e) => `--include=*.${e}`),
    "--exclude-dir=node_modules", "--exclude-dir=dist", "--exclude-dir=.git",
    "--exclude-dir=build", "--exclude-dir=.next", "--exclude-dir=coverage",
    pattern,
    scope,
  ];

  let raw = "";
  try {
    raw = execFileSync("grep", grepArgs, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, timeout: 60_000 });
  } catch (e: any) {
    if (e.status === 1) raw = ""; // exit 1 = no matches, OK
    else throw new Error(`grep failed: ${e.message?.split("\n")[0] || e.code || e}`);
  }

  const fileMap = new Map<string, FileMatch>();
  let filesScanned = 0;

  // SEC-FIX CRITICAL #1: execFileSync find with array args (no shell)
  try {
    const findArgs: string[] = [scope, "-type", "d", "(", "-name", "node_modules", "-o", "-name", "dist", "-o", "-name", ".git", "-o", "-name", "build", "-o", "-name", ".next", "-o", "-name", "coverage", ")", "-prune", "-o", "-type", "f", "("];
    extensions.forEach((e, i) => {
      if (i > 0) findArgs.push("-o");
      findArgs.push("-name", `*.${e}`);
    });
    findArgs.push(")", "-print");
    const findOut = execFileSync("find", findArgs, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 30_000 });
    filesScanned = findOut.split("\n").filter((l) => l.trim()).length;
  } catch {
    filesScanned = 0;
  }

  if (raw) {
    for (const line of raw.split("\n")) {
      if (!line) continue;
      // Format: path:lineno:text
      const m = line.match(/^(.+?):(\d+):(.*)$/);
      if (!m) continue;
      const [, file, lnStr, text] = m;
      const ln = parseInt(lnStr);
      const relFile = path.relative(scope, file);
      if (!fileMap.has(relFile)) {
        fileMap.set(relFile, {
          file: relFile,
          total_refs: 0,
          import_lines: 0,
          usage_lines: 0,
          is_definition_file: false,
          sample_lines: [],
        });
      }
      const fm = fileMap.get(relFile)!;
      fm.total_refs++;
      const kind = classifyLine(text, opts.signature);
      if (kind === 'import') fm.import_lines++;
      else if (kind === 'definition') fm.is_definition_file = true;
      else fm.usage_lines++;
      if (fm.sample_lines.length < 3) {
        fm.sample_lines.push({ line: ln, text: text.trim().substring(0, 120), kind });
      }
    }
  }

  const matches = Array.from(fileMap.values()).sort((a, b) => b.total_refs - a.total_refs);
  const totalRefs = matches.reduce((acc, m) => acc + m.total_refs, 0);
  const totalImports = matches.reduce((acc, m) => acc + m.import_lines, 0);
  const totalUsages = matches.reduce((acc, m) => acc + m.usage_lines, 0);

  return {
    signature: opts.signature,
    scope,
    extensions,
    files_scanned: filesScanned,
    files_affected: matches.length,
    total_refs: totalRefs,
    total_imports: totalImports,
    total_usages: totalUsages,
    matches,
    duration_ms: Date.now() - start,
  };
}

export function formatApiImpact(r: ApiImpactResult, mode: 'json' | 'text' = 'text'): string {
  if (mode === 'json') return JSON.stringify(r, null, 2);
  const lines: string[] = [];
  lines.push(`## api-impact: "${r.signature}"`);
  lines.push(`Scope: ${r.scope}`);
  lines.push(`Extensions: ${r.extensions.join(", ")}`);
  lines.push(`Files scanned: ${r.files_scanned} | Files affected: ${r.files_affected}`);
  lines.push(`Total refs: ${r.total_refs} (imports=${r.total_imports}, usages=${r.total_usages})`);
  lines.push(`Duration: ${r.duration_ms}ms`);
  if (r.files_affected === 0) {
    lines.push(`\n(no references found — signature unused or scope too narrow)`);
    return lines.join("\n");
  }
  const definitions = r.matches.filter((m) => m.is_definition_file);
  if (definitions.length > 0) {
    lines.push(`\n### 📍 Definition site(s) (${definitions.length})`);
    for (const m of definitions) lines.push(`   ${m.file}  (${m.total_refs} refs)`);
  }
  const importers = r.matches.filter((m) => m.import_lines > 0);
  if (importers.length > 0) {
    lines.push(`\n### 📥 Importers (${importers.length})`);
    for (const m of importers.slice(0, 15)) {
      lines.push(`   ${m.file}  (imports=${m.import_lines}, usages=${m.usage_lines})`);
    }
    if (importers.length > 15) lines.push(`   ... +${importers.length - 15} more`);
  }
  const consumers = r.matches.filter((m) => !m.is_definition_file && m.import_lines === 0 && m.usage_lines > 0);
  if (consumers.length > 0) {
    lines.push(`\n### 🔗 Consumers w/o explicit import (${consumers.length}) — possible same-file or globals`);
    for (const m of consumers.slice(0, 10)) {
      lines.push(`   ${m.file}  (usages=${m.usage_lines})`);
    }
    if (consumers.length > 10) lines.push(`   ... +${consumers.length - 10} more`);
  }
  if (r.matches.length > 0 && r.matches[0].sample_lines.length > 0) {
    lines.push(`\n### 🔍 Top file sample: ${r.matches[0].file}`);
    for (const s of r.matches[0].sample_lines) {
      lines.push(`   L${s.line} [${s.kind}] ${s.text}`);
    }
  }
  return lines.join("\n");
}
