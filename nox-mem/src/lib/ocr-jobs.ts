// ocr-jobs.ts — Queue management para batch OCR (E12 Tier 3 foundation).
// Spec: memoria-nox/specs/2026-05-07-E12-tier3-ocr.md §5.2 + §6
//
// DB-only: sem cloud calls, sem engine invocation. Apenas:
//   - enqueue (idempotente via source_sha256 UNIQUE)
//   - status transitions (queued → running → success/failed/skipped)
//   - listar pendentes
//   - stats agregados
//
// Idempotência: re-enqueue do mesmo PDF (mesmo SHA256) retorna o mesmo jobId,
// alreadyExists=true. Cobertura do risk #7 (re-run não re-cobra cloud).

import { createHash } from "node:crypto";
import { readFileSync, statSync, existsSync } from "node:fs";
import { getDb } from "../db.js";

export type OcrJobStatus = "queued" | "running" | "success" | "failed" | "skipped";

export interface EnqueueResult {
  jobId: number;
  alreadyExists: boolean;
  status: OcrJobStatus;
}

export interface OcrJobRow {
  id: number;
  source_path: string;
  engine: string;
  source_sha256: string;
  status: OcrJobStatus;
}

export interface JobStatusExtras {
  error?: string;
  charCount?: number;
  costUsd?: number;
  pageCount?: number;
}

export interface OcrJobStats {
  total: number;
  queued: number;
  running: number;
  success: number;
  failed: number;
  skipped: number;
  totalCostUsd: number;
}

/**
 * SHA256 do conteúdo do arquivo (não do path). Garante idempotência mesmo
 * se o mesmo PDF for movido/renomeado. Streaming-safe pra arquivos grandes
 * via createHash + readFileSync chunked.
 *
 * Para foundation simples: leitura inteira (PDFs típicos <50MB; se crescer
 * trocar pra fs.createReadStream + pipe).
 */
export function sha256OfFile(filePath: string): string {
  if (!existsSync(filePath)) throw new Error(`sha256OfFile: file not found: ${filePath}`);
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Enqueue um PDF pra OCR. Idempotente: se já existe job com mesmo source_sha256,
 * retorna jobId existente + alreadyExists=true (sem reset de status).
 *
 * @param filePath caminho absoluto do PDF
 * @param engine identificador do engine (ex: 'tesseract', 'google_doc_ai')
 */
export async function enqueueOcrJob(filePath: string, engine: string): Promise<EnqueueResult> {
  if (!existsSync(filePath)) throw new Error(`enqueueOcrJob: file not found: ${filePath}`);
  const db = getDb();
  const sha = sha256OfFile(filePath);
  const sizeBytes = statSync(filePath).size;

  // Try INSERT — UNIQUE(source_sha256) garante idempotência.
  const insertStmt = db.prepare(
    "INSERT INTO ocr_jobs (source_path, source_sha256, source_size_bytes, engine, status) VALUES (?, ?, ?, ?, 'queued') ON CONFLICT(source_sha256) DO NOTHING",
  );
  const r = insertStmt.run(filePath, sha, sizeBytes, engine);

  if (r.changes > 0) {
    return { jobId: Number(r.lastInsertRowid), alreadyExists: false, status: "queued" };
  }

  // Job já existe — fetch jobId e status atual.
  const existing = db
    .prepare("SELECT id, status FROM ocr_jobs WHERE source_sha256 = ?")
    .get(sha) as { id: number; status: OcrJobStatus } | undefined;
  if (!existing) {
    // Edge case: INSERT falhou + SELECT vazio = race ou DB corruption.
    throw new Error(`enqueueOcrJob: insert ON CONFLICT but row missing for sha=${sha}`);
  }
  return { jobId: existing.id, alreadyExists: true, status: existing.status };
}

/**
 * Atualiza status de um job. Side effects:
 *   - status='running' → seta started_at = now
 *   - status terminal (success/failed/skipped) → seta completed_at = now
 *   - error_message é truncado em 2000 chars
 */
export function markJobStatus(
  jobId: number,
  status: OcrJobStatus,
  extras: JobStatusExtras = {},
): void {
  const db = getDb();
  const errorMsg = extras.error
    ? extras.error.length > 2000
      ? extras.error.substring(0, 1980) + "…[truncated]"
      : extras.error
    : null;

  if (status === "running") {
    db.prepare(
      "UPDATE ocr_jobs SET status = ?, started_at = COALESCE(started_at, datetime('now')) WHERE id = ?",
    ).run(status, jobId);
    return;
  }

  // Terminal status: seta completed_at + extras.
  db.prepare(
    `UPDATE ocr_jobs
     SET status = ?,
         completed_at = datetime('now'),
         error_message = COALESCE(?, error_message),
         char_count = COALESCE(?, char_count),
         cost_usd = COALESCE(?, cost_usd),
         page_count = COALESCE(?, page_count)
     WHERE id = ?`,
  ).run(
    status,
    errorMsg,
    extras.charCount ?? null,
    extras.costUsd ?? null,
    extras.pageCount ?? null,
    jobId,
  );
}

/**
 * Lista jobs em status 'queued' (FIFO por created_at).
 * Usado pelo worker batch.
 */
export function listPendingJobs(limit = 50): OcrJobRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, source_path, engine, source_sha256, status FROM ocr_jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?",
    )
    .all(limit) as OcrJobRow[];
  return rows;
}

/**
 * Stats agregados pra /api/health e CLI status.
 */
export function getJobStats(): OcrJobStats {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN status='queued'  THEN 1 ELSE 0 END), 0) AS queued,
         COALESCE(SUM(CASE WHEN status='running' THEN 1 ELSE 0 END), 0) AS running,
         COALESCE(SUM(CASE WHEN status='success' THEN 1 ELSE 0 END), 0) AS success,
         COALESCE(SUM(CASE WHEN status='failed'  THEN 1 ELSE 0 END), 0) AS failed,
         COALESCE(SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END), 0) AS skipped,
         COALESCE(SUM(cost_usd), 0)                                  AS totalCostUsd
       FROM ocr_jobs`,
    )
    .get() as OcrJobStats;
  return row;
}

/**
 * Reset de jobs orphan ('running' há mais de N horas) pra 'queued'.
 * Útil em startup pra recuperar de crash mid-batch.
 * @param staleHours threshold em horas
 */
export function resetOrphanJobs(staleHours = 6): number {
  const db = getDb();
  const r = db
    .prepare(
      `UPDATE ocr_jobs
       SET status = 'queued', started_at = NULL
       WHERE status = 'running'
         AND started_at IS NOT NULL
         AND started_at < datetime('now', ?)`,
    )
    .run(`-${staleHours} hours`);
  return r.changes;
}
