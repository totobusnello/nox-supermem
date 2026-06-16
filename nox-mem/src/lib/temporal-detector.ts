// E13 — Temporal-aware Ranking
// 2026-05-06 impl. Spec: memoria-nox/specs/2026-05-06-E13-temporal-aware-ranking.md
//
// Detector de query temporal + override de section_boost. Hoje timeline=0.8
// (demote) penaliza 100% das queries temporais cured (gold em section=timeline).
// Pra elas, timeline IS truth. Override apenas quando isTemporalQuery(query).
//
// Aditivo single-pass (regra crítica #5): substitui lookup, não soma.
//
// Modes (env NOX_TEMPORAL_BOOST_MODE):
//   off     — disabled (default), no compute, no apply
//   shadow  — compute override + log delta, NO apply
//   active  — compute + log + apply override

export type TemporalBoostMode = "off" | "shadow" | "active";

// Padrões PT-BR + inglês curto. Cada um cobre family of triggers.
const TEMPORAL_PATTERNS: RegExp[] = [
  /\b(quando|que\s+dia|que\s+data|qual\s+(?:data|dia)|em\s+que\s+(?:dia|data))\b/iu,
  /\b(primeir[ao]|últim[ao]|inicial)\b/iu,
  /\b(deploy(?:ado|ed|amento)|ativad[ao]|subiu|lançad[ao]|started|aconteceu|inici(?:ou|ado))\b/iu,
  /\b\d{4}-\d{2}-\d{2}\b/, // ISO date
];

export function isTemporalQuery(query: string): boolean {
  if (!query || typeof query !== "string") return false;
  const q = query.trim();
  if (q.length < 3) return false;
  return TEMPORAL_PATTERNS.some((re) => re.test(q));
}

// Override aplicado SOMENTE quando isTemporalQuery(query). Substitui lookup
// padrão (não soma). Valores escolhidos pra inverter timeline demote sem
// destruir compiled (que ainda pode ter info temporal relevante).
export const SECTION_BOOST_TEMPORAL: Record<string, number> = {
  compiled: 1.0,    // neutro — compiled é truth atual, mas não é a fonte primária pra "quando"
  frontmatter: 0.9, // levemente demote — metadata raramente responde "quando"
  timeline: 1.4,    // PROMOVE — é onde events com data residem
  // null/legacy = 1.0 (handled by caller)
};

export function getMode(): TemporalBoostMode {
  const v = (process.env.NOX_TEMPORAL_BOOST_MODE || "off").toLowerCase();
  if (v === "off" || v === "shadow" || v === "active") return v;
  return "off";
}

/**
 * Resolve effective section_boost given context.
 * - mode=off → returns original sectionBoost (current behavior)
 * - mode=shadow → returns original (active=false short-circuit) but caller logs alt via getOverride()
 * - mode=active + temporal + section in lookup → returns override
 * - else → returns original
 */
export function effectiveSectionBoost(
  sectionBoost: number | null,
  section: string | null,
  isTemporal: boolean,
  mode: TemporalBoostMode = getMode()
): number {
  const baseline = typeof sectionBoost === "number" ? sectionBoost : 1.0;
  if (mode !== "active") return baseline;
  if (!isTemporal || !section) return baseline;
  const override = SECTION_BOOST_TEMPORAL[section];
  return override !== undefined ? override : baseline;
}

/**
 * Pure lookup of override value (independent of mode). Used by shadow logger
 * to compute "what would happen if active".
 */
export function getOverride(section: string | null): number | null {
  if (!section) return null;
  const v = SECTION_BOOST_TEMPORAL[section];
  return v !== undefined ? v : null;
}

export interface TemporalShadowSignal {
  isTemporal: boolean;
  mode: TemporalBoostMode;
  // Quantos chunks na pool tinham section em SECTION_BOOST_TEMPORAL keys
  // (i.e. seriam afetados pelo override em mode=active)
  affectedChunks?: number;
}

/**
 * Lightweight log helper — chamado 1× por query no pipeline.
 * NOX_TEMPORAL_BOOST_LOG=1 pra emitir.
 */
export function logTemporal(
  query: string,
  signal: TemporalShadowSignal
): void {
  if (process.env.NOX_TEMPORAL_BOOST_LOG !== "1") return;
  const safeQuery = (query || "").replace(/[\r\n"]/g, " ").slice(0, 80);
  const tag = signal.mode === "active" ? "temporal-active" : "temporal-shadow";
  console.error(
    `[${tag}] query="${safeQuery}" temporal=${signal.isTemporal} mode=${signal.mode}` +
      (signal.affectedChunks !== undefined ? ` affected=${signal.affectedChunks}` : "")
  );
}
