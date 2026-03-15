import { getDb, DB_PATH } from "./db.js";
import { statSync, existsSync } from "fs";

export async function doctor(): Promise<void> {
  const checks: Array<{ name: string; status: string; detail: string }> = [];

  // 1. SQLite database
  try {
    const db = getDb();
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    checks.push({ name: "SQLite DB", status: "✅", detail: `schema v${version?.value || "?"}, ${formatSize(DB_PATH)}` });

    // 2. FTS5 index
    const ftsCount = (db.prepare("SELECT COUNT(*) as c FROM chunks_fts").get() as { c: number }).c;
    const chunkCount = (db.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;
    const ftsOk = ftsCount === chunkCount;
    checks.push({ name: "FTS5 Index", status: ftsOk ? "✅" : "⚠️", detail: `${ftsCount} indexed / ${chunkCount} chunks${ftsOk ? "" : " — MISMATCH, run nox-mem reindex"}` });

    // 3. Consolidated files
    const consolidated = (db.prepare("SELECT COUNT(*) as c FROM consolidated_files WHERE status = 1").get() as { c: number }).c;
    const failed = (db.prepare("SELECT COUNT(*) as c FROM consolidated_files WHERE status = -1").get() as { c: number }).c;
    const pending = (db.prepare("SELECT COUNT(DISTINCT source_file) as c FROM chunks WHERE chunk_type = 'daily' AND source_file NOT IN (SELECT source_file FROM consolidated_files)").get() as { c: number }).c;
    checks.push({ name: "Consolidation", status: failed > 0 ? "⚠️" : "✅", detail: `${consolidated} done, ${pending} pending, ${failed} failed` });

    // 4. Last consolidation
    const lastCon = db.prepare("SELECT value FROM meta WHERE key = 'last_consolidation'").get() as { value: string } | undefined;
    checks.push({ name: "Last consolidation", status: "ℹ️", detail: lastCon?.value ?? "never" });
  } catch (err) {
    checks.push({ name: "SQLite DB", status: "❌", detail: `${err}` });
  }

  // 5. Ollama
  try {
    const response = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const data = (await response.json()) as { models: Array<{ name: string; size: number }> };
      const models = data.models.map((m) => m.name).join(", ");
      checks.push({ name: "Ollama", status: "✅", detail: `running, models: ${models}` });
    } else {
      checks.push({ name: "Ollama", status: "⚠️", detail: `HTTP ${response.status}` });
    }
  } catch {
    checks.push({ name: "Ollama", status: "❌", detail: "offline (ECONNREFUSED)" });
  }

  // 6. Notion token
  const notionTokenExists = !!process.env.NOTION_TOKEN // TODO: check config.notion.token;
  checks.push({ name: "Notion token", status: notionTokenExists ? "✅" : "⚠️", detail: notionTokenExists ? "found (via env NOTION_TOKEN or config.json)" : "missing" });

  // 7. File watcher
  try {
    const { execFileSync } = await import("child_process");
    const result = execFileSync("systemctl", ["is-active", "nox-mem-watcher"], { encoding: "utf-8" }).trim();
    checks.push({ name: "File watcher", status: result === "active" ? "✅" : "⚠️", detail: result });
  } catch {
    checks.push({ name: "File watcher", status: "❌", detail: "service not found or inactive" });
  }

  // Print report
  console.log("\n🩺 nox-mem doctor\n");
  for (const check of checks) {
    console.log(`  ${check.status} ${check.name}: ${check.detail}`);
  }
  console.log("");
}

function formatSize(path: string): string {
  try {
    const bytes = statSync(path).size;
    return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
  } catch {
    return "unknown";
  }
}
