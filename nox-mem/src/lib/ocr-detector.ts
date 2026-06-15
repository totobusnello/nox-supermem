// ocr-detector.ts — Heurísticas de detecção de PDF scaneado (E12 Tier 3).
// Spec: memoria-nox/specs/2026-05-07-E12-tier3-ocr.md §2
//
// Sem cloud calls. Apenas:
//   1. char count pós-markitdown (heurística primária)
//   2. pdftotext probe na primeira página (zero-cost pre-flight)
//   3. routing decision combinando probe + hints (force, folder prior)
//
// Memória ref: feedback_scanned_pdf_heuristic (markitdown sem OCR retorna ~2 chars).
// execFileSync (não execSync) — regra security feedback_execfilesync_over_execsync_for_user_input.

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Threshold de char count abaixo do qual um PDF é considerado scaneado.
 * Markitdown sem OCR tipicamente retorna 2-50 chars em PDFs imagem.
 */
export const SCANNED_PDF_CHAR_THRESHOLD = 100;

/**
 * Threshold de tamanho/ratio: PDF >5MB com <0.001 chars/byte → provável scan
 * (densidade de texto extremamente baixa).
 */
export const LARGE_PDF_BYTES_THRESHOLD = 5_000_000;
export const LARGE_PDF_CHAR_RATIO = 0.001;

/**
 * Threshold da pdftotext probe na primeira página.
 * <50 chars na 1ª página é forte indicador de scan.
 */
export const PROBE_FIRST_PAGE_THRESHOLD = 50;

/**
 * Folders com prior alto de PDF scaneado. Gera `route=true` mesmo sem probe.
 * Lista propositalmente conservadora — overrides via `--force-ocr` no CLI.
 */
const SCAN_PRIOR_FOLDERS = ["/Documents/PPR/", "/Documents/PESSOAL/"];

/**
 * Heurística primária pós-markitdown.
 *
 * @param markitdownOutput texto extraído pelo markitdown (vazio ou ~2 chars = sinal forte)
 * @param fileSize tamanho do PDF em bytes
 * @returns true se PDF é provavelmente scaneado
 */
export function isScannedPdf(markitdownOutput: string, fileSize: number): boolean {
  if (!markitdownOutput) return true;
  // Strip whitespace pra char count "real".
  const stripped = markitdownOutput.replace(/\s+/g, "").trim();
  if (stripped.length < SCANNED_PDF_CHAR_THRESHOLD) return true;
  // Sanity check: PDF grande com densidade text/byte muito baixa = scan.
  if (fileSize > LARGE_PDF_BYTES_THRESHOLD && stripped.length / fileSize < LARGE_PDF_CHAR_RATIO) {
    return true;
  }
  return false;
}

export interface PdftotextProbeResult {
  likelyScan: boolean;
  firstPageChars: number;
  /** -1 sentinela quando pdftotext não está disponível ou crash. */
  error?: string;
}

/**
 * Pre-flight zero-cost: extrai apenas a 1ª página via pdftotext e conta chars.
 * Usa execFileSync (regra security: argumento como array, sem shell).
 *
 * Graceful: se pdftotext não está instalado, retorna `{ likelyScan: false, firstPageChars: -1 }`
 * com warn em stderr — caller decide fallback (markitdown direto, OCR enqueue, etc).
 */
export async function pdftotextProbe(filePath: string): Promise<PdftotextProbeResult> {
  if (!existsSync(filePath)) {
    return { likelyScan: false, firstPageChars: -1, error: `file not found: ${filePath}` };
  }
  try {
    const out = execFileSync("pdftotext", ["-l", "1", filePath, "-"], {
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 5 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const stripped = (out || "").replace(/\s+/g, "").trim();
    return {
      likelyScan: stripped.length < PROBE_FIRST_PAGE_THRESHOLD,
      firstPageChars: stripped.length,
    };
  } catch (err: any) {
    const code = err?.code || err?.errno;
    const msg = String(err?.message ?? err);
    // ENOENT = pdftotext não instalado (não-fatal: caller decide).
    if (code === "ENOENT") {
      console.warn("[ocr-detector] pdftotext not installed; skipping probe (apt install poppler-utils OR brew install poppler)");
      return { likelyScan: false, firstPageChars: -1, error: "pdftotext not installed" };
    }
    console.warn(`[ocr-detector] pdftotext probe failed: ${msg}`);
    return { likelyScan: false, firstPageChars: -1, error: msg };
  }
}

export interface OcrRouteHint {
  /** Override manual: força routing pra OCR mesmo se probe disser não. */
  force?: boolean;
  /** Path/folder prior (ex: PPR/, PESSOAL/) — força route=true sem probe. */
  folder?: string;
}

export interface OcrRouteDecision {
  route: boolean;
  reason: string;
}

/**
 * Combina file-size + pdftotext probe + hints (force, folder prior) pra decidir
 * se PDF deve ser roteado pra OCR pipeline.
 *
 * Ordem de precedência:
 *   1. opts.force=true → route=true ("forced")
 *   2. arquivo não existe → route=false ("file-not-found")
 *   3. arquivo está em SCAN_PRIOR_FOLDERS → route=true ("folder-prior")
 *   4. probe.firstPageChars < threshold → route=true ("probe-scan")
 *   5. probe.firstPageChars > threshold → route=false ("probe-text")
 *   6. probe error/unavailable → route=false ("probe-unavailable", caller usa heurística pós-markitdown)
 */
export async function shouldRouteToOcr(
  filePath: string,
  hint: OcrRouteHint = {},
): Promise<OcrRouteDecision> {
  if (hint.force) return { route: true, reason: "forced" };
  if (!existsSync(filePath)) return { route: false, reason: "file-not-found" };

  const abs = resolve(filePath);
  // Normaliza separadores pra cobrir POSIX (Linux VPS) + Windows-likely-never.
  const folderHint = hint.folder ? resolve(hint.folder) : abs;
  for (const prior of SCAN_PRIOR_FOLDERS) {
    if (folderHint.includes(prior) || abs.includes(prior)) {
      return { route: true, reason: "folder-prior" };
    }
  }

  // Não é PDF? routing pra OCR não se aplica.
  if (!filePath.toLowerCase().endsWith(".pdf")) {
    return { route: false, reason: "not-pdf" };
  }

  const probe = await pdftotextProbe(filePath);
  if (probe.firstPageChars < 0) {
    return { route: false, reason: `probe-unavailable:${probe.error ?? "unknown"}` };
  }
  if (probe.likelyScan) {
    return { route: true, reason: `probe-scan:firstPageChars=${probe.firstPageChars}` };
  }

  // Sanity: file gigante com poucos chars na probe → também route.
  try {
    const sizeBytes = statSync(filePath).size;
    if (sizeBytes > LARGE_PDF_BYTES_THRESHOLD && probe.firstPageChars < SCANNED_PDF_CHAR_THRESHOLD) {
      return { route: true, reason: `large-file-low-text:${sizeBytes}b-${probe.firstPageChars}chars` };
    }
  } catch {
    /* stat failure non-fatal */
  }

  return { route: false, reason: `probe-text:firstPageChars=${probe.firstPageChars}` };
}
