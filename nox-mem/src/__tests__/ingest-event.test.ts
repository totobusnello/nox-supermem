// F4b — testes do POST /api/ingest-event (Session Priming Loop, Fluxo D).
// Spec: memoria-nox specs/2026-06-04-session-priming-loop.md §7 Fluxo D.
//
// Run: cd tools/nox-mem && npx tsc && node --test dist/__tests__/ingest-event.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  parseIngestEvent,
  redactSecrets,
  handleIngestEvent,
  type IngestDb,
} from "../api/ingest-event.js";

function makeDb(): IngestDb & InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      source_file TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      chunk_type TEXT NOT NULL DEFAULT 'other',
      source_date TEXT,
      retention_days INTEGER,
      pain REAL DEFAULT 0.2,
      importance REAL DEFAULT 0.5,
      access_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      metadata TEXT
    );
  `);
  return db as unknown as IngestDb & InstanceType<typeof Database>;
}

const VALID = {
  kind: "session_end",
  session_id: "22759044-5115-4b3c-923a-78600ffb9b75",
  scope: "memoria-nox",
  host: "mac",
  content: "## Resumo\nF4b implementado e testado.",
};

// ─── Validação ───────────────────────────────────────────────────────────────

test("parse: kind não suportado / session_id inválido / content vazio → erro", () => {
  assert.equal(parseIngestEvent({ ...VALID, kind: "tool_use" }).ok, false);
  assert.equal(parseIngestEvent({ ...VALID, session_id: "a b" }).ok, false);
  assert.equal(parseIngestEvent({ ...VALID, content: "   " }).ok, false);
  assert.equal(parseIngestEvent(null).ok, false);
  assert.equal(parseIngestEvent([1]).ok, false);
});

test("parse: content > 16KB rejeitado", () => {
  const r = parseIngestEvent({ ...VALID, content: "x".repeat(17 * 1024) });
  assert.equal(r.ok, false);
});

test("parse: scope/host opcionais mas validados quando presentes", () => {
  assert.ok(parseIngestEvent({ ...VALID, scope: undefined, host: undefined }).ok);
  assert.equal(parseIngestEvent({ ...VALID, scope: "a b" }).ok, false);
  assert.equal(parseIngestEvent({ ...VALID, host: "MAC!" }).ok, false);
});

// ─── Redaction ───────────────────────────────────────────────────────────────

test("redaction: keys conhecidas viram [REDACTED] com count", () => {
  const dirty = [
    "key google AIzaSyBnyA1s81RyTkQAvs6jX0000000000000000",
    "formato novo AQ.Ab8RN6L8iAZBLSS8hy40000000000000000000000",
    "openai sk-abcdefghij1234567890ABCDEFGHIJ",
    "github ghp_abcdefghijklmnopqrstuvwxyz123456",
    "header Authorization: Bearer abc.def-ghi_jkl~mno+pqr/stu=123456",
  ].join("\n");
  const { clean, count } = redactSecrets(dirty);
  assert.ok(count >= 5, `esperava ≥5 redactions, veio ${count}`);
  assert.ok(!clean.includes("AIzaSy"), "AIza vazou");
  assert.ok(!clean.includes("AQ.Ab8"), "AQ. vazou");
  assert.ok(!clean.includes("sk-abcdefghij"), "sk- vazou");
  assert.ok(clean.includes("[REDACTED]"));
});

test("redaction: texto limpo passa intacto com count 0", () => {
  const { clean, count } = redactSecrets("digest normal sem segredos, AQ e sk soltos não casam");
  assert.equal(count, 0);
  assert.ok(clean.includes("digest normal"));
});

// ─── Handler ─────────────────────────────────────────────────────────────────

test("handle: happy path — chunk daily/90d no namespace events/ com metadata", () => {
  const db = makeDb();
  const out = handleIngestEvent(db, VALID);
  assert.equal(out.status, 201);
  const body = out.body as { ingested: boolean; chunk_id: number };
  assert.ok(body.ingested && body.chunk_id > 0);

  const row = db
    .prepare("SELECT * FROM chunks WHERE id = ?")
    .get(body.chunk_id) as Record<string, unknown>;
  assert.equal(row.chunk_type, "daily");
  assert.equal(row.retention_days, 90);
  assert.ok((row.source_file as string).startsWith("events/mac/memoria-nox/"));
  assert.ok((row.chunk_text as string).startsWith("## Session digest — memoria-nox"));
  const meta = JSON.parse(row.metadata as string);
  assert.equal(meta.session_id, VALID.session_id);
  assert.equal(meta.kind, "session_end");
  assert.equal(meta.source, "ingest-event");
});

test("handle: dedup por session_id — re-POST idempotente, 1 chunk só", () => {
  const db = makeDb();
  const first = handleIngestEvent(db, VALID);
  const second = handleIngestEvent(db, { ...VALID, content: "conteúdo diferente no retry" });
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.deepEqual(
    (second.body as { deduped: boolean }).deduped,
    true,
  );
  const n = db.prepare("SELECT COUNT(*) c FROM chunks").get() as { c: number };
  assert.equal(n.c, 1);
});

test("handle: redaction aplicada no chunk persistido + count no response", () => {
  const db = makeDb();
  const out = handleIngestEvent(db, {
    ...VALID,
    session_id: "sessao-com-segredo",
    content: "vazou a key AIzaSyBnyA1s81RyTkQAvs6jX0000000000000000 no digest",
  });
  assert.equal(out.status, 201);
  assert.equal((out.body as { redaction_count: number }).redaction_count, 1);
  const row = db
    .prepare("SELECT chunk_text FROM chunks WHERE json_extract(metadata,'$.session_id')='sessao-com-segredo'")
    .get() as { chunk_text: string };
  assert.ok(!row.chunk_text.includes("AIzaSy"));
  assert.ok(row.chunk_text.includes("[REDACTED]"));
});

test("handle: 400 em body inválido", () => {
  const db = makeDb();
  assert.equal(handleIngestEvent(db, { kind: "session_end" }).status, 400);
  assert.equal(handleIngestEvent(db, "string").status, 400);
});

// ─── pre_compact (sessões longas compactam N×) ──────────────────────────────

test("pre_compact: múltiplas compactions da MESMA sessão ingerem (seq distinto)", () => {
  const db = makeDb();
  const base = { ...VALID, kind: "pre_compact", session_id: "sessao-longa-1" };
  const a = handleIngestEvent(db, { ...base, seq: "1780620001", content: "digest compaction 1" });
  const b = handleIngestEvent(db, { ...base, seq: "1780629999", content: "digest compaction 2" });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  const n = db.prepare("SELECT COUNT(*) c FROM chunks").get() as { c: number };
  assert.equal(n.c, 2);
  const row = db.prepare("SELECT source_file, chunk_text FROM chunks ORDER BY id LIMIT 1").get() as { source_file: string; chunk_text: string };
  assert.ok(row.source_file.includes("sessao-longa-1-1780620001"));
  assert.ok(row.chunk_text.startsWith("## Compaction digest"));
});

test("pre_compact: mesmo seq = dedup idempotente; seq inválido = 400", () => {
  const db = makeDb();
  const base = { ...VALID, kind: "pre_compact", session_id: "sessao-longa-2", seq: "1780620001" };
  assert.equal(handleIngestEvent(db, base).status, 201);
  assert.equal((handleIngestEvent(db, base).body as { deduped: boolean }).deduped, true);
  assert.equal(handleIngestEvent(db, { ...base, seq: "a b!" }).status, 400);
});

test("pre_compact não colide com session_end da mesma sessão (kinds distintos)", () => {
  const db = makeDb();
  const sid = "sessao-mista";
  assert.equal(handleIngestEvent(db, { ...VALID, session_id: sid, kind: "pre_compact", seq: "111" }).status, 201);
  assert.equal(handleIngestEvent(db, { ...VALID, session_id: sid }).status, 201);
  const n = db.prepare("SELECT COUNT(*) c FROM chunks").get() as { c: number };
  assert.equal(n.c, 2);
});
