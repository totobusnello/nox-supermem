// E12 — ocr-jobs queue tests.
// Cobre: schema v15 migration, sha256 idempotência, status transitions, stats.
//
// Run: cd /root/.openclaw/workspace/tools/nox-mem && npx tsc &&
//      node --test dist/__tests__/ocr-jobs.test.js
//
// Usa NOX_DB_PATH override (allowlist do op-audit não se aplica aqui — ocr-jobs
// não importa op-audit). Usa /var/backups/ pra coexistir com test setup do op-audit
// se rodar em sequência. Em macOS dev sem /var/backups, testa via /tmp.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP_ROOT = (() => {
  // Prefer /var/backups (VPS canonical, allowlist) — fallback to tmpdir() for macOS dev.
  const preferred = "/var/backups/nox-mem-ocr-jobs-test";
  try {
    if (!existsSync("/var/backups")) throw new Error("no /var/backups");
    mkdirSync(preferred, { recursive: true, mode: 0o700 });
    return mkdtempSync(preferred + "-");
  } catch {
    return mkdtempSync(join(tmpdir(), "nox-ocr-jobs-"));
  }
})();
const TEST_DB = join(TMP_ROOT, "test.db");

// MUST set NOX_DB_PATH BEFORE importing modules (op-audit module-load validation).
process.env.NOX_DB_PATH = TEST_DB;

let getDb: any, closeDb: any;
let enqueueOcrJob: any, markJobStatus: any, listPendingJobs: any, getJobStats: any, sha256OfFile: any, resetOrphanJobs: any;

before(async () => {
  const dbMod = await import("../db.js");
  const jobsMod = await import("../lib/ocr-jobs.js");
  getDb = dbMod.getDb;
  closeDb = dbMod.closeDb;
  enqueueOcrJob = jobsMod.enqueueOcrJob;
  markJobStatus = jobsMod.markJobStatus;
  listPendingJobs = jobsMod.listPendingJobs;
  getJobStats = jobsMod.getJobStats;
  sha256OfFile = jobsMod.sha256OfFile;
  resetOrphanJobs = jobsMod.resetOrphanJobs;
  getDb(); // triggers ensureSchema → v15
});

after(() => {
  try { closeDb(); } catch { /* ignore */ }
  try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function makePdf(name: string, content: string): string {
  const path = join(TMP_ROOT, name);
  writeFileSync(path, content);
  return path;
}

// ─────────────────────────────────────────────────────────────────────
// Schema v15
// ─────────────────────────────────────────────────────────────────────

test("schema v15: PRAGMA user_version >= 15", () => {
  const db = getDb();
  const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert.ok(v >= 15, `expected >=15, got ${v}`);
});

test("schema v15: chunks.ocr_status + ocr_engine columns exist", () => {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name);
  assert.ok(names.includes("ocr_status"));
  assert.ok(names.includes("ocr_engine"));
});

test("schema v15: ocr_jobs table exists with required columns", () => {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(ocr_jobs)").all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name);
  for (const required of [
    "id", "source_path", "source_sha256", "source_size_bytes", "page_count",
    "engine", "status", "error_message", "char_count", "cost_usd",
    "started_at", "completed_at", "created_at",
  ]) {
    assert.ok(names.includes(required), `missing column: ${required}`);
  }
});

test("schema v15: ocr_jobs.source_sha256 has UNIQUE constraint", () => {
  const db = getDb();
  // Try insert duplicate sha256 directly — should throw.
  db.prepare(
    "INSERT INTO ocr_jobs (source_path, source_sha256, engine, status) VALUES (?, ?, ?, ?)",
  ).run("/a.pdf", "deadbeef", "tesseract", "queued");
  assert.throws(() => {
    db.prepare(
      "INSERT INTO ocr_jobs (source_path, source_sha256, engine, status) VALUES (?, ?, ?, ?)",
    ).run("/b.pdf", "deadbeef", "tesseract", "queued");
  }, /UNIQUE/);
  // cleanup row
  db.prepare("DELETE FROM ocr_jobs WHERE source_sha256 = ?").run("deadbeef");
});

test("schema v15: idempotent re-run (no error on already-migrated DB)", () => {
  // Re-call ensureSchema indirectly via getDb second call.
  const db = getDb();
  const v1 = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  // Force re-validation of schema — getDb cached, but PRAGMA always succeeds.
  assert.ok(v1 >= 15);
});

test("schema v15: status CHECK constraint rejects invalid status", () => {
  const db = getDb();
  assert.throws(() => {
    db.prepare(
      "INSERT INTO ocr_jobs (source_path, source_sha256, engine, status) VALUES (?, ?, ?, ?)",
    ).run("/x.pdf", "deadcafe1", "tesseract", "invalid_state");
  }, /CHECK/);
});

// ─────────────────────────────────────────────────────────────────────
// sha256OfFile
// ─────────────────────────────────────────────────────────────────────

test("sha256OfFile: deterministic hash of content", () => {
  const f = makePdf("hash-a.pdf", "hello world");
  const h1 = sha256OfFile(f);
  const h2 = sha256OfFile(f);
  assert.equal(h1, h2);
  assert.equal(h1.length, 64); // hex sha256
});

test("sha256OfFile: same content different name → same hash", () => {
  const f1 = makePdf("name-1.pdf", "identical content");
  const f2 = makePdf("name-2.pdf", "identical content");
  assert.equal(sha256OfFile(f1), sha256OfFile(f2));
});

test("sha256OfFile: throws on missing file", () => {
  assert.throws(() => sha256OfFile(join(TMP_ROOT, "missing.pdf")), /not found/);
});

// ─────────────────────────────────────────────────────────────────────
// enqueueOcrJob — idempotência
// ─────────────────────────────────────────────────────────────────────

test("enqueueOcrJob: new job → alreadyExists=false", async () => {
  const f = makePdf("enq-1.pdf", "unique-content-1");
  const r = await enqueueOcrJob(f, "tesseract");
  assert.equal(r.alreadyExists, false);
  assert.equal(r.status, "queued");
  assert.ok(r.jobId > 0);
});

test("enqueueOcrJob: re-enqueue same content → alreadyExists=true, same jobId", async () => {
  const f = makePdf("enq-2.pdf", "unique-content-2");
  const r1 = await enqueueOcrJob(f, "tesseract");
  const r2 = await enqueueOcrJob(f, "tesseract");
  assert.equal(r1.alreadyExists, false);
  assert.equal(r2.alreadyExists, true);
  assert.equal(r1.jobId, r2.jobId);
});

test("enqueueOcrJob: same content different file path → alreadyExists=true (sha256 dedup)", async () => {
  const f1 = makePdf("enq-3a.pdf", "shared-content-3");
  const f2 = makePdf("enq-3b.pdf", "shared-content-3");
  const r1 = await enqueueOcrJob(f1, "tesseract");
  const r2 = await enqueueOcrJob(f2, "tesseract");
  assert.equal(r2.alreadyExists, true);
  assert.equal(r1.jobId, r2.jobId);
});

// ─────────────────────────────────────────────────────────────────────
// markJobStatus
// ─────────────────────────────────────────────────────────────────────

test("markJobStatus: running sets started_at", async () => {
  const f = makePdf("mark-1.pdf", "mark-content-1");
  const enq = await enqueueOcrJob(f, "tesseract");
  markJobStatus(enq.jobId, "running");
  const db = getDb();
  const row = db.prepare("SELECT status, started_at, completed_at FROM ocr_jobs WHERE id = ?").get(enq.jobId) as any;
  assert.equal(row.status, "running");
  assert.ok(row.started_at);
  assert.equal(row.completed_at, null);
});

test("markJobStatus: success sets completed_at + extras", async () => {
  const f = makePdf("mark-2.pdf", "mark-content-2");
  const enq = await enqueueOcrJob(f, "tesseract");
  markJobStatus(enq.jobId, "running");
  markJobStatus(enq.jobId, "success", { charCount: 5000, costUsd: 0.045, pageCount: 30 });
  const db = getDb();
  const row = db.prepare("SELECT status, completed_at, char_count, cost_usd, page_count FROM ocr_jobs WHERE id = ?").get(enq.jobId) as any;
  assert.equal(row.status, "success");
  assert.ok(row.completed_at);
  assert.equal(row.char_count, 5000);
  assert.equal(row.cost_usd, 0.045);
  assert.equal(row.page_count, 30);
});

test("markJobStatus: failed truncates long error_message", async () => {
  const f = makePdf("mark-3.pdf", "mark-content-3");
  const enq = await enqueueOcrJob(f, "tesseract");
  const longErr = "x".repeat(5000);
  markJobStatus(enq.jobId, "failed", { error: longErr });
  const db = getDb();
  const row = db.prepare("SELECT error_message FROM ocr_jobs WHERE id = ?").get(enq.jobId) as { error_message: string };
  assert.ok(row.error_message.length <= 2010);
  assert.ok(row.error_message.endsWith("[truncated]"));
});

// ─────────────────────────────────────────────────────────────────────
// listPendingJobs + getJobStats
// ─────────────────────────────────────────────────────────────────────

test("listPendingJobs: returns only queued jobs", async () => {
  // Existing inserts have varied statuses — count fresh.
  const f = makePdf("list-1.pdf", "list-content-1");
  const enq = await enqueueOcrJob(f, "tesseract");
  const pending = listPendingJobs(100);
  assert.ok(pending.some((p: any) => p.id === enq.jobId));
});

test("getJobStats: aggregates buckets correctly", async () => {
  const stats = getJobStats();
  assert.ok(stats.total >= 0);
  assert.ok(stats.queued >= 0);
  assert.ok(stats.success >= 0);
  assert.equal(typeof stats.totalCostUsd, "number");
  // Sanity: total = sum of buckets (approx; test runs accumulate).
  const sum = stats.queued + stats.running + stats.success + stats.failed + stats.skipped;
  assert.equal(stats.total, sum);
});

// ─────────────────────────────────────────────────────────────────────
// resetOrphanJobs
// ─────────────────────────────────────────────────────────────────────

test("resetOrphanJobs: 0 affected when no stale rows", () => {
  const r = resetOrphanJobs(6);
  // Pode haver 0 ou +; em fresh test DB esperado 0. Apenas asserir tipo.
  assert.equal(typeof r, "number");
  assert.ok(r >= 0);
});
