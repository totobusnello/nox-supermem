// E-lite-2 v5 — vocab expansion pra security/temporal/scan_dependent gaps
// Adiciona ~35 termos novos baseados em análise das queries reais que falharam.

const COGNATES: ReadonlySet<string> = new Set([
  // v4 base
  "chunk", "schema", "embedding", "cache", "query", "search", "index",
  "batch", "cron", "snapshot", "backup", "database", "token", "pipeline",
  "fts5", "rrf", "bm25", "cosine", "hybrid", "semantic", "dense", "lexical",
  "tier", "salience", "pain", "boost", "reason", "temporal",
  "webhook", "gateway", "openclaw", "systemd", "process",
  "docker", "container", "service", "restart", "sigkill",
  "gemini", "flash", "haiku", "opus", "sonnet", "model", "agent", "rerank",
  "graph", "entity", "relation", "triple", "injection",
  "shadow", "active", "auth", "reindex", "consolidate", "vectorize",
  "fratricide", "compact", "audit", "monkey-patch",
  "api", "fts", "spo", "kg",
  "plugin", "section", "retention", "heartbeat", "watchdog", "probe",
  "migration", "rollback", "recovery", "protocol", "sanitizer",
  "degradation", "fallback", "fault",
  // v5 NEW — security vocab
  "secret", "credential", "chmod", "chattr", "permission",
  "binary", "risk", "vulnerable", "exploit", "leak",
  "rotate", "rotation", "key", "sed", "rsync",
  // v5 NEW — temporal vocab
  "when", "first", "last", "deployed", "activated", "bumped",
  "incident", "milestone",
  // v5 NEW — scan/OCR vocab
  "ocr", "scan", "scanned", "document", "pdf", "tesseract",
  "contract", "certificate", "notary", "protocol",
]);

const TRANSLATIONS: ReadonlyMap<string, string> = new Map([
  // v4 base
  ["reindexar", "reindex"], ["reiniciar", "restart"], ["ativar", "activate"],
  ["desativar", "deactivate"], ["erro", "error"], ["falha", "failure"],
  ["segurança", "security"], ["configuração", "configuration"], ["busca", "search"],
  ["memória", "memory"], ["arquivo", "file"], ["pasta", "folder"],
  ["comando", "command"], ["consulta", "query"], ["resposta", "response"],
  ["mudança", "change"], ["execução", "execution"], ["desempenho", "performance"],
  ["latência", "latency"], ["rede", "network"], ["banco", "database"],
  ["tabela", "table"], ["coluna", "column"], ["agente", "agent"],
  ["recuperação", "recovery"], ["restauração", "restoration"],
  ["registro", "log"], ["ferramenta", "tool"], ["evolução", "evolution"],
  ["fluxo", "flow"], ["rotina", "routine"], ["incidente", "incident"],
  ["gatilho", "trigger"], ["seção", "section"], ["retenção", "retention"],
  ["porta", "port"], ["regra", "rule"],
  // v5 NEW — security
  ["segredos", "secrets"], ["credenciais", "credentials"], ["chave", "key"],
  ["permissão", "permission"], ["rotacionar", "rotate"], ["binário", "binary"],
  ["vulnerável", "vulnerable"], ["vazamento", "leak"],
  // v5 NEW — temporal
  ["quando", "when"], ["primeira", "first"], ["última", "last"],
  ["deployado", "deployed"], ["subiu", "bumped"], ["mudou", "changed"],
  ["lição", "lesson"],
  // v5 NEW — scan/OCR
  ["documento", "document"], ["digitalizado", "scanned"],
  ["escaneado", "scanned"], ["escritura", "deed"], ["cartório", "notary"],
  ["consulado", "consulate"], ["cidadania", "citizenship"],
  ["contrato", "contract"], ["protocolo", "protocol"], ["certidão", "certificate"],
  ["imóvel", "property"], ["cláusula", "clause"],
]);

const REVERSE_TRANSLATIONS: ReadonlyMap<string, string> = new Map(
  [...TRANSLATIONS.entries()].map(([pt, en]) => [en, pt])
);

// Base entity set: neutral tech/platform names always recognized.
// Personal agent aliases and org names are configurable via NOX_PROTECTED_NAMES
// (comma-separated). Default is empty so a standalone operator gets no origin
// names baked in — set NOX_PROTECTED_NAMES=atlas,boris,nox,myorg in .env.
const _BASE_ENTITIES = new Set([
  "gemini", "claude", "openai", "cohere",
  "discord", "slack", "whatsapp", "telegram", "hotmart", "github",
  "sqlite", "postgres", "redis",
]);
const _protectedNames = (process.env.NOX_PROTECTED_NAMES ?? "")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const ENTITIES: ReadonlySet<string> = new Set([..._BASE_ENTITIES, ..._protectedNames]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makePattern(term: string): RegExp {
  const escaped = escapeRegex(term);
  if (term.length <= 3) {
    return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "i");
  }
  return new RegExp(`(?<![A-Za-z0-9_])(${escaped})\\w*(?![A-Za-z0-9])`, "i");
}

const COGNATE_PATTERNS = new Map<string, RegExp>(
  [...COGNATES].map((t) => [t, makePattern(t)])
);
const TRANS_PATTERNS = new Map<string, RegExp>(
  [...TRANSLATIONS.keys()].map((pt) => [pt, makePattern(pt)])
);
const REV_TRANS_PATTERNS = new Map<string, RegExp>(
  [...REVERSE_TRANSLATIONS.keys()].map((en) => [en, makePattern(en)])
);
const ENTITY_PATTERNS = new Map<string, RegExp>(
  [...ENTITIES].map((t) => [t, makePattern(t)])
);

const IDENTIFIER_PATTERNS: RegExp[] = [
  /(?<![A-Za-z0-9_])[A-Z][A-Z_]{3,}(?![A-Za-z0-9_])/g,
  /(?<![A-Za-z0-9_])[a-z]+[A-Z][a-zA-Z]+(?![A-Za-z0-9_])/g,
  /(?<![A-Za-z0-9_])[a-z][a-z]+_[a-z][a-z_]+(?![A-Za-z0-9_])/g,
  /(?<![A-Za-z0-9_])v\d+(?:\.\d+){1,2}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_])(?:schema|version|migration)\s+v?\d+/gi,
  /(?<![A-Za-z0-9_])nox-mem\s+\w+/gi,
  /(?<![A-Za-z0-9_])[a-z_][a-z_]{2,}\.(?:ts|js|py|md|sh|json|yaml|yml)(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_])\d{4}-\d{2}-\d{2}(?![A-Za-z0-9])/g,
];

export function extractAnchors(text: string): string {
  const anchors = new Set<string>();

  for (const [term, pattern] of COGNATE_PATTERNS) {
    if (pattern.test(text)) anchors.add(term);
  }
  for (const [pt, pattern] of TRANS_PATTERNS) {
    if (pattern.test(text)) {
      const en = TRANSLATIONS.get(pt);
      if (en) anchors.add(en);
    }
  }
  for (const [en, pattern] of REV_TRANS_PATTERNS) {
    if (pattern.test(text)) {
      const pt = REVERSE_TRANSLATIONS.get(en);
      if (pt) anchors.add(pt);
    }
  }
  for (const [term, pattern] of ENTITY_PATTERNS) {
    if (pattern.test(text)) anchors.add(term);
  }
  for (const pat of IDENTIFIER_PATTERNS) {
    const matches = text.match(pat);
    if (matches) {
      for (const m of matches) {
        if (m.length >= 4) anchors.add(m.toLowerCase());
      }
    }
  }

  return [...anchors].sort().join(" ");
}
