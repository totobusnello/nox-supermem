import { readFileSync } from "fs";
import { relative } from "path";
import Database from "better-sqlite3";
import { getDb } from "./db.js";

// TODO: replace with getConfig().workspace (see config.ts)
import { getConfig } from "./config.js";

const WORKSPACE = () => getConfig().workspace;

const TYPE_MAP: Record<string, string> = {
  "memory/decisions.md": "decision",
  "memory/lessons.md": "lesson",
  "memory/people.md": "person",
  "memory/projects.md": "project",
  "memory/pending.md": "pending",
};

export function detectChunkType(relPath: string): string {
  if (TYPE_MAP[relPath]) return TYPE_MAP[relPath];
  if (relPath.startsWith("shared/")) return "team";
  if (relPath.match(/memory\/feedback\//)) return "feedback";
  if (relPath.match(/memory\/digests\//)) return "digest";
  if (relPath.match(/memory\/\d{4}-\d{2}-\d{2}/)) return "daily";
  return "other";
}

export function extractDate(relPath: string): string | null {
  const match = relPath.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

export function chunkMarkdown(content: string): string[] {
  const lines = content.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.match(/^#{2,3}\s/) && current.length > 0) {
      const text = current.join("\n").trim();
      if (text) chunks.push(text);
      current = [line];
    } else {
      current.push(line);
    }
  }
  const last = current.join("\n").trim();
  if (last) chunks.push(last);

  const result: string[] = [];
  for (const chunk of chunks) {
    const wordCount = chunk.split(/\s+/).length;
    if (wordCount > 500) {
      const subChunks = chunk.split(/\n\n+/).filter((s) => s.trim());
      let buffer = "";
      for (const sub of subChunks) {
        if (buffer && (buffer + "\n\n" + sub).split(/\s+/).length > 500) {
          result.push(buffer.trim());
          buffer = sub;
        } else {
          buffer = buffer ? buffer + "\n\n" + sub : sub;
        }
      }
      if (buffer.trim()) result.push(buffer.trim());
    } else if (wordCount < 20 && result.length > 0) {
      result[result.length - 1] += "\n\n" + chunk;
    } else {
      result.push(chunk);
    }
  }
  return result.filter((c) => c.trim().length > 0);
}

export function chunkJson(content: string): string[] {
  try {
    const data = JSON.parse(content);
    if (Array.isArray(data)) return data.map((item) => JSON.stringify(item, null, 2));
    const chunks: string[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value)) {
        for (const item of value as unknown[]) chunks.push(`${key}: ${JSON.stringify(item)}`);
      } else {
        chunks.push(`${key}: ${JSON.stringify(value)}`);
      }
    }
    return chunks.length > 0 ? chunks : [content];
  } catch {
    return [content];
  }
}

/**
 * Sanitize UTF-8 text — replace broken sequences with correct characters
 */
function sanitizeUtf8(text: string): string {
  // Fix common mojibake patterns (UTF-8 read as Latin-1)
  return text
    .replace(/\u00c3\u00a3/g, "ã")
    .replace(/\u00c3\u00a7/g, "ç")
    .replace(/\u00c3\u00a9/g, "é")
    .replace(/\u00c3\u00a1/g, "á")
    .replace(/\u00c3\u00b5/g, "õ")
    .replace(/\u00c3\u00ad/g, "í")
    .replace(/\u00c3\u00ba/g, "ú")
    .replace(/\u00c3\u00b3/g, "ó")
    .replace(/\u00c3\u00aa/g, "ê")
    .replace(/\u00c3\u00a2/g, "â");
}

/**
 * @param filePath — absolute path to .md or .json file
 * @param externalDb — optional db connection (used by reindex for single-connection)
 * @param skipDelete — skip DELETE before insert (used by reindex since table is already cleared)
 */
export function ingestFile(filePath: string, externalDb?: Database.Database, skipDelete?: boolean): { chunks: number } {
  const db = externalDb || getDb();
  const relPath = relative(WORKSPACE(), filePath);
  let content = readFileSync(filePath, "utf-8");
  if (!content.trim()) {
    if (!externalDb) db.close();
    return { chunks: 0 };
  }

  // Sanitize UTF-8
  content = sanitizeUtf8(content);

  const chunkType = detectChunkType(relPath);
  const sourceDate = extractDate(relPath);
  const isJson = filePath.endsWith(".json");
  const textChunks = isJson ? chunkJson(content) : chunkMarkdown(content);

  // Skip delete if called from reindex (table already cleared)
  if (!skipDelete) {
    db.prepare("DELETE FROM chunks WHERE source_file = ?").run(relPath);
  }

  const insert = db.prepare(
    "INSERT INTO chunks (source_file, chunk_text, chunk_type, source_date, metadata) VALUES (?, ?, ?, ?, ?)"
  );
  const insertMany = db.transaction((chunks: string[]) => {
    for (const text of chunks) insert.run(relPath, text, chunkType, sourceDate, null);
  });
  insertMany(textChunks);

  if (!externalDb) db.close();
  return { chunks: textChunks.length };
}
