import { readFileSync, existsSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { getDb } from "./db.js";
import { search } from "./search.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// TODO: replace with getConfig().workspace (see config.ts)
const WORKSPACE = process.env.OPENCLAW_WORKSPACE ?? `${process.env.HOME}/.openclaw/workspace`;
const OLLAMA_URL = "http://127.0.0.1:11434/api/generate";
const MODEL = "llama3.2:3b";
const PROMPT_PATH = resolve(__dirname, "..", "prompts", "consolidate.txt");
const MAX_FILES_PER_RUN = 5;

interface ConsolidationResult {
  decisions: Array<{ text: string; permanent: boolean }>;
  lessons: Array<{ text: string; type: string }>;
  people: Array<{ name: string; info: string }>;
  projects: Array<{ name: string; update: string }>;
  pending: Array<{ text: string; owner: string; deadline: string }>;
}

export interface NotionItem {
  title: string;
  date: string;
  category: string;
  content: string;
  source: string;
}

async function callOllama(prompt: string, retries = 3): Promise<ConsolidationResult | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(OLLAMA_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, prompt, format: "json", stream: false, options: { temperature: 0 } }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) { console.error(`[WARN] Ollama HTTP ${response.status} (attempt ${attempt}/${retries})`); continue; }
      const data = (await response.json()) as { response: string };
      const parsed = JSON.parse(data.response) as ConsolidationResult;
      if (!parsed.decisions || !parsed.lessons || !parsed.people || !parsed.projects || !parsed.pending) {
        console.error(`[WARN] Invalid JSON structure (attempt ${attempt}/${retries})`);
        continue;
      }
      return parsed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ECONNREFUSED")) { console.error("[WARN] Ollama offline — skipping"); return null; }
      console.error(`[WARN] Ollama error (attempt ${attempt}/${retries}): ${msg}`);
    }
  }
  console.error("[ERROR] Consolidation failed after all retries");
  return null;
}

function isDuplicate(text: string): boolean {
  // Use longer phrase (first 8 significant words) to reduce false positives
  const words = text.split(/\s+/).filter((w) => w.length > 3).slice(0, 8);
  if (words.length < 3) return false;
  const results = search(words.join(" "), 3);
  for (const result of results) {
    const resultWords = new Set(result.chunk_text.toLowerCase().split(/\s+/));
    const inputWords = text.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    const overlap = inputWords.filter((w) => resultWords.has(w)).length;
    if (inputWords.length > 0 && overlap / inputWords.length > 0.7) return true;
  }
  return false;
}

function ensureFile(path: string, header: string): void {
  if (!existsSync(path)) writeFileSync(path, header + "\n\n", "utf-8");
}

/**
 * Insert content inside the correct section of a markdown file.
 * Finds the section header, then appends BEFORE the next ## header (or end of file).
 */
function appendInSection(path: string, section: string, content: string): void {
  let existing = readFileSync(path, "utf-8");

  if (!existing.includes(section)) {
    // Section doesn't exist — add it at the end
    existing = existing.trimEnd() + "\n\n" + section + "\n\n" + content + "\n";
    writeFileSync(path, existing, "utf-8");
    return;
  }

  // Find section position and insert before next ## header
  const sectionIdx = existing.indexOf(section);
  const afterSection = sectionIdx + section.length;

  // Find next ## header after this section
  const nextHeaderMatch = existing.substring(afterSection).match(/\n## /);
  const insertPos = nextHeaderMatch
    ? afterSection + nextHeaderMatch.index!  // Before next section
    : existing.length;                        // End of file

  // Insert content at the correct position
  const before = existing.substring(0, insertPos).trimEnd();
  const after = existing.substring(insertPos);
  writeFileSync(path, before + "\n" + content + "\n" + after, "utf-8");
}

function gitCommit(message: string): void {
  try {
    execFileSync("git", ["-C", WORKSPACE, "add", "memory/", "MEMORY.md"], { stdio: "pipe" });
    execFileSync("git", ["-C", WORKSPACE, "commit", "-m", message], { stdio: "pipe" });
    console.log(`[INFO] Git commit: ${message}`);
  } catch {
    // No changes to commit — not critical
  }
}

export async function consolidate(options?: { retryFailed?: boolean }): Promise<{ processed: number; extracted: number; skipped: number; remaining: number; notionItems: NotionItem[] }> {
  const db = getDb();
  const promptTemplate = readFileSync(PROMPT_PATH, "utf-8");

  // If retryFailed, reset failed files first
  if (options?.retryFailed) {
    const resetCount = db.prepare("DELETE FROM consolidated_files WHERE status = -1").run().changes;
    if (resetCount > 0) console.log(`[INFO] Reset ${resetCount} failed files for retry`);
  }

  // Find daily note files NOT in consolidated_files table
  const dailyFiles = db.prepare(`
    SELECT DISTINCT source_file, source_date FROM chunks
    WHERE chunk_type = 'daily'
    AND source_file NOT IN (SELECT source_file FROM consolidated_files)
    ORDER BY source_date ASC
    LIMIT ?
  `).all(MAX_FILES_PER_RUN) as Array<{ source_file: string; source_date: string }>;

  const totalPending = (db.prepare(`
    SELECT COUNT(DISTINCT source_file) as c FROM chunks
    WHERE chunk_type = 'daily'
    AND source_file NOT IN (SELECT source_file FROM consolidated_files)
  `).get() as { c: number }).c;

  if (dailyFiles.length === 0) {
    console.log("[INFO] Nothing to consolidate");
    return { processed: 0, extracted: 0, skipped: 0, remaining: 0, notionItems: [] };
  }

  console.log(`[INFO] Processing ${dailyFiles.length} of ${totalPending} pending daily notes`);

  let totalExtracted = 0;
  let totalSkipped = 0;
  const notionItems: NotionItem[] = [];

  for (const { source_file } of dailyFiles) {
    console.log(`[INFO] Consolidating ${source_file}...`);
    const chunks = db.prepare("SELECT chunk_text FROM chunks WHERE source_file = ? ORDER BY id").all(source_file) as Array<{ chunk_text: string }>;
    const fullText = chunks.map((c) => c.chunk_text).join("\n\n");
    const prompt = promptTemplate + fullText;
    const result = await callOllama(prompt);

    if (!result) {
      db.prepare("INSERT OR REPLACE INTO consolidated_files (source_file, status, processed_at) VALUES (?, -1, datetime('now'))").run(source_file);
      continue;
    }

    const date = source_file.match(/(\d{4}-\d{2}-\d{2})/)?.[1] || "unknown";

    // Process decisions
    const decisionsPath = resolve(WORKSPACE, "memory", "decisions.md");
    ensureFile(decisionsPath, "# decisions.md — Decisões Permanentes");
    for (const d of result.decisions) {
      if (!isDuplicate(d.text)) {
        appendInSection(decisionsPath, "## Consolidação Automática", `- **${date}:** ${d.text}`);
        notionItems.push({ title: d.text.substring(0, 100), date, category: "Decisão", content: d.text, source: source_file });
        totalExtracted++;
      } else { totalSkipped++; }
    }

    // Process lessons
    const lessonsPath = resolve(WORKSPACE, "memory", "lessons.md");
    ensureFile(lessonsPath, "# memory/lessons.md — Lições Aprendidas");
    for (const l of result.lessons) {
      if (!isDuplicate(l.text)) {
        const section = l.type === "strategic" ? "## 🔒 Estratégicas" : "## ⏳ Táticas";
        appendInSection(lessonsPath, section, `- **${date}:** ${l.text}`);
        notionItems.push({ title: l.text.substring(0, 100), date, category: "Lição", content: l.text, source: source_file });
        totalExtracted++;
      } else { totalSkipped++; }
    }

    // Process people
    const peoplePath = resolve(WORKSPACE, "memory", "people.md");
    ensureFile(peoplePath, "# memory/people.md — Equipe e Contatos");
    for (const p of result.people) {
      if (!isDuplicate(`${p.name} ${p.info}`)) {
        appendInSection(peoplePath, "## Consolidação Automática", `- **${p.name}:** ${p.info}`);
        notionItems.push({ title: p.name, date, category: "Contexto", content: p.info, source: source_file });
        totalExtracted++;
      } else { totalSkipped++; }
    }

    // Process projects
    const projectsPath = resolve(WORKSPACE, "memory", "projects.md");
    ensureFile(projectsPath, "# memory/projects.md — Projetos");
    for (const proj of result.projects) {
      if (!isDuplicate(`${proj.name} ${proj.update}`)) {
        appendInSection(projectsPath, "## Consolidação Automática", `- **${proj.name} (${date}):** ${proj.update}`);
        notionItems.push({ title: proj.name, date, category: "Contexto", content: proj.update, source: source_file });
        totalExtracted++;
      } else { totalSkipped++; }
    }

    // Process pending
    const pendingPath = resolve(WORKSPACE, "memory", "pending.md");
    ensureFile(pendingPath, "# memory/pending.md — Pendências");
    for (const pend of result.pending) {
      if (!isDuplicate(pend.text)) {
        appendInSection(pendingPath, "## Consolidação Automática", `- **${pend.owner}** (${pend.deadline}): ${pend.text}`);
        notionItems.push({ title: pend.text.substring(0, 100), date, category: "Pendência", content: `${pend.owner} (${pend.deadline}): ${pend.text}`, source: source_file });
        totalExtracted++;
      } else { totalSkipped++; }
    }

    db.prepare("INSERT OR REPLACE INTO consolidated_files (source_file, status, processed_at) VALUES (?, 1, datetime('now'))").run(source_file);
  }

  db.prepare("INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('last_consolidation', datetime('now'), datetime('now'))").run();

  const remaining = totalPending - dailyFiles.length;
  console.log(`[INFO] Consolidation complete: ${dailyFiles.length} files, ${totalExtracted} extracted, ${totalSkipped} duplicates skipped, ${remaining} remaining`);

  const today = new Date().toISOString().split("T")[0];
  gitCommit(`chore(memory): consolidate daily notes ${today}`);

  return { processed: dailyFiles.length, extracted: totalExtracted, skipped: totalSkipped, remaining, notionItems };
}
