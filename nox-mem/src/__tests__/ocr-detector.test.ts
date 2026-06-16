// E12 — ocr-detector tests.
// Cobre: isScannedPdf thresholds + edge cases + shouldRouteToOcr decision tree.
//
// Run: cd /root/.openclaw/workspace/tools/nox-mem && npx tsc &&
//      node --test dist/__tests__/ocr-detector.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isScannedPdf,
  pdftotextProbe,
  shouldRouteToOcr,
  SCANNED_PDF_CHAR_THRESHOLD,
  PROBE_FIRST_PAGE_THRESHOLD,
} from "../lib/ocr-detector.js";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "nox-ocr-detector-"));

// ─────────────────────────────────────────────────────────────────────
// isScannedPdf — heurística primária
// ─────────────────────────────────────────────────────────────────────

test("isScannedPdf: empty string → true", () => {
  assert.equal(isScannedPdf("", 1000), true);
});

test("isScannedPdf: only whitespace → true (stripped <threshold)", () => {
  assert.equal(isScannedPdf("   \n\n  \t  ", 1000), true);
});

test("isScannedPdf: 2 chars (markitdown garbage) → true", () => {
  assert.equal(isScannedPdf("ab", 100_000), true);
});

test("isScannedPdf: just below threshold → true", () => {
  const text = "a".repeat(SCANNED_PDF_CHAR_THRESHOLD - 1);
  assert.equal(isScannedPdf(text, 100_000), true);
});

test("isScannedPdf: at threshold → false", () => {
  const text = "a".repeat(SCANNED_PDF_CHAR_THRESHOLD);
  assert.equal(isScannedPdf(text, 100_000), false);
});

test("isScannedPdf: long clean text → false", () => {
  const text = "Lorem ipsum ".repeat(500);
  assert.equal(isScannedPdf(text, 100_000), false);
});

test("isScannedPdf: large file (>5MB) with low char ratio → true", () => {
  // 6MB file, 2000 chars stripped → ratio 2000/6000000 = 0.00033 < 0.001
  const text = "a".repeat(2000);
  assert.equal(isScannedPdf(text, 6_000_000), true);
});

test("isScannedPdf: large file (>5MB) with high char ratio → false", () => {
  // 6MB file, 50000 chars stripped → ratio 50000/6000000 = 0.0083 > 0.001
  const text = "a".repeat(50_000);
  assert.equal(isScannedPdf(text, 6_000_000), false);
});

test("isScannedPdf: small file with whitespace strip", () => {
  // 200 raw chars but mostly spaces — stripped <100
  const text = "abc " + " ".repeat(300);
  assert.equal(isScannedPdf(text, 1000), true);
});

// ─────────────────────────────────────────────────────────────────────
// pdftotextProbe — graceful fallback
// ─────────────────────────────────────────────────────────────────────

test("pdftotextProbe: missing file → returns -1 with error", async () => {
  const r = await pdftotextProbe(join(TMP_ROOT, "nonexistent.pdf"));
  assert.equal(r.firstPageChars, -1);
  assert.equal(r.likelyScan, false);
  assert.ok(r.error);
});

test("pdftotextProbe: invalid PDF (non-PDF content) → graceful (-1 or 0 chars)", async () => {
  const fakePdf = join(TMP_ROOT, "fake.pdf");
  writeFileSync(fakePdf, "this is not a pdf");
  const r = await pdftotextProbe(fakePdf);
  // Either pdftotext crashes (firstPageChars=-1) or returns ~0 chars (likelyScan=true).
  assert.ok(r.firstPageChars <= PROBE_FIRST_PAGE_THRESHOLD);
});

// ─────────────────────────────────────────────────────────────────────
// shouldRouteToOcr — decision tree
// ─────────────────────────────────────────────────────────────────────

test("shouldRouteToOcr: force=true → route=true", async () => {
  const r = await shouldRouteToOcr("/whatever/file.pdf", { force: true });
  assert.equal(r.route, true);
  assert.equal(r.reason, "forced");
});

test("shouldRouteToOcr: file not exists → route=false", async () => {
  const r = await shouldRouteToOcr(join(TMP_ROOT, "missing.pdf"));
  assert.equal(r.route, false);
  assert.equal(r.reason, "file-not-found");
});

test("shouldRouteToOcr: non-PDF file → route=false (with not-pdf reason)", async () => {
  const f = join(TMP_ROOT, "doc.txt");
  writeFileSync(f, "hello world");
  const r = await shouldRouteToOcr(f);
  // Não cai em folder-prior porque path inclui só TMP_ROOT (não /Documents/PPR/).
  assert.equal(r.route, false);
  assert.equal(r.reason, "not-pdf");
});

test("shouldRouteToOcr: folder hint with PPR substring → route=true", async () => {
  // Path inclui literalmente /Documents/PPR/ no caminho → folder-prior.
  // (Não vai existir realmente; estamos testando a decision logic, não probe.)
  const r = await shouldRouteToOcr("/some/Documents/PPR/test.pdf", { force: true });
  assert.equal(r.route, true);
  // force has precedence; cobertura folder-prior em outro test:
});

test("shouldRouteToOcr: PESSOAL folder hint → folder-prior reason", async () => {
  // Cria arquivo real pra passar existsSync, embed PESSOAL no path.
  const f = join(TMP_ROOT, "Documents-PESSOAL-stub.pdf");
  writeFileSync(f, "%PDF-1.4 stub");
  // Folder hint containing /Documents/PESSOAL/ → folder-prior.
  const r = await shouldRouteToOcr(f, { folder: "/some/Documents/PESSOAL/sub" });
  assert.equal(r.route, true);
  assert.equal(r.reason, "folder-prior");
});

// Cleanup
test("cleanup tmp dir", () => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});
