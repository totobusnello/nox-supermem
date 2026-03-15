import { getDb } from "./db.js";

const BOOST_TYPES = new Set(["decision", "lesson", "person", "project", "pending"]);

interface SearchResult {
  score: number;
  source_file: string;
  chunk_type: string;
  chunk_text: string;
  source_date: string | null;
}

export function search(query: string, limit: number = 5): SearchResult[] {
  const db = getDb();
  const sanitized = query.replace(/['"{}()\[\]:*^~&|!]/g, " ").trim();
  if (!sanitized) { return []; }

  let rows: Array<{
    source_file: string; chunk_type: string; chunk_text: string;
    source_date: string | null; rank: number;
  }>;

  try {
    rows = db.prepare(`
      SELECT c.source_file, c.chunk_type, c.chunk_text, c.source_date,
             bm25(chunks_fts, 1.0, 0.5, 0.5) as rank
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      WHERE chunks_fts MATCH ?
      ORDER BY rank LIMIT 20
    `).all(sanitized) as typeof rows;
  } catch {
    return [];
  }

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    .toISOString().split("T")[0];

  const scored = rows.map((row) => {
    let score = Math.abs(row.rank);
    if (BOOST_TYPES.has(row.chunk_type)) score *= 2.0;
    if (row.source_date && row.source_date >= sevenDaysAgo) score *= 1.5;
    return {
      score: Math.round(score * 100) / 100,
      source_file: row.source_file,
      chunk_type: row.chunk_type,
      chunk_text: row.chunk_text,
      source_date: row.source_date,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return "No results found.";
  return results
    .map((r, i) => {
      const preview = r.chunk_text.substring(0, 200).replace(/\n/g, " ");
      return `#${i + 1} [${r.score}] ${r.source_file}\n   "${preview}..."`;
    })
    .join("\n\n");
}
