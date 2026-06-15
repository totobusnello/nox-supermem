/**
 * src/churn.ts — item 2 do plano Cipher×nox-mem (2026-06-05).
 * Spec: memoria-nox specs/2026-06-05-cipher-simbiose-itens-1-2-3.md
 *
 * Detecção de churn: chunk NOVO (created_at >= since) semanticamente próximo
 * de chunk ANTIGO = re-decisão sobre o mesmo tópico = knowledge gap (a memória
 * não preveniu retrabalho). Read-only; $0 Gemini — usa embeddings já
 * materializados em vec_chunks via KNN sqlite-vec (padrão semanticSearch de
 * embed.ts). Métrica: L2 sobre vetores normalizados ⇒ cos = 1 - d²/2.
 */
import type Database from "better-sqlite3";

export interface ChurnOpts {
  since: string;       // ISO8601 ou "YYYY-MM-DD HH:MM:SS" — normalizado via datetime()
  threshold?: number;  // similaridade cosseno mínima (default 0.80)
  types?: string[];    // filtro de chunk_type dos chunks NOVOS (default: sem filtro)
  k?: number;          // vizinhos por chunk novo (default 5)
  maxNew?: number;     // cap de chunks novos processados (default 2000)
}

export interface ChurnPair {
  newChunkId: number;
  newFile: string;
  newText: string;
  newCreatedAt: string;
  oldChunkId: number;
  oldFile: string;
  oldText: string;
  oldCreatedAt: string;
  similarity: number;
}

/** L2 sobre embeddings normalizados (gemini-embedding-001 3072d): cos = 1 - d²/2 */
function distToSim(d: number): number {
  return 1 - (d * d) / 2;
}

export function detectChurn(db: Database.Database, opts: ChurnOpts): ChurnPair[] {
  const threshold = opts.threshold ?? 0.8;
  const k = opts.k ?? 5;
  const maxNew = opts.maxNew ?? 2000;

  const typeFilter = opts.types?.length
    ? `AND c.chunk_type IN (${opts.types.map(() => "?").join(",")})`
    : "";

  const newChunks = db
    .prepare(
      `SELECT c.id, c.source_file, c.chunk_text, c.created_at, vc.embedding
         FROM chunks c
         JOIN vec_chunk_map m ON m.chunk_id = c.id
         JOIN vec_chunks vc ON vc.rowid = m.vec_rowid
        WHERE c.created_at >= datetime(?) ${typeFilter}
        ORDER BY c.created_at DESC
        LIMIT ?`
    )
    .all(opts.since, ...(opts.types ?? []), maxNew) as Array<{
    id: number;
    source_file: string;
    chunk_text: string;
    created_at: string;
    embedding: Buffer;
  }>;

  // Mesmo shape do semanticSearch (embed.ts): MATCH + k, vec_rowid no map.
  const knn = db.prepare(
    `SELECT m.chunk_id, vc.distance, c.source_file, c.chunk_text, c.created_at
       FROM vec_chunks vc
       JOIN vec_chunk_map m ON m.vec_rowid = vc.rowid
       JOIN chunks c ON c.id = m.chunk_id
      WHERE vc.embedding MATCH ?
        AND k = ?
      ORDER BY vc.distance`
  );

  const pairs: ChurnPair[] = [];
  for (const nc of newChunks) {
    const neighbors = knn.all(nc.embedding, k + 1) as Array<{
      chunk_id: number;
      distance: number;
      source_file: string;
      chunk_text: string;
      created_at: string;
    }>;
    for (const nb of neighbors) {
      if (nb.chunk_id === nc.id) continue; // ele mesmo
      if (nb.created_at >= nc.created_at) continue; // só vizinho mais ANTIGO conta
      const olderThanSince = db
        .prepare("SELECT ? < datetime(?) AS old")
        .get(nb.created_at, opts.since) as { old: number };
      if (!olderThanSince.old) continue; // vizinho dentro do período = não é re-decisão
      const sim = distToSim(nb.distance);
      if (sim >= threshold) {
        pairs.push({
          newChunkId: nc.id,
          newFile: nc.source_file,
          newText: nc.chunk_text,
          newCreatedAt: nc.created_at,
          oldChunkId: nb.chunk_id,
          oldFile: nb.source_file,
          oldText: nb.chunk_text,
          oldCreatedAt: nb.created_at,
          similarity: Math.round(sim * 1000) / 1000,
        });
        break; // 1 par por chunk novo (o vizinho antigo mais próximo)
      }
    }
  }
  return pairs.sort((a, b) => b.similarity - a.similarity);
}

const clip = (s: string, n = 80) => (s.length > n ? s.slice(0, n - 1) + "…" : s).replace(/\s+/g, " ");

export function churnReportMd(pairs: ChurnPair[], since: string): string {
  const EXACT = 0.995;
  const exact = pairs.filter((p) => p.similarity >= EXACT);
  const semantic = pairs.filter((p) => p.similarity < EXACT);

  const lines = [
    `# Churn report — desde ${since}`,
    "",
    `${pairs.length} pares detectados: ${semantic.length} re-decisões semânticas + ${exact.length} duplicatas exatas. Re-decisão = knowledge gap: a memória não preveniu retrabalho. Ação: Cipher propõe consolidação (NUNCA auto-muta).`,
    "",
    `## Re-decisões semânticas (0.80 ≤ sim < ${EXACT})`,
    "",
  ];
  for (const p of semantic) {
    lines.push(
      `- **${p.similarity}** novo #${p.newChunkId} "${clip(p.newText)}" (${p.newCreatedAt.slice(0, 10)}) ↔ antigo #${p.oldChunkId} "${clip(p.oldText)}" (${p.oldCreatedAt.slice(0, 10)})`
    );
  }
  if (!semantic.length) lines.push("_Nenhuma re-decisão semântica no período._");

  lines.push("", `## Duplicatas exatas (sim ≥ ${EXACT}) — agrupadas por par de arquivos`, "");
  const groups = new Map<string, { count: number; sample: ChurnPair }>();
  for (const p of exact) {
    const key = `${p.newFile} ↔ ${p.oldFile}`;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { count: 1, sample: p });
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [key, g] of sorted) {
    lines.push(`- **${g.count}× chunks** ${key} (ex: novo #${g.sample.newChunkId} ↔ antigo #${g.sample.oldChunkId})`);
  }
  if (!exact.length) lines.push("_Nenhuma duplicata exata no período._");
  if (!pairs.length) lines.push("", "_Nenhum churn no período._");
  return lines.join("\n") + "\n";
}
