// E12 — ocr-engine-stub tests.
// Cobre: TesseractEngine cost=0, factory dispatch, GoogleDocAi placeholder error.
//
// NÃO testa execução real de tesseract (requer binários). Apenas interface +
// graceful failure quando bin missing.
//
// Run: cd /root/.openclaw/workspace/tools/nox-mem && npx tsc &&
//      node --test dist/__tests__/ocr-engine-stub.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TesseractEngine,
  detectTesseractAvailability,
  createEngine,
} from "../lib/ocr-engine-stub.js";

test("TesseractEngine.estimateCostUsd: always 0 (local CPU)", () => {
  const eng = new TesseractEngine();
  assert.equal(eng.estimateCostUsd(0), 0);
  assert.equal(eng.estimateCostUsd(1000), 0);
  assert.equal(eng.estimateCostUsd(25_000), 0);
});

test("TesseractEngine.name = 'tesseract'", () => {
  const eng = new TesseractEngine();
  assert.equal(eng.name, "tesseract");
});

test("detectTesseractAvailability: returns object with available + missing", () => {
  const r = detectTesseractAvailability();
  assert.equal(typeof r.available, "boolean");
  assert.ok(Array.isArray(r.missing));
});

test("TesseractEngine.ocrFile: missing file → throws", async () => {
  const eng = new TesseractEngine();
  await assert.rejects(() => eng.ocrFile("/nonexistent-pdf-path.pdf"), /not found/);
});

test("createEngine('tesseract'): returns TesseractEngine", () => {
  const eng = createEngine("tesseract");
  assert.equal(eng.name, "tesseract");
  assert.equal(eng.estimateCostUsd(100), 0);
});

test("createEngine('google_doc_ai'): instancia GoogleDocAiEngine quando env presente", () => {
  const prevP = process.env.GCP_PROJECT_ID;
  const prevPr = process.env.GCP_DOCAI_PROCESSOR_ID;
  process.env.GCP_PROJECT_ID = "test-proj";
  process.env.GCP_DOCAI_PROCESSOR_ID = "test-proc";
  try {
    const eng = createEngine("google_doc_ai");
    assert.equal(eng.name, "google_doc_ai");
    // Pricing: 1k pages = $1.50.
    assert.equal(Math.round(eng.estimateCostUsd(1000) * 100) / 100, 1.5);
  } finally {
    if (prevP === undefined) delete process.env.GCP_PROJECT_ID;
    else process.env.GCP_PROJECT_ID = prevP;
    if (prevPr === undefined) delete process.env.GCP_DOCAI_PROCESSOR_ID;
    else process.env.GCP_DOCAI_PROCESSOR_ID = prevPr;
  }
});

test("createEngine('google_doc_ai'): throws sem env vars", () => {
  const prevP = process.env.GCP_PROJECT_ID;
  const prevPr = process.env.GCP_DOCAI_PROCESSOR_ID;
  delete process.env.GCP_PROJECT_ID;
  delete process.env.GCP_DOCAI_PROCESSOR_ID;
  try {
    assert.throws(() => createEngine("google_doc_ai"), /GCP_PROJECT_ID required/);
  } finally {
    if (prevP !== undefined) process.env.GCP_PROJECT_ID = prevP;
    if (prevPr !== undefined) process.env.GCP_DOCAI_PROCESSOR_ID = prevPr;
  }
});

test("createEngine('unknown'): throws clear error", () => {
  assert.throws(() => createEngine("foo-engine"), /Unknown OCR engine/);
});
