// ocr-engine-stub.ts — Interface OcrEngine + stub local Tesseract + factory.
// Spec: memoria-nox/specs/2026-05-07-E12-tier3-ocr.md §3.1 + §4
//
// Engines:
//   - Interface canônica `OcrEngine` (estimateCostUsd + ocrFile)
//   - TesseractEngine: wrapper local (graceful failure se não instalado)
//   - GoogleDocAiEngine: cloud Document AI (impl em ./ocr-engines/google-doc-ai.ts)
//
// Cloud (2026-05-07): GCP creds em /root/.openclaw/.env (GOOGLE_APPLICATION_CREDENTIALS).

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";

export interface OcrResult {
  /** Markdown rendered output. Tabelas Doc AI → markdown tables; preserva \n\n. */
  markdown: string;
  /** Page count detectado (Tesseract via pdfinfo, Doc AI via response). */
  pageCount: number;
  /** Cost real do engine (Tesseract = 0; cloud = chamada billable). */
  costUsd: number;
}

export interface OcrEngine {
  /** Identificador estável do engine (persistido em ocr_jobs.engine). */
  readonly name: string;
  /**
   * Custo estimado em USD pra processar `pageCount` páginas.
   * Tesseract: 0. Google Doc AI: ~$1.50/1k pages.
   */
  estimateCostUsd(pageCount: number): number;
  /** Roda OCR no arquivo e retorna markdown + metadata. */
  ocrFile(filePath: string): Promise<OcrResult>;
}

// ─────────────────────────────────────────────────────────────────────
// TesseractEngine — local CPU OCR via tesseract-ocr + poppler-utils
// ─────────────────────────────────────────────────────────────────────

/**
 * Detecta se tesseract + pdftoppm estão instalados.
 * Retorna { available, missing[] } pra mensagens UX claras.
 */
export function detectTesseractAvailability(): { available: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const bin of ["tesseract", "pdftoppm"]) {
    try {
      execFileSync("which", [bin], { stdio: "ignore", timeout: 5_000 });
    } catch {
      missing.push(bin);
    }
  }
  return { available: missing.length === 0, missing };
}

const TESSERACT_INSTALL_HINT =
  "Tesseract OCR not installed. Install with:\n" +
  "  macOS:  brew install tesseract tesseract-lang poppler\n" +
  "  Debian: apt install tesseract-ocr tesseract-ocr-por poppler-utils\n" +
  "Then re-run ocr-batch.";

export class TesseractEngine implements OcrEngine {
  readonly name = "tesseract";
  private readonly lang: string;

  constructor(opts: { lang?: string } = {}) {
    this.lang = opts.lang ?? "por";
  }

  estimateCostUsd(_pageCount: number): number {
    // Local CPU: zero opex marginal (VPS já provisionado).
    return 0;
  }

  async ocrFile(filePath: string): Promise<OcrResult> {
    if (!existsSync(filePath)) throw new Error(`TesseractEngine: file not found: ${filePath}`);
    const avail = detectTesseractAvailability();
    if (!avail.available) {
      throw new Error(`${TESSERACT_INSTALL_HINT}\nMissing: ${avail.missing.join(", ")}`);
    }

    const abs = resolve(filePath);
    const ext = abs.split(".").pop()?.toLowerCase() ?? "";

    // Path 1: image inputs — tesseract handles natively.
    if (["jpg", "jpeg", "png", "tif", "tiff", "bmp", "gif"].includes(ext)) {
      return this.ocrImage(abs);
    }

    // Path 2: PDF — needs pdftoppm conversion first.
    // Tesseract NÃO suporta PDF nativamente (foundation impl bug 2026-05-08).
    if (ext === "pdf") {
      return this.ocrPdfViaConversion(abs);
    }

    throw new Error(`TesseractEngine: unsupported extension '${ext}' for file ${abs}`);
  }

  private async ocrImage(abs: string): Promise<OcrResult> {
    const stdout = this.runTesseract(abs);
    return { markdown: stdout.trim(), pageCount: 1, costUsd: 0 };
  }

  private async ocrPdfViaConversion(pdfPath: string): Promise<OcrResult> {
    // Workflow: pdftoppm → /tmp/ocr-<rand>-page-NN.png → tesseract per page → concat.
    // 200 DPI default (good balance recall vs runtime).
    const { mkdtempSync, rmSync, readdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: pjoin } = await import("node:path");

    const tmpDir = mkdtempSync(pjoin(tmpdir(), "ocr-tess-"));
    try {
      const prefix = pjoin(tmpDir, "page");
      // pdftoppm: -png -r 200 = 200 DPI. -progress for progress info (ignored).
      execFileSync("pdftoppm", ["-png", "-r", "200", pdfPath, prefix], {
        timeout: 300_000, // 5min for conversion
        stdio: ["ignore", "ignore", "ignore"],
      });

      // Collect generated images, sort numerically (page-1, page-2, ..., page-10).
      const files = readdirSync(tmpDir)
        .filter((f) => f.startsWith("page") && f.endsWith(".png"))
        .sort((a, b) => {
          const na = parseInt(a.match(/page-?(\d+)/)?.[1] ?? "0", 10);
          const nb = parseInt(b.match(/page-?(\d+)/)?.[1] ?? "0", 10);
          return na - nb;
        });

      if (files.length === 0) {
        throw new Error(`TesseractEngine: pdftoppm produced 0 images from ${pdfPath}`);
      }

      // OCR pages with bounded concurrency (default 3 workers; tunable via env
      // NOX_TESSERACT_CONCURRENCY=N). Speedup: ~3-4× vs sequential on 4-core VPS.
      // Tesseract is CPU-bound C++; OS handles real parallelism via child processes.
      const concurrency = Math.max(
        1,
        Math.min(parseInt(process.env.NOX_TESSERACT_CONCURRENCY ?? "3", 10), 8),
      );
      const texts: string[] = new Array(files.length);
      let nextIdx = 0;
      const workers = Array.from({ length: concurrency }, async () => {
        while (true) {
          const i = nextIdx++;
          if (i >= files.length) return;
          const text = this.runTesseract(pjoin(tmpDir, files[i]));
          texts[i] = text.trim();
        }
      });
      await Promise.all(workers);
      const markdown = texts.join("\n\n\n\n").trim();
      return { markdown, pageCount: files.length, costUsd: 0 };
    } finally {
      // Best-effort cleanup; ignore errors if tmpDir already gone.
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // intentionally ignored — cleanup is best-effort
      }
    }
  }

  private runTesseract(imagePath: string): string {
    try {
      return execFileSync("tesseract", [imagePath, "-", "-l", this.lang, "--psm", "1"], {
        encoding: "utf-8",
        timeout: 120_000, // 2min per page
        maxBuffer: 50 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (err: any) {
      throw new Error(`TesseractEngine: ocr failed on ${imagePath}: ${err?.message ?? err}`);
    }
  }

  private async detectPageCount(filePath: string): Promise<number> {
    try {
      const out = execFileSync("pdfinfo", [filePath], {
        encoding: "utf-8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const match = out.match(/^Pages:\s+(\d+)/m);
      return match ? parseInt(match[1], 10) : 0;
    } catch {
      return 0;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────
// Factory — dispatch por nome
// ─────────────────────────────────────────────────────────────────────

/**
 * Factory por nome. Cria engine apropriado.
 *  - "tesseract" → TesseractEngine (CPU local, $0)
 *  - "google_doc_ai" → GoogleDocAiEngine (cloud, $1.50/1k pages)
 */
export function createEngine(name: string, opts: Record<string, unknown> = {}): OcrEngine {
  switch (name) {
    case "tesseract":
      return new TesseractEngine({ lang: (opts.lang as string) ?? "por" });
    case "google_doc_ai": {
      // Lazy require — evita custo de boot quando engine não usado.
      // Import síncrono via require() não funciona em ESM; usamos um helper
      // que exporta a classe pra inserir aqui em runtime.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { GoogleDocAiEngine } = loadGoogleDocAiSync();
      return new GoogleDocAiEngine({
        projectId: opts.projectId as string | undefined,
        location: opts.location as string | undefined,
        processorId: opts.processorId as string | undefined,
      });
    }
    default:
      throw new Error(`Unknown OCR engine: ${name}. Valid: tesseract, google_doc_ai.`);
  }
}

/** Alias: caller-friendly name esperado pela spec. */
export function getEngine(name: string, opts: Record<string, unknown> = {}): OcrEngine {
  return createEngine(name, opts);
}

// Helper sync-loader pra GoogleDocAiEngine. ESM dynamic `import()` é async, mas
// createEngine é sync — usamos createRequire (ESM-safe) pra resolver compiled JS.
const _require = createRequire(import.meta.url);
function loadGoogleDocAiSync(): { GoogleDocAiEngine: new (opts?: any) => OcrEngine } {
  return _require("./ocr-engines/google-doc-ai.js") as {
    GoogleDocAiEngine: new (opts?: any) => OcrEngine;
  };
}
