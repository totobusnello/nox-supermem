// google-doc-ai.test.ts — testa GoogleDocAiEngine com client mockado.
// Não faz network call. Valida:
//   - cost calc ($1.50 / 1k pages)
//   - request shape (processorName + mimeType correto)
//   - retry exponential em RESOURCE_EXHAUSTED / UNAVAILABLE
//   - throws non-retryable errors
//   - fail-soft em arquivos >5MB
//   - mimeType detection per ext
//
// Run: npx tsc && node --test dist/__tests__/google-doc-ai.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Test mode: zero backoff (must be set BEFORE import — module reads env at load).
process.env.NOX_OCR_BACKOFF_MS = "1";

const { GoogleDocAiEngine } = await import("../lib/ocr-engines/google-doc-ai.js");

const TMP = mkdtempSync(join(tmpdir(), "docai-test-"));
function makeFile(name: string, bytes: number): string {
  const p = join(TMP, name);
  writeFileSync(p, Buffer.alloc(bytes, 0x41)); // padding
  return p;
}

function mockClient(opts: {
  text?: string;
  pageCount?: number;
  failures?: Array<{ code: string | number; message?: string }>;
  capture?: { req?: any; calls: number };
}) {
  const failures = opts.failures ?? [];
  let call = 0;
  return {
    processDocument: async (req: any) => {
      call++;
      if (opts.capture) {
        opts.capture.calls = call;
        opts.capture.req = req;
      }
      if (failures.length > 0) {
        const f = failures.shift()!;
        const err: any = new Error(f.message ?? `mock-${f.code}`);
        err.code = f.code;
        throw err;
      }
      const pages = Array.from({ length: opts.pageCount ?? 1 }, (_, i) => ({ pageNumber: i + 1 }));
      return [
        {
          document: {
            text: opts.text ?? "OCR output text",
            pages,
          },
        },
        null,
        null,
      ];
    },
  };
}

test("estimateCostUsd: $1.50 / 1k pages", () => {
  const eng = new GoogleDocAiEngine({
    projectId: "p",
    processorId: "pr",
    client: mockClient({}) as any,
  });
  assert.equal(eng.estimateCostUsd(1000), 1.5);
  assert.equal(eng.estimateCostUsd(100), 0.15);
  assert.equal(eng.estimateCostUsd(0), 0);
  assert.equal(eng.estimateCostUsd(-5), 0);
  assert.equal(eng.estimateCostUsd(NaN), 0);
});

test("constructor: throws sem GCP_PROJECT_ID", () => {
  const prev = process.env.GCP_PROJECT_ID;
  delete process.env.GCP_PROJECT_ID;
  try {
    assert.throws(() => new GoogleDocAiEngine({ processorId: "x" }), /GCP_PROJECT_ID required/);
  } finally {
    if (prev !== undefined) process.env.GCP_PROJECT_ID = prev;
  }
});

test("constructor: throws sem GCP_DOCAI_PROCESSOR_ID", () => {
  const prev = process.env.GCP_DOCAI_PROCESSOR_ID;
  delete process.env.GCP_DOCAI_PROCESSOR_ID;
  try {
    assert.throws(
      () => new GoogleDocAiEngine({ projectId: "x" }),
      /GCP_DOCAI_PROCESSOR_ID required/,
    );
  } finally {
    if (prev !== undefined) process.env.GCP_DOCAI_PROCESSOR_ID = prev;
  }
});

test("ocrFile: request shape (processorName + mimeType pdf)", async () => {
  const capture = { calls: 0 };
  const eng = new GoogleDocAiEngine({
    projectId: "myp",
    location: "us",
    processorId: "myproc",
    client: mockClient({ text: "hello", pageCount: 3, capture }) as any,
  });
  const f = makeFile("test.pdf", 1024);
  const r = await eng.ocrFile(f);
  assert.equal(r.markdown, "hello");
  assert.equal(r.pageCount, 3);
  // 3 * 0.0015 = 0.0045 (float). Allow ±1e-6 tolerance.
  assert.ok(Math.abs(r.costUsd - 0.0045) < 1e-6, `cost ${r.costUsd}`);
  assert.equal((capture as any).req.name, "projects/myp/locations/us/processors/myproc");
  assert.equal((capture as any).req.rawDocument.mimeType, "application/pdf");
});

test("ocrFile: mimeType detection (png, jpeg, tiff)", async () => {
  for (const [ext, expected] of [
    [".png", "image/png"],
    [".jpg", "image/jpeg"],
    [".jpeg", "image/jpeg"],
    [".tiff", "image/tiff"],
    [".tif", "image/tiff"],
  ] as const) {
    const capture = { calls: 0 };
    const eng = new GoogleDocAiEngine({
      projectId: "p",
      processorId: "pr",
      client: mockClient({ capture }) as any,
    });
    const f = makeFile(`test${ext}`, 100);
    await eng.ocrFile(f);
    assert.equal((capture as any).req.rawDocument.mimeType, expected, `ext=${ext}`);
  }
});

test("ocrFile: retry exponential em RESOURCE_EXHAUSTED, sucesso na 2ª", async () => {
  const eng = new GoogleDocAiEngine({
    projectId: "p",
    processorId: "pr",
    client: mockClient({
      failures: [{ code: "RESOURCE_EXHAUSTED", message: "quota" }],
      text: "ok",
      pageCount: 1,
    }) as any,
  });
  const f = makeFile("retry.pdf", 100);
  const r = await eng.ocrFile(f);
  assert.equal(r.markdown, "ok");
});

test("ocrFile: retry esgota em RESOURCE_EXHAUSTED 4×", async () => {
  const eng = new GoogleDocAiEngine({
    projectId: "p",
    processorId: "pr",
    client: mockClient({
      failures: Array.from({ length: 4 }, () => ({ code: "RESOURCE_EXHAUSTED" })),
    }) as any,
  });
  const f = makeFile("exhaust.pdf", 100);
  await assert.rejects(() => eng.ocrFile(f), /Doc AI request failed.*RESOURCE_EXHAUSTED/);
});

test("ocrFile: erro não-retryable falha imediato", async () => {
  let calls = 0;
  const client = {
    processDocument: async () => {
      calls++;
      const err: any = new Error("invalid argument");
      err.code = "INVALID_ARGUMENT";
      throw err;
    },
  };
  const eng = new GoogleDocAiEngine({
    projectId: "p",
    processorId: "pr",
    client: client as any,
  });
  const f = makeFile("bad.pdf", 100);
  await assert.rejects(() => eng.ocrFile(f), /INVALID_ARGUMENT/);
  assert.equal(calls, 1, "non-retryable não deve repetir");
});

test("ocrFile: fail-soft em arquivos >5MB", async () => {
  const eng = new GoogleDocAiEngine({
    projectId: "p",
    processorId: "pr",
    client: mockClient({}) as any,
  });
  const big = makeFile("big.pdf", 6 * 1024 * 1024);
  await assert.rejects(() => eng.ocrFile(big), /file too large for sync API/);
});

test("ocrFile: retry em código numeric UNAVAILABLE (14)", async () => {
  const eng = new GoogleDocAiEngine({
    projectId: "p",
    processorId: "pr",
    client: mockClient({
      failures: [{ code: 14, message: "transient" }],
      text: "recovered",
      pageCount: 2,
    }) as any,
  });
  const f = makeFile("num.pdf", 100);
  const r = await eng.ocrFile(f);
  assert.equal(r.markdown, "recovered");
  assert.equal(r.pageCount, 2);
});

test("name = 'google_doc_ai'", () => {
  const eng = new GoogleDocAiEngine({
    projectId: "p",
    processorId: "pr",
    client: mockClient({}) as any,
  });
  assert.equal(eng.name, "google_doc_ai");
});
