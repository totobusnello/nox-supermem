import { getDb } from "./db.js";
import { getConfig } from "./config.js";
import { statSync } from "fs";

export function getStats(): string {
  const db = getDb();

  const total = (db.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;
  const byType = db.prepare("SELECT chunk_type, COUNT(*) as c FROM chunks GROUP BY chunk_type ORDER BY c DESC").all() as Array<{ chunk_type: string; c: number }>;

  // Use consolidated_files table (not is_consolidated column)
  const consolidated = (db.prepare("SELECT COUNT(*) as c FROM consolidated_files WHERE status = 1").get() as { c: number }).c;
  const failed = (db.prepare("SELECT COUNT(*) as c FROM consolidated_files WHERE status = -1").get() as { c: number }).c;

  // Count daily note files that are NOT in consolidated_files
  const pendingDailyFiles = db.prepare(`
    SELECT COUNT(DISTINCT source_file) as c FROM chunks
    WHERE chunk_type = 'daily'
    AND source_file NOT IN (SELECT source_file FROM consolidated_files)
  `).get() as { c: number };

  const lastCon = db.prepare("SELECT value FROM meta WHERE key = 'last_consolidation'").get() as { value: string } | undefined;

  let dbSize = "0 B";
  try {
    const bytes = statSync(getConfig().dbPath).size;
    dbSize = bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
  } catch {}

  const typeLine = byType.map((t) => `  ${t.chunk_type}: ${t.c}`).join("\n");

  return [
    `Chunks: ${total} total`,
    typeLine,
    "",
    `Last consolidation: ${lastCon?.value ?? "never"}`,
    `Consolidated files: ${consolidated}`,
    `Failed files: ${failed}`,
    `Daily notes pending: ${pendingDailyFiles.c}`,
    `Database size: ${dbSize}`,
  ].join("\n");
}
