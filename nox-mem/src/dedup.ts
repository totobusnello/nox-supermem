/**
 * dedup.ts — Semantic deduplication using cosine similarity
 * Falls back to word overlap when embeddings are unavailable
 */
import { getDb } from "./db.js";
import { search } from "./search.js";

// Cosine similarity between two arrays
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// Check if vec_chunks table exists and has data
function hasVecIndex(): boolean {
  try {
    const db = getDb();
    const row = db.prepare(
      "SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='vec_chunks'"
    ).get() as { c: number };
    if (row.c === 0) return false;
    const count = db.prepare("SELECT COUNT(*) as c FROM vec_chunk_map").get() as { c: number };
    return count.c > 0;
  } catch { return false; }
}

// Semantic dedup: embed candidate, compare against top FTS matches
async function semanticIsDuplicate(
  text: string, sourceFile: string, chunkType: string, threshold: number = 0.85
): Promise<{ isDup: boolean; reason: string }> {
  try {
    const { embedText, semanticSearch } = await import("./embed.js");

    // Get embedding for candidate text
    const candidateEmbRaw = await embedText(text);
    const candidateEmb = Array.from(candidateEmbRaw);
    if (!candidateEmbRaw || candidateEmbRaw.length === 0) {
      return fallbackWordOverlap(text, sourceFile, chunkType);
    }

    // Search existing chunks for similar content
    const results = search(text.split(/\s+/).slice(0, 8).join(" "), 5);

    for (const result of results) {
      // Get embedding for existing chunk
      const existingEmbRaw = await embedText(result.chunk_text);
      const existingEmb = Array.from(existingEmbRaw);
      if (!existingEmbRaw || existingEmbRaw.length === 0) continue;

      const similarity = cosineSimilarity(candidateEmb, existingEmb);
      if (similarity >= threshold) {
        return {
          isDup: true,
          reason: `cosine=${(similarity * 100).toFixed(1)}% with ${result.source_file}`
        };
      }
    }

    return { isDup: false, reason: "" };
  } catch (err) {
    console.error(`[WARN] Semantic dedup failed, using fallback: ${err instanceof Error ? err.message : String(err)}`);
    return fallbackWordOverlap(text, sourceFile, chunkType);
  }
}

// Original word-overlap method as fallback
function fallbackWordOverlap(
  text: string, sourceFile: string, chunkType: string
): { isDup: boolean; reason: string } {
  const words = text.split(/\s+/).filter(w => w.length > 3).slice(0, 8);
  if (words.length < 3) return { isDup: false, reason: "" };

  const results = search(words.join(" "), 3);
  for (const result of results) {
    const resultWords = new Set(result.chunk_text.toLowerCase().split(/\s+/));
    const inputWords = text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const overlap = inputWords.filter(w => resultWords.has(w)).length;
    if (inputWords.length > 0 && overlap / inputWords.length > 0.7) {
      return {
        isDup: true,
        reason: `overlap=${Math.round(overlap / inputWords.length * 100)}% with ${result.source_file}`
      };
    }
  }
  return { isDup: false, reason: "" };
}

// Main entry point — tries semantic first, falls back to word overlap
export async function isDuplicate(
  text: string, sourceFile: string, chunkType: string
): Promise<boolean> {
  const geminiKey = process.env.GEMINI_API_KEY;
  const useSemanticDedup = !!geminiKey && hasVecIndex();

  const { isDup, reason } = useSemanticDedup
    ? await semanticIsDuplicate(text, sourceFile, chunkType)
    : fallbackWordOverlap(text, sourceFile, chunkType);

  if (isDup) {
    logDedup(text, sourceFile, chunkType, reason);
  }
  return isDup;
}

function logDedup(text: string, sourceFile: string, chunkType: string, reason: string): void {
  try {
    const db = getDb();
    const preview = text.substring(0, 200);
    db.prepare(
      "INSERT INTO dedup_log (chunk_text_preview, source_file, chunk_type, reason) VALUES (?, ?, ?, ?)"
    ).run(preview, sourceFile, chunkType, reason);
    console.log(`[DEDUP] Suppressed (${reason}): "${preview.substring(0, 80)}..." [${sourceFile}]`);
  } catch {}
}
