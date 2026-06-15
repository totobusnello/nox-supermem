import Database from "better-sqlite3";
import { getDb } from "./db.js";

/**
 * NoiseFilter — detecta chunks sem valor semântico antes de enviá-los ao LLM.
 *
 * Estratégia (zero custo de API):
 *   1. Textos <= 10 chars → sempre ruído
 *   2. Textos >= 500 chars → nunca ruído (conteúdo relevante)
 *   3. Faixa 11-499 chars → comparar contra protótipos normalizados (exact + partial)
 *
 * Aprendizado via feedback: quando o LLM retorna zero resultados úteis,
 * o texto pode ser adicionado como novo protótipo via `learn()`.
 */

// Protótipos estáticos de ruído — PT-BR e EN comuns
const BUILTIN_PROTOTYPES = [
  // Confirmações curtas PT-BR
  "ok", "ok entendi", "entendi", "certo", "certo entendi",
  "feito", "feito!", "ok feito", "já feito",
  "sim", "sim!", "não", "nao",
  "obrigado", "obrigado!", "obrigado!!", "valeu", "valeu!", "muito obrigado",
  "perfeito", "perfeito!", "ótimo", "otimo", "ótimo!", "muito bom",
  "combinado", "combinado!", "pode ser", "tá bom", "ta bom", "tá ótimo",
  "beleza", "show", "show!", "boa", "boa!", "muito boa",
  "👍", "👍👍", "✅", "🙏", "❤️", "👏",
  "ok!", "👌", "😊", "🤝",
  // EN equivalents
  "got it", "understood", "ok got it", "sounds good", "perfect",
  "done", "noted", "ack", "acknowledged", "will do",
  "thanks", "thank you", "thx", "ty",
  "yes", "no", "yep", "nope", "sure",
  // Fragmentos típicos de logs/commits sem contexto
  "push", "done!", "completed", "ok.",
];

// Padrões regex para ruído estrutural
const NOISE_PATTERNS = [
  /^\s*[👍👌✅🙏❤️👏😊🤝💪🔥]+\s*$/u,   // só emojis
  /^\s*[\.\-_,;:!?]+\s*$/,               // só pontuação
  /^\s*\d+\s*$/,                          // só número
  /^(ok|sim|não|nao|yes|no|yep|nope)\.?\s*$/i,
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")  // remove diacritics
    .replace(/[^\w\s]/g, "")          // remove punctuation
    .replace(/\s+/g, " ")
    .trim();
}

function ensureNoiseTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS noise_prototypes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text_normalized TEXT NOT NULL UNIQUE,
      text_original TEXT NOT NULL,
      is_builtin INTEGER DEFAULT 0,
      hit_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed built-ins once
  const count = (db.prepare("SELECT COUNT(*) as c FROM noise_prototypes WHERE is_builtin = 1").get() as { c: number }).c;
  if (count === 0) {
    const insert = db.prepare("INSERT OR IGNORE INTO noise_prototypes (text_normalized, text_original, is_builtin) VALUES (?, ?, 1)");
    const seedAll = db.transaction(() => {
      for (const p of BUILTIN_PROTOTYPES) {
        insert.run(normalize(p), p);
      }
    });
    seedAll();
  }
}

/**
 * Returns true if `text` is considered noise (not worth sending to LLM).
 */
export function isNoise(text: string, db?: Database.Database): boolean {
  const trimmed = text.trim();

  // Rule 1: too short
  if (trimmed.length <= 10) return true;

  // Rule 2: too long → definitely content
  if (trimmed.length >= 500) return false;

  // Rule 3: regex patterns
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  // Rule 4: compare normalized text against DB prototypes (exact or close match)
  const norm = normalize(trimmed);
  if (!norm) return true;  // only punctuation/spaces after normalization

  const resolvedDb = db ?? getDb();
  ensureNoiseTable(resolvedDb);

  // Exact match
  const exact = resolvedDb.prepare(
    "SELECT id FROM noise_prototypes WHERE text_normalized = ?"
  ).get(norm) as { id: number } | undefined;

  if (exact) {
    resolvedDb.prepare(
      "UPDATE noise_prototypes SET hit_count = hit_count + 1 WHERE id = ?"
    ).run(exact.id);
    return true;
  }

  // Partial match: if the input IS a known prototype (trimmed words are subset of noise)
  // e.g. "ok entendi sim" — all words are noise words
  const words = norm.split(/\s+/).filter((w) => w.length > 1);
  if (words.length <= 3) {
    const allNoise = words.every((word) => {
      return !!resolvedDb.prepare(
        "SELECT id FROM noise_prototypes WHERE text_normalized = ? OR text_normalized LIKE ?"
      ).get(word, `% ${word}%`);
    });
    if (allNoise) return true;
  }

  return false;
}

/**
 * Add a learned prototype (when LLM returns zero results from a short text).
 * Max 200 learned (non-builtin) prototypes to avoid unbounded growth.
 */
export function learnNoise(text: string, db?: Database.Database): void {
  const trimmed = text.trim();
  if (trimmed.length > 200) return;  // don't learn long texts
  if (trimmed.length < 3) return;

  const resolvedDb = db ?? getDb();
  ensureNoiseTable(resolvedDb);

  const learnedCount = (resolvedDb.prepare(
    "SELECT COUNT(*) as c FROM noise_prototypes WHERE is_builtin = 0"
  ).get() as { c: number }).c;

  if (learnedCount >= 200) return;  // cap

  const norm = normalize(trimmed);
  if (!norm) return;

  resolvedDb.prepare(
    "INSERT OR IGNORE INTO noise_prototypes (text_normalized, text_original, is_builtin) VALUES (?, ?, 0)"
  ).run(norm, trimmed);
}

/**
 * Get stats about the noise filter.
 */
export function getNoiseStats(db?: Database.Database): { builtin: number; learned: number; totalHits: number } {
  const resolvedDb = db ?? getDb();
  ensureNoiseTable(resolvedDb);

  const builtin = (resolvedDb.prepare("SELECT COUNT(*) as c FROM noise_prototypes WHERE is_builtin = 1").get() as { c: number }).c;
  const learned = (resolvedDb.prepare("SELECT COUNT(*) as c FROM noise_prototypes WHERE is_builtin = 0").get() as { c: number }).c;
  const totalHits = (resolvedDb.prepare("SELECT COALESCE(SUM(hit_count), 0) as c FROM noise_prototypes").get() as { c: number }).c;
  return { builtin, learned, totalHits };
}
