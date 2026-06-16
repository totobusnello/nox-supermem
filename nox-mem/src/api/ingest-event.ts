/**
 * F4b — POST /api/ingest-event (Session Priming Loop, Fluxo D)
 *
 * Write-side do loop: a sessão deposita um digest tipado ao encerrar.
 * "Toda sessão nasce contextualizada E MORRE CONTRIBUINDO."
 *
 * Specs (memoria-nox):
 *   - PRD:  specs/2026-06-04-session-priming-loop.md (§7 Fluxo D, §4.4)
 *   - Base: specs/2026-05-17-P2-hooks-autocapture.md (§4 endpoint; este módulo
 *     implementa o SUBSET kind=session_end. Desvio documentado de P2 §6: o
 *     digest vai DIRETO pra `chunks` como type=daily — a tabela `agent_events`
 *     separada do P2 é pro autocapture full de ~170 eventos/sessão, que não é
 *     o caso aqui: 1 digest/sessão.)
 *
 * Invariantes:
 *   - Append-only em `chunks` (INSERT, nunca UPDATE/DELETE) — guardas de
 *     op-audit (regra #6) não aplicam; FTS entra via trigger chunks_ai;
 *     embedding fica pro vectorize (nightly cron / canary self-heal).
 *   - Decaível por padrão (PRD §4.4): chunk_type=daily, retention_days=90.
 *     O crystallize nightly promove o que sobreviver à curadoria.
 *   - Dedup por (kind, session_id) — mesma sessão NUNCA ingere 2× (re-POST
 *     idempotente retorna deduped:true).
 *   - Auth: o token gate global do api-server (F2) já exige Bearer em
 *     requests proxiadas (x-forwarded-for); localhost direto passa.
 *   - Privacy (espírito do P2 §5 sem a dependência A1 full): redaction
 *     server-side de padrões de credencial conhecidos + redaction_count
 *     no response.
 */

// ─── Tipos estruturais (mesmo padrão de brief.ts) ────────────────────────────

interface PreparedStatement {
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): unknown;
}

export interface IngestDb {
  prepare(sql: string): PreparedStatement;
  exec(sql: string): void;
}

// ─── Contrato ────────────────────────────────────────────────────────────────

export interface IngestEventRequest {
  kind: string; // "session_end" | "pre_compact"
  session_id: string;
  scope?: string; // projeto/origem (basename do cwd no Mac)
  host?: string; // "mac" | "vps" | hostname
  content: string; // o digest em markdown
  /** Discriminador de ocorrência pra kinds que disparam N× por sessão
   *  (pre_compact compacta várias vezes em sessão longa). Idempotência
   *  vira (kind, session_id, seq); ausente = (kind, session_id). */
  seq?: string;
}

export type IngestEventResponse = { status: number; body: unknown };

const SUPPORTED_KINDS = new Set(["session_end", "pre_compact"]);
const SESSION_ID_RE = /^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,99}$/u;
const SCOPE_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;
const HOST_RE = /^[a-z0-9][a-z0-9.-]{0,31}$/;
const SEQ_RE = /^[A-Za-z0-9._-]{1,32}$/;
const MAX_CONTENT_BYTES = 16 * 1024;
const RETENTION_DAYS_DAILY = 90;

// ─── Redaction (padrões de credencial conhecidos; P2 §5 espírito) ────────────

const REDACTION_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{30,}/g, // Google API keys
  /AQ\.[0-9A-Za-z_-]{30,}/g, // Google API keys formato 2026
  /sk-[0-9A-Za-z_-]{20,}/g, // OpenAI-style
  /ghp_[0-9A-Za-z]{30,}/g, // GitHub PAT
  /xox[baprs]-[0-9A-Za-z-]{10,}/g, // Slack
  /Bearer\s+[0-9A-Za-z._~+/=-]{16,}/g, // Authorization headers colados
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactSecrets(text: string): { clean: string; count: number } {
  let count = 0;
  let clean = text;
  for (const re of REDACTION_PATTERNS) {
    clean = clean.replace(re, () => {
      count++;
      return "[REDACTED]";
    });
  }
  return { clean, count };
}

// ─── Validação ───────────────────────────────────────────────────────────────

export function parseIngestEvent(
  body: unknown,
): { ok: true; req: Required<Omit<IngestEventRequest, "scope" | "host" | "seq">> & Pick<IngestEventRequest, "scope" | "host" | "seq"> } | { ok: false; error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body JSON objeto é obrigatório" };
  }
  const b = body as Record<string, unknown>;

  const kind = typeof b.kind === "string" ? b.kind : "";
  if (!SUPPORTED_KINDS.has(kind)) {
    return { ok: false, error: `kind não suportado (v1: ${[...SUPPORTED_KINDS].join(", ")})` };
  }

  const sessionId = typeof b.session_id === "string" ? b.session_id.trim() : "";
  if (!SESSION_ID_RE.test(sessionId)) {
    return { ok: false, error: "session_id inválido (alfanumérico ._:- , máx 100)" };
  }

  const content = typeof b.content === "string" ? b.content : "";
  if (!content.trim()) return { ok: false, error: "content é obrigatório" };
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    return { ok: false, error: `content excede ${MAX_CONTENT_BYTES} bytes` };
  }

  let scope: string | undefined;
  if (b.scope !== undefined && b.scope !== "") {
    if (typeof b.scope !== "string" || !SCOPE_RE.test(b.scope)) {
      return { ok: false, error: "scope inválido" };
    }
    scope = b.scope;
  }

  let host: string | undefined;
  if (b.host !== undefined && b.host !== "") {
    if (typeof b.host !== "string" || !HOST_RE.test(b.host)) {
      return { ok: false, error: "host inválido" };
    }
    host = b.host;
  }

  let seq: string | undefined;
  if (b.seq !== undefined && b.seq !== "") {
    if (typeof b.seq !== "string" || !SEQ_RE.test(b.seq)) {
      return { ok: false, error: "seq inválido (alfanumérico ._- , máx 32)" };
    }
    seq = b.seq;
  }

  return { ok: true, req: { kind, session_id: sessionId, content, scope, host, seq } };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export function handleIngestEvent(db: IngestDb, body: unknown): IngestEventResponse {
  const parsed = parseIngestEvent(body);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  const req = parsed.req;

  // Dedup por (kind, session_id, seq) — idempotente. seq ausente compara
  // contra '' dos dois lados (session_end clássico = 1 por sessão).
  const dupe = db
    .prepare(
      `SELECT id FROM chunks
        WHERE chunk_type = 'daily'
          AND metadata IS NOT NULL
          AND json_extract(metadata, '$.session_id') = ?
          AND json_extract(metadata, '$.kind') = ?
          AND IFNULL(json_extract(metadata, '$.seq'), '') = ?
        LIMIT 1`,
    )
    .get(req.session_id, req.kind, req.seq ?? "") as { id: number } | undefined;
  if (dupe) {
    return { status: 200, body: { deduped: true, chunk_id: dupe.id } };
  }

  const { clean, count: redactionCount } = redactSecrets(req.content);

  const host = req.host ?? "unknown";
  const scope = req.scope ?? "unscoped";
  // Namespace `events/` — novo, não colide com scope mapping do brief
  // (sessions/, memory/, shared/). Futuro: scope=events pra auditar o loop.
  const fileSuffix = req.seq ? `-${req.seq}` : "";
  const sourceFile = `events/${host}/${scope}/${req.session_id}${fileSuffix}.md`;
  const today = new Date().toISOString().slice(0, 10);
  const headLabel = req.kind === "pre_compact" ? "Compaction digest" : "Session digest";
  const text = `## ${headLabel} — ${scope} (${host}, ${today})\n\n${clean}`;
  const metadata = JSON.stringify({
    source: "ingest-event",
    kind: req.kind,
    session_id: req.session_id,
    ...(req.seq ? { seq: req.seq } : {}),
    scope,
    host,
    redaction_count: redactionCount,
  });

  const info = db
    .prepare(
      `INSERT INTO chunks (source_file, chunk_text, chunk_type, source_date,
                           retention_days, metadata)
       VALUES (?, ?, 'daily', ?, ?, ?)`,
    )
    .run(sourceFile, text, today, RETENTION_DAYS_DAILY, metadata) as { lastInsertRowid: number | bigint };

  return {
    status: 201,
    body: {
      ingested: true,
      chunk_id: Number(info.lastInsertRowid),
      retention_days: RETENTION_DAYS_DAILY,
      redaction_count: redactionCount,
    },
  };
}
