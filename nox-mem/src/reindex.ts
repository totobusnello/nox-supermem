import { getDb, closeDb } from "./db.js";
import { ingestFile } from "./ingest.js";
import { readdirSync } from "fs";
import { join, resolve } from "path";

// TODO: replace with getConfig().workspace (see config.ts)
const WORKSPACE = process.env.OPENCLAW_WORKSPACE ?? `${process.env.HOME}/.openclaw/workspace`;

function findFiles(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
        results.push(...findFiles(fullPath, extensions));
      } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
        results.push(fullPath);
      }
    }
  } catch {}
  return results;
}

export function reindex(): { files: number; chunks: number } {
  const db = getDb();

  // Clear chunks but PRESERVE consolidated_files table
  db.exec("DELETE FROM chunks");
  db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");

  const memoryFiles = findFiles(resolve(WORKSPACE, "memory"), [".md", ".json"]);
  const sharedFiles = findFiles(resolve(WORKSPACE, "shared"), [".md"]);
  const allFiles = [...memoryFiles, ...sharedFiles];
  let totalChunks = 0;

  for (const file of allFiles) {
    try {
      // skipDelete=true since table is already cleared
      const result = ingestFile(file, db, true);
      totalChunks += result.chunks;
      console.log(`[INFO] ${file}: ${result.chunks} chunks`);
    } catch (err) {
      console.error(`[ERROR] ${file}: ${err}`);
    }
  }

  // Use closeDb() to properly reset singleton
  closeDb();
  return { files: allFiles.length, chunks: totalChunks };
}
