// google-doc-ai.ts — GoogleDocAiEngine (E12 Tier 3 cloud OCR).
// Spec: memoria-nox/specs/2026-05-07-E12-tier3-ocr.md §3.5 + §4
//
// Implementa interface `OcrEngine` definida em ../ocr-engine-stub.ts.
// SDK: @google-cloud/documentai (carrega creds via GOOGLE_APPLICATION_CREDENTIALS).
//
// MVP scope:
//   - sync API (processDocument) pra arquivos <5MB / single-shot
//   - retry 3× exponential backoff em RESOURCE_EXHAUSTED / UNAVAILABLE
//   - mimeType detection: pdf, png, jpeg, tiff
//   - cost estimate: $1.50 / 1k pages (OCR processor pricing 2026-05)
//   - fail-soft em arquivos >5MB (batchProcess deferido — requer GCS bucket)
//
// Renderização: usa `document.text` raw (preserva \n). Tabelas com layout
// estruturado podem ser convertidas a markdown table em sessão futura — pra
// MVP, raw text é suficiente pro pipeline routeIngest → ingestMarkdown.

import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { OcrEngine, OcrResult } from "../ocr-engine-stub.js";

// SDK type — lazy-loaded import pra evitar require em ESM e custo de boot
// quando engine não é usado.
type DocAiClient = {
  processDocument(req: {
    name: string;
    rawDocument: { content: Buffer | Uint8Array; mimeType: string };
    skipHumanReview?: boolean;
  }): Promise<[DocAiResponse, unknown, unknown]>;
};

interface DocAiResponse {
  document?: {
    text?: string | null;
    pages?: unknown[] | null;
  } | null;
}

// Cost: $1.50 / 1k pages (Document AI OCR processor, 2026-05).
// https://cloud.google.com/document-ai/pricing
const PRICE_PER_PAGE_USD = 0.0015;

// MVP: sync API limit. Doc AI sync `processDocument` aceita até ~20MB no wire,
// mas Google recomenda batchProcess pra >5MB / multi-page. Fail-soft cutoff.
const MAX_SYNC_BYTES = 5 * 1024 * 1024;

// Retry config. Test override via NOX_OCR_BACKOFF_MS.
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = Number(process.env.NOX_OCR_BACKOFF_MS ?? 1_000);
// Códigos retryable (gRPC + Doc AI semânticos).
const RETRYABLE_CODES = new Set([
  "RESOURCE_EXHAUSTED",
  "UNAVAILABLE",
  "DEADLINE_EXCEEDED",
  8, // RESOURCE_EXHAUSTED numeric
  14, // UNAVAILABLE numeric
  4, // DEADLINE_EXCEEDED numeric
]);

export interface GoogleDocAiEngineOpts {
  projectId?: string;
  location?: string;
  processorId?: string;
  /** Override pra testes — injeta um client mock. */
  client?: DocAiClient;
}

export class GoogleDocAiEngine implements OcrEngine {
  readonly name = "google_doc_ai";

  private clientPromise: Promise<DocAiClient> | null = null;
  private readonly processorName: string;
  private readonly injectedClient: DocAiClient | undefined;

  constructor(opts: GoogleDocAiEngineOpts = {}) {
    const projectId = opts.projectId ?? process.env.GCP_PROJECT_ID;
    const location = opts.location ?? process.env.GCP_DOCAI_LOCATION ?? "us";
    const processorId = opts.processorId ?? process.env.GCP_DOCAI_PROCESSOR_ID;

    if (!projectId) {
      throw new Error(
        "GoogleDocAiEngine: GCP_PROJECT_ID required (env or constructor opt). " +
          "Set in /root/.openclaw/.env on VPS or pass projectId.",
      );
    }
    if (!processorId) {
      throw new Error(
        "GoogleDocAiEngine: GCP_DOCAI_PROCESSOR_ID required (env or constructor opt).",
      );
    }
    this.processorName = `projects/${projectId}/locations/${location}/processors/${processorId}`;
    this.injectedClient = opts.client;
  }

  estimateCostUsd(pageCount: number): number {
    if (!Number.isFinite(pageCount) || pageCount <= 0) return 0;
    return pageCount * PRICE_PER_PAGE_USD;
  }

  async ocrFile(filePath: string): Promise<OcrResult> {
    const stat = statSync(filePath);
    if (stat.size > MAX_SYNC_BYTES) {
      throw new Error(
        `GoogleDocAiEngine: file too large for sync API (${stat.size} bytes > ${MAX_SYNC_BYTES}). ` +
          "MVP fail-soft: batchProcess (requires GCS bucket) deferred — split PDF or fallback to tesseract.",
      );
    }

    const content = readFileSync(filePath);
    const mimeType = detectMimeType(filePath);
    const client = await this.getClient();

    // Imageless mode: bumps Doc AI sync page limit 15→30 (saves retry on 16-30 page docs).
    // Trade-off: response omits image data — we only consume `document.text` so this is free.
    const [response] = await this.callWithRetry(() =>
      client.processDocument({
        name: this.processorName,
        rawDocument: { content, mimeType },
        skipHumanReview: true,
        imagelessMode: true,
      } as any),
    );

    const doc = response.document ?? {};
    const markdown = (doc.text ?? "").toString();
    const pageCount = Array.isArray(doc.pages) ? doc.pages.length : 0;

    return {
      markdown,
      pageCount,
      costUsd: this.estimateCostUsd(pageCount),
    };
  }

  private async getClient(): Promise<DocAiClient> {
    if (this.injectedClient) return this.injectedClient;
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        // Dynamic import — ESM path, evita require + permite engine carregar
        // mesmo se SDK não estiver instalado (lança erro só no primeiro uso).
        const mod: any = await import("@google-cloud/documentai");
        const Client = mod?.DocumentProcessorServiceClient ?? mod?.v1?.DocumentProcessorServiceClient;
        if (!Client) {
          throw new Error(
            "GoogleDocAiEngine: @google-cloud/documentai SDK shape unexpected. " +
              "Re-run `npm install @google-cloud/documentai`.",
          );
        }
        // Default credential resolution: GOOGLE_APPLICATION_CREDENTIALS env var
        // → service account JSON file. SDK handles auth.
        return new Client() as DocAiClient;
      })();
    }
    return this.clientPromise;
  }

  private async callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: any;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        lastErr = err;
        const code = err?.code ?? err?.details?.code;
        const retryable = RETRYABLE_CODES.has(code) || RETRYABLE_CODES.has(String(code));
        if (!retryable || attempt === MAX_RETRIES) {
          throw enrichError(err);
        }
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt);
        await sleep(backoff);
      }
    }
    throw enrichError(lastErr);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function detectMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".bmp":
      return "image/bmp";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      // Doc AI accepts pdf/image only — for unknown ext, default to pdf
      // (caller almost always passes PDFs in OCR pipeline).
      return "application/pdf";
  }
}

function enrichError(err: any): Error {
  const code = err?.code ?? err?.details?.code ?? "UNKNOWN";
  const msg = err?.message ?? String(err);
  const wrapped = new Error(`GoogleDocAiEngine: Doc AI request failed [code=${code}]: ${msg}`);
  (wrapped as any).cause = err;
  return wrapped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
