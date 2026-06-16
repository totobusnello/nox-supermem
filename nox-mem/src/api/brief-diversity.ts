/**
 * D2 — Brief diversity/novelty term (re-rank pós-salience DENTRO do brief).
 *
 * Spec (memoria-nox): specs/2026-06-07-D2-brief-diversity-term.md
 * Origem: D1 (feedback loop do canário, 2026-06-07) + D3 (medição limpa,
 * 2026-06-13). D3 cravou: 83 chunks distintos servem ~6.700 serves/dia
 * (0,18% diversidade), mediana 48d, 19/81 high-pain≥0.9, e 510-931 chunks
 * recentes relevantes nunca servidos. Follow-up rate via search/answer é
 * NÃO-mensurável (3 buscas genuínas / 0 answers em 7d) — gate redesenhado
 * sobre diversidade + freshness + high-pain floor, sem follow-up.
 *
 * Invariantes (§2 da spec — NÃO violar):
 *   1. NÃO forka `calculateSalience` (regra #5/#17 do repo). O termo de
 *      diversidade é re-rank pós-salience APENAS dentro do brief — nunca
 *      um peso novo na fórmula (que afetaria search também).
 *   2. Read-only sobre `chunks` (promessa F1: access_count intocado). A
 *      serve-history vem de `brief_log` (tabela própria).
 *   3. Fail-open: diversidade nunca derruba o priming.
 *   4. High-pain floor: incidents pain ≥ PAIN_FLOOR são imunes ao penalty.
 *
 * Este módulo só carrega lógica PURA (config + penalty + diff). As queries
 * (serveCounts, fetchFreshCandidates) e a integração com buildBrief vivem em
 * brief.ts, onde o pool/pick já existem.
 */

export type DiversityMode = "off" | "shadow" | "active";

export interface DiversityConfig {
  mode: DiversityMode;
  /** Janela "já servido" pro penalty (SQL modifier, ex "-72 hours"). */
  windowSql: string;
  /** Força do novelty penalty. penalty = min(pMax, λ·log1p(n_serves)). */
  lambda: number;
  /** Teto do penalty (≈ 1 termo de salience). Impede zerar candidatos. */
  pMax: number;
  /** pain ≥ painFloor ⇒ penalty = 0 (incidents críticos imunes). */
  painFloor: number;
  /** Nº de slots reservados pra freshness (novidade recente relevante). */
  freshSlots: number;
  /** Piso de relevância pro freshness slot (não trazer lixo recente). */
  freshMinImp: number;
  freshMinPain: number;
  /** Idade máx (dias) pra contar como "recente" no freshness slot. */
  freshMaxAgeDays: number;
}

/** Defaults conservadores calibrados em D3 (2026-06-13). */
export const DIVERSITY_DEFAULTS: Omit<DiversityConfig, "mode"> = {
  windowSql: "-72 hours",
  lambda: 0.05,
  pMax: 0.15,
  painFloor: 0.9,
  freshSlots: 2,
  freshMinImp: 0.7,
  freshMinPain: 0.7,
  freshMaxAgeDays: 7,
};

function parseMode(raw: string | undefined): DiversityMode {
  if (raw === "shadow" || raw === "active") return raw;
  return "off";
}

function parseNum(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Lê NOX_BRIEF_DIVERSITY* do env; default off + calibração D3. */
export function diversityConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): DiversityConfig {
  const windowHours = parseNum(env.NOX_BRIEF_DIV_WINDOW_HOURS, 72);
  return {
    mode: parseMode(env.NOX_BRIEF_DIVERSITY),
    windowSql: `-${Math.max(1, Math.round(windowHours))} hours`,
    lambda: parseNum(env.NOX_BRIEF_DIV_LAMBDA, DIVERSITY_DEFAULTS.lambda),
    pMax: parseNum(env.NOX_BRIEF_DIV_PMAX, DIVERSITY_DEFAULTS.pMax),
    painFloor: parseNum(env.NOX_BRIEF_DIV_PAIN_FLOOR, DIVERSITY_DEFAULTS.painFloor),
    freshSlots: Math.max(0, Math.round(parseNum(env.NOX_BRIEF_DIV_FRESH_SLOTS, DIVERSITY_DEFAULTS.freshSlots))),
    freshMinImp: parseNum(env.NOX_BRIEF_DIV_FRESH_MIN_IMP, DIVERSITY_DEFAULTS.freshMinImp),
    freshMinPain: parseNum(env.NOX_BRIEF_DIV_FRESH_MIN_PAIN, DIVERSITY_DEFAULTS.freshMinPain),
    freshMaxAgeDays: Math.max(1, Math.round(parseNum(env.NOX_BRIEF_DIV_FRESH_MAX_AGE_DAYS, DIVERSITY_DEFAULTS.freshMaxAgeDays))),
  };
}

/**
 * Novelty penalty (parte A). Satura em log pra que servir 2.000× ≈ servir 100×;
 * cap em pMax pra nunca esmagar; floor de pain pra blindar incidents críticos.
 */
export function noveltyPenalty(nServes: number, pain: number, cfg: DiversityConfig): number {
  if (pain >= cfg.painFloor) return 0; // high-pain floor (invariante #4)
  if (nServes <= 0) return 0;
  return Math.min(cfg.pMax, cfg.lambda * Math.log1p(nServes));
}

/** brief_score = salience − penalty (re-rank pós-salience, invariante #1). */
export function briefScore(salience: number, nServes: number, pain: number, cfg: DiversityConfig): number {
  return salience - noveltyPenalty(nServes, pain, cfg);
}

export interface BriefDiff {
  current_ids: number[];
  alt_ids: number[];
  would_enter: number[]; // no alt, não no current
  would_leave: number[]; // no current, não no alt
  fresh_added: number[]; // slots de freshness preenchidos
  churn: number; // |would_enter| (= |would_leave| quando n igual)
}

/** Diff estrutural pro shadow log (gate D2 mede sobre isto + brief_log real). */
export function diffBriefs(
  currentIds: number[],
  altIds: number[],
  freshIds: number[] = [],
): BriefDiff {
  const cur = new Set(currentIds);
  const alt = new Set(altIds);
  const wouldEnter = altIds.filter((id) => !cur.has(id));
  const wouldLeave = currentIds.filter((id) => !alt.has(id));
  return {
    current_ids: currentIds,
    alt_ids: altIds,
    would_enter: wouldEnter,
    would_leave: wouldLeave,
    fresh_added: freshIds,
    churn: wouldEnter.length,
  };
}
