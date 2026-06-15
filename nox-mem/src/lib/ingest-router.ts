// ingest-router.ts — Single dispatch entry point para ingestão de arquivos.
// A2 (2026-04-25): paga débito arquitetural exposto pelo incident 2026-04-25
// (reindex zerou metadata de entities porque ingestFile genérico não rotava).
//
// Pattern: TODOS os callers (CLI, MCP, watch, reindex) devem passar por routeIngest()
// pra garantir que arquivos especializados (entities, future graphify, future PDF)
// sejam handled pelos handlers corretos, sem cada caller precisar saber do roteamento.
//
// Defesa em camadas: ingestFile() ainda tem guard interno pra entity files (caso
// algum legacy caller pule o router). Mas o router é o caminho canônico daqui em diante.

import type Database from "better-sqlite3";
import { relative } from "node:path";
import { ingestFile } from "../ingest.js";
import { ingestEntityFile } from "../ingest-entity.js";
import { pdftotextProbe, PROBE_FIRST_PAGE_THRESHOLD } from "./ocr-detector.js";
import { enqueueOcrJob } from "./ocr-jobs.js";

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || "/root/.openclaw/workspace";

/** Engine usado pra enqueue automático em ingest. Default 'tesseract' até cloud
 * estar conectado (controlado por env NOX_OCR_DEFAULT_ENGINE, opt-in). */
const DEFAULT_OCR_ENGINE = process.env.NOX_OCR_DEFAULT_ENGINE ?? "tesseract";

export type IngestKind = "entity" | "markdown" | "graphify" | "pdf-scanned";

export interface IngestRouteResult {
  chunks: number;
  kind: IngestKind;
  routedTo: string;
  /** Para 'pdf-scanned' kind: jobId enfileirado. */
  ocrJobId?: number;
}

export interface IngestOpts {
  externalDb?: Database.Database;
  skipDelete?: boolean;
  forceKind?: IngestKind; // override auto-detect
}

/**
 * Detect ingest kind from path conventions. Centralizada aqui — mexer só nesse
 * arquivo quando adicionar novo tipo (ex: "pdf-text-layer", "fathom-transcript").
 */
export function detectIngestKind(filePath: string): IngestKind {
  const relPath = relative(WORKSPACE, filePath);
  if (relPath.startsWith("memory/entities/") && filePath.endsWith(".md")) return "entity";
  if (relPath.startsWith("graphify-out/") || relPath.includes("/graphify-out/")) return "graphify";
  return "markdown";
}

/**
 * Single dispatch entry point. Todos callers devem usar isso em vez de chamar
 * ingestFile()/ingestEntityFile() direto. Backward compat: kinds não-implementados
 * caem no markdown handler (ingestFile).
 */
export async function routeIngest(filePath: string, opts: IngestOpts = {}): Promise<IngestRouteResult> {
  const kind = opts.forceKind || detectIngestKind(filePath);

  // E12 (2026-05-07): pdftotext probe ANTES de markitdown pra PDFs.
  // PDFs scaneados (firstPageChars < threshold) → enqueue OCR job + return early
  // com kind='pdf-scanned'. Quando worker OCR processar, vai re-ingerir o markdown
  // gerado em cache/ocr/ via routeIngest (kind='markdown' default). Backward compat:
  // se forceKind setado, pula probe (caller sabe o que está fazendo).
  if (!opts.forceKind && filePath.toLowerCase().endsWith(".pdf")) {
    try {
      const probe = await pdftotextProbe(filePath);
      // probe.firstPageChars < 0 = pdftotext indisponível (mac dev sem poppler);
      // não tentamos OCR routing nesse caso, deixamos o caller atual seguir.
      if (probe.firstPageChars >= 0 && probe.firstPageChars < PROBE_FIRST_PAGE_THRESHOLD) {
        const enq = await enqueueOcrJob(filePath, DEFAULT_OCR_ENGINE);
        console.warn(
          `[routeIngest] PDF parece scaneado (firstPageChars=${probe.firstPageChars}); ` +
            `enqueued ocr_job id=${enq.jobId} engine=${DEFAULT_OCR_ENGINE} ` +
            `${enq.alreadyExists ? "(already-existed)" : "(new)"}`,
        );
        return {
          chunks: 0,
          kind: "pdf-scanned",
          routedTo: `enqueueOcrJob (${DEFAULT_OCR_ENGINE})`,
          ocrJobId: enq.jobId,
        };
      }
    } catch (err: any) {
      // Probe failure non-fatal: cair no fluxo normal markdown.
      console.warn(`[routeIngest] OCR probe failed (non-fatal): ${err?.message ?? err}`);
    }
  }

  switch (kind) {
    case "pdf-scanned": {
      // Caller forçou kind='pdf-scanned' (raro; típico flow é auto-detect via probe acima).
      const enq = await enqueueOcrJob(filePath, DEFAULT_OCR_ENGINE);
      return {
        chunks: 0,
        kind: "pdf-scanned",
        routedTo: `enqueueOcrJob (forced, ${DEFAULT_OCR_ENGINE})`,
        ocrJobId: enq.jobId,
      };
    }
    case "entity": {
      const r = await ingestEntityFile(filePath, opts.externalDb);
      if (r.parsed) return { chunks: r.chunks, kind: "entity", routedTo: "ingestEntityFile" };
      // Entity file failed parse — fall through to markdown ingest pra não perder dado
      const fallback = await ingestFile(filePath, opts.externalDb, opts.skipDelete);
      return { chunks: fallback.chunks, kind: "markdown", routedTo: "ingestFile (fallback after entity parse fail)" };
    }
    case "graphify":
      // Hoje não existe graphify-ingest separado pra arquivos individuais (graphify
      // produz JSON em batch via skill própria). Cair no markdown como tratamento neutro.
      // Reservado pra Wave 2+ se virar handler dedicado.
      return await ingestFile(filePath, opts.externalDb, opts.skipDelete).then((r) => ({
        chunks: r.chunks,
        kind: "graphify" as const,
        routedTo: "ingestFile (graphify path neutralized)",
      }));
    case "markdown":
    default:
      return await ingestFile(filePath, opts.externalDb, opts.skipDelete).then((r) => ({
        chunks: r.chunks,
        kind: "markdown" as const,
        routedTo: "ingestFile",
      }));
  }
}
