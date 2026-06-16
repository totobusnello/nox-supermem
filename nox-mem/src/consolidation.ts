// E10 (2026-05-03): Consolidation merge candidate detection (DRY-RUN ONLY).
// Gate D01 (R01 nDCG≥0.6) NÃO passou — apply bloqueado. Esta versão só identifica candidatos.
// Quando R01 atingir 0.6, adicionar --apply protegido por withOpAudit().

import { getDb } from "./db.js";

export interface MergeCandidate {
  primary: { id: number; name: string; type: string; mentions: number };
  duplicate: { id: number; name: string; type: string; mentions: number };
  similarity: number;
  reason: 'exact_lower' | 'substring' | 'levenshtein' | 'normalized';
  shared_evidence_chunks: number;
  fp_risk: 'low' | 'medium' | 'high';
  fp_reasons: string[];
}

export interface ConsolidationResult {
  scanned_entities: number;
  candidate_pairs: number;
  by_type: Record<string, number>;
  by_fp_risk: Record<string, number>;
  candidates: MergeCandidate[];
  duration_ms: number;
}

function normalize(s: string): string {
  // CODE-FIX HIGH: literal combining marks brittle across editors → use ̀-ͯ escape
  return s
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // strip diacritics (combining marks block)
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const v0 = new Array(bl + 1);
  const v1 = new Array(bl + 1);
  for (let i = 0; i <= bl; i++) v0[i] = i;
  for (let i = 0; i < al; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < bl; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let k = 0; k <= bl; k++) v0[k] = v1[k];
  }
  return v1[bl];
}

function levRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// NOX_PROTECTED_NAMES: comma-separated names that should NEVER be auto-merged.
// Default is empty — a new standalone operator has no personal names to protect.
// On the origin VPS restore the original behavior by setting:
//   NOX_PROTECTED_NAMES=toto,nox,forge,atlas,boris,cipher,lex,openclaw,anthropic,gemini,claude
const PROTECTED_NAMES = new Set<string>(
  process.env.NOX_PROTECTED_NAMES
    ? process.env.NOX_PROTECTED_NAMES.split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
    : [] // empty: standalone operators have no pre-set protected names
); // never auto-merge names in this set: FP risk catastrophic

function assessFpRisk(c: Omit<MergeCandidate, 'fp_risk' | 'fp_reasons'>): { risk: 'low' | 'medium' | 'high'; reasons: string[] } {
  const reasons: string[] = [];
  let risk: 'low' | 'medium' | 'high' = 'low';

  const pNorm = normalize(c.primary.name);
  const dNorm = normalize(c.duplicate.name);

  if (PROTECTED_NAMES.has(pNorm) || PROTECTED_NAMES.has(dNorm)) {
    reasons.push("protected name (NOX_PROTECTED_NAMES — never auto-merge)");
    risk = 'high';
  }

  // mention_count disparity: high diff = different entities
  const mentionRatio = Math.max(c.primary.mentions, c.duplicate.mentions) / Math.max(1, Math.min(c.primary.mentions, c.duplicate.mentions));
  if (mentionRatio > 10) {
    reasons.push(`mention disparity ${mentionRatio.toFixed(1)}× — likely distinct entities`);
    if (risk !== 'high') risk = 'medium';
  }

  // No shared evidence chunks: weak link
  if (c.shared_evidence_chunks === 0 && c.similarity < 0.95) {
    reasons.push("zero shared evidence chunks + sim<0.95");
    if (risk !== 'high') risk = 'medium';
  }

  // Names that are pure abbreviations of each other (e.g. "AI" vs "AI Corp")
  const lenDiff = Math.abs(pNorm.length - dNorm.length);
  if (lenDiff > 8 && c.reason === 'substring') {
    reasons.push("substring + large length diff — possible abbreviation FP");
    if (risk !== 'high') risk = 'medium';
  }

  if (reasons.length === 0) reasons.push("clean: same type, high sim, mention parity");
  return { risk, reasons };
}

export function findMergeCandidates(opts: { minSim?: number; maxPerType?: number } = {}): ConsolidationResult {
  const start = Date.now();
  const db = getDb();
  const minSim = opts.minSim ?? 0.85;
  const maxPerType = opts.maxPerType ?? 1000;

  const entities = db.prepare(
    "SELECT id, name, entity_type as type, mention_count as mentions FROM kg_entities ORDER BY entity_type, mention_count DESC"
  ).all() as Array<{ id: number; name: string; type: string; mentions: number }>;

  // CODE-FIX HIGH: pré-computa entity → chunks set em UMA query, evita N² SQL inner
  const entityChunks = new Map<number, Set<number>>();
  const allRels = db.prepare(
    "SELECT source_entity_id, target_entity_id, evidence_chunk_id FROM kg_relations WHERE evidence_chunk_id IS NOT NULL"
  ).all() as Array<{ source_entity_id: number; target_entity_id: number; evidence_chunk_id: number }>;
  for (const r of allRels) {
    if (!entityChunks.has(r.source_entity_id)) entityChunks.set(r.source_entity_id, new Set());
    if (!entityChunks.has(r.target_entity_id)) entityChunks.set(r.target_entity_id, new Set());
    entityChunks.get(r.source_entity_id)!.add(r.evidence_chunk_id);
    entityChunks.get(r.target_entity_id)!.add(r.evidence_chunk_id);
  }

  const candidates: MergeCandidate[] = [];
  const byType = new Map<string, Array<typeof entities[0]>>();
  for (const e of entities) {
    if (!byType.has(e.type)) byType.set(e.type, []);
    byType.get(e.type)!.push(e);
  }

  for (const [, group] of byType) {
    if (group.length > maxPerType) continue; // skip pathological groups
    for (let i = 0; i < group.length; i++) {
      const a = group[i];
      const aNorm = normalize(a.name);
      for (let j = i + 1; j < group.length; j++) {
        const b = group[j];
        const bNorm = normalize(b.name);

        let sim = 0;
        let reason: MergeCandidate['reason'] | null = null;

        if (aNorm === bNorm) {
          sim = 1.0;
          reason = 'normalized';
        } else if (aNorm.length >= 4 && bNorm.length >= 4 && (aNorm.includes(bNorm) || bNorm.includes(aNorm))) {
          sim = Math.min(aNorm.length, bNorm.length) / Math.max(aNorm.length, bNorm.length);
          reason = 'substring';
        } else {
          const ratio = levRatio(aNorm, bNorm);
          if (ratio >= minSim) {
            sim = ratio;
            reason = 'levenshtein';
          }
        }

        if (!reason || sim < minSim) continue;

        // CODE-FIX HIGH: in-memory intersect from precomputed map (was N+1 SQL inner)
        const aChunks = entityChunks.get(a.id);
        const bChunks = entityChunks.get(b.id);
        let sharedCount = 0;
        if (aChunks && bChunks) {
          // iterate menor pra performance
          const [smaller, larger] = aChunks.size <= bChunks.size ? [aChunks, bChunks] : [bChunks, aChunks];
          for (const c of smaller) if (larger.has(c)) sharedCount++;
        }
        const sharedEvidence = { c: sharedCount };

        const primary = a.mentions >= b.mentions ? a : b;
        const duplicate = primary === a ? b : a;
        const baseCand = {
          primary: { id: primary.id, name: primary.name, type: primary.type, mentions: primary.mentions },
          duplicate: { id: duplicate.id, name: duplicate.name, type: duplicate.type, mentions: duplicate.mentions },
          similarity: Math.round(sim * 1000) / 1000,
          reason,
          shared_evidence_chunks: sharedEvidence.c,
        };
        const fp = assessFpRisk(baseCand);
        candidates.push({ ...baseCand, fp_risk: fp.risk, fp_reasons: fp.reasons });
      }
    }
  }

  // Sort by sim desc, then by mentions
  candidates.sort((a, b) => b.similarity - a.similarity || b.primary.mentions - a.primary.mentions);

  const byTypeCount: Record<string, number> = {};
  const byFpRisk: Record<string, number> = { low: 0, medium: 0, high: 0 };
  for (const c of candidates) {
    byTypeCount[c.primary.type] = (byTypeCount[c.primary.type] || 0) + 1;
    byFpRisk[c.fp_risk]++;
  }

  return {
    scanned_entities: entities.length,
    candidate_pairs: candidates.length,
    by_type: byTypeCount,
    by_fp_risk: byFpRisk,
    candidates,
    duration_ms: Date.now() - start,
  };
}

export function formatConsolidation(r: ConsolidationResult, mode: 'json' | 'text' = 'text', limit = 30): string {
  if (mode === 'json') return JSON.stringify(r, null, 2);
  const lines: string[] = [];
  lines.push(`## consolidate-merge (E10 dry-run — gate D01 R01≥0.6 not yet passed, apply blocked)`);
  lines.push(`Scanned: ${r.scanned_entities} entities | Candidates: ${r.candidate_pairs} pairs | Duration: ${r.duration_ms}ms`);
  lines.push(`By FP risk: low=${r.by_fp_risk.low} medium=${r.by_fp_risk.medium} high=${r.by_fp_risk.high}`);
  lines.push(`By type: ${Object.entries(r.by_type).map(([t, n]) => `${t}=${n}`).join(", ")}`);
  if (r.candidate_pairs === 0) {
    lines.push(`\n(no candidates above similarity threshold — KG already consolidated for this scan)`);
    return lines.join("\n");
  }
  const safeCandidates = r.candidates.filter((c) => c.fp_risk === 'low').slice(0, limit);
  if (safeCandidates.length > 0) {
    lines.push(`\n### 🟢 LOW FP risk (${r.by_fp_risk.low}) — first ${safeCandidates.length}`);
    for (const c of safeCandidates) {
      lines.push(`   sim=${c.similarity} [${c.primary.type}] "${c.primary.name}" (${c.primary.mentions} m, id=${c.primary.id}) ⊕ "${c.duplicate.name}" (${c.duplicate.mentions} m, id=${c.duplicate.id}) via ${c.reason}, shared_evidence=${c.shared_evidence_chunks}`);
    }
  }
  if (r.by_fp_risk.medium > 0) {
    lines.push(`\n### 🟡 MEDIUM FP risk (${r.by_fp_risk.medium}) — sample`);
    for (const c of r.candidates.filter((c) => c.fp_risk === 'medium').slice(0, 10)) {
      lines.push(`   sim=${c.similarity} [${c.primary.type}] "${c.primary.name}" ⊕ "${c.duplicate.name}" — ${c.fp_reasons.join("; ")}`);
    }
  }
  if (r.by_fp_risk.high > 0) {
    lines.push(`\n### 🔴 HIGH FP risk (${r.by_fp_risk.high}) — protected/risky, NEVER auto-merge`);
    for (const c of r.candidates.filter((c) => c.fp_risk === 'high').slice(0, 10)) {
      lines.push(`   sim=${c.similarity} [${c.primary.type}] "${c.primary.name}" ⊕ "${c.duplicate.name}" — ${c.fp_reasons.join("; ")}`);
    }
  }
  lines.push(`\n📌 Apply blocked: gate D01 = R01 nDCG ≥ 0.6 + dry-run zero FP. Current Run #9 = 0.519. Reactivate when R01c improves.`);
  return lines.join("\n");
}
