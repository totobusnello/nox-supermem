/**
 * vectorize.ts - Build/update the vector index using Gemini API embeddings.
 * Uses batchEmbedContents (true batch), skips chunks already mapped in vec_chunk_map,
 * rate-limited via pauseMs between batches (default 1s / batch of 50 → ~3000 chunks/min).
 */

import { getDb, closeDb } from "./db.js";
import { embedBatchAPI, ensureVecTable, upsertEmbedding } from "./embed.js";

export async function vectorize(options?: {
  force?: boolean;
  limit?: number;
  batchSize?: number;
  pauseMs?: number;
}): Promise<{ embedded: number; skipped: number; total: number; errors: number }> {
  const db = getDb();

  // Ensure vec table exists (creates if not)
  try {
    ensureVecTable(db);
  } catch (err) {
    console.error("[VECTORIZE] Failed to init vec table:", (err as Error).message);
    return { embedded: 0, skipped: 0, total: 0, errors: 1 };
  }

  const allChunks = db
    .prepare("SELECT id, chunk_text FROM chunks ORDER BY id")
    .all() as Array<{ id: number; chunk_text: string }>;

  const total = allChunks.length;
  if (total === 0) {
    console.log("[VECTORIZE] No chunks to embed.");
    return { embedded: 0, skipped: 0, total: 0, errors: 0 };
  }

  // FIX: previously queried `SELECT chunk_id FROM vec_chunks` but that column
  // does not exist — the chunk_id lives in `vec_chunk_map`. That bug caused every
  // vectorize run to re-embed everything AND never detect orphans. Use the correct
  // table now, scoped to chunk_ids that still exist.
  const embeddedIds = new Set<number>();
  if (!options?.force) {
    try {
      const embedded = db
        .prepare(
          "SELECT DISTINCT m.chunk_id as chunk_id FROM vec_chunk_map m INNER JOIN chunks c ON c.id = m.chunk_id"
        )
        .all() as Array<{ chunk_id: number }>;
      for (const { chunk_id } of embedded) embeddedIds.add(chunk_id);
    } catch {
      // vec_chunk_map might be empty or missing
    }
  }

  let toEmbed = allChunks.filter((c) => !embeddedIds.has(c.id));
  const skipped = allChunks.length - toEmbed.length;

  if (options?.limit && options.limit > 0) {
    toEmbed = toEmbed.slice(0, options.limit);
  }

  if (toEmbed.length === 0) {
    console.log(`[VECTORIZE] All ${total} chunks already embedded. Use --force to re-embed.`);
    return { embedded: 0, skipped, total, errors: 0 };
  }

  const batchSize = options?.batchSize ?? 50;
  const pauseMs = options?.pauseMs ?? 1000;

  console.log(
    `[VECTORIZE] Embedding ${toEmbed.length} chunks via batchEmbedContents ` +
    `(batch=${batchSize}, pause=${pauseMs}ms, ${skipped} already done)...`
  );
  const startTime = Date.now();
  let embedded = 0;
  let errors = 0;

  // Process in groups sized to match the batch API call so errors scope per batch.
  for (let i = 0; i < toEmbed.length; i += batchSize) {
    const slice = toEmbed.slice(i, i + batchSize);
    try {
      const vectors = await embedBatchAPI(
        slice.map((c) => c.chunk_text),
        { batchSize, pauseMs: 0 } // single batch here; outer loop handles pacing
      );
      // Upsert in a single transaction for atomicity + speed
      const tx = db.transaction((entries: Array<{ id: number; vec: Float32Array }>) => {
        for (const { id, vec } of entries) upsertEmbedding(db, id, vec);
      });
      tx(slice.map((c, idx) => ({ id: c.id, vec: vectors[idx] })));
      embedded += slice.length;

      const elapsed = Math.max(1, Math.round((Date.now() - startTime) / 1000));
      const rate = (embedded / elapsed).toFixed(1);
      const eta = Math.round((toEmbed.length - embedded) / Math.max(0.1, parseFloat(rate)));
      process.stdout.write(
        `[VECTORIZE] ${embedded}/${toEmbed.length} — ${rate}/s — ETA: ${eta}s     \r`
      );
    } catch (err) {
      console.error(`\n[VECTORIZE] Batch error (chunks ${slice[0].id}..${slice[slice.length - 1].id}):`, (err as Error).message);
      errors += slice.length;
    }

    // Pace between batches (skip on final)
    if (i + batchSize < toEmbed.length && pauseMs > 0) {
      await new Promise((r) => setTimeout(r, pauseMs));
    }
  }

  const totalTime = Math.round((Date.now() - startTime) / 1000);
  console.log(
    `\n[VECTORIZE] Done: ${embedded} embedded, ${skipped} skipped, ${errors} errors. Time: ${totalTime}s`
  );

  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('last_vectorize', datetime('now'), datetime('now'))"
  ).run();
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('vec_count', ?, datetime('now'))"
  ).run(String(embedded + skipped));

  return { embedded, skipped, total, errors };
}
