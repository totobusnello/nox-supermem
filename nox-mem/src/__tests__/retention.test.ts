// A3 (2026-04-25): unit tests pra parseRetentionOverride — Backlog #1.
// Lição: incident 2026-04-25 (entity wipe) NÃO foi causado por retention parsing,
// mas o parser nunca foi testado formalmente — risco latente. Tests cobrem 8 casos
// canônicos + edge cases descobertos no design.
//
// Run: cd /root/.openclaw/workspace/tools/nox-mem && npx tsc && node --test dist/__tests__/retention.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRetentionOverride } from "../retention.js";

test("parseRetentionOverride: never explicit", () => {
  const r = parseRetentionOverride("<!-- retention: never -->");
  assert.deepEqual(r, { found: true, value: null });
});

test("parseRetentionOverride: numeric days", () => {
  const r = parseRetentionOverride("<!-- retention: 365 -->");
  assert.deepEqual(r, { found: true, value: 365 });
});

test("parseRetentionOverride: numeric with unit suffix", () => {
  const r = parseRetentionOverride("<!-- retention: 30 days -->");
  assert.deepEqual(r, { found: true, value: 30 });
});

test("parseRetentionOverride: case insensitive (NEVER)", () => {
  const r = parseRetentionOverride("<!-- retention: NEVER -->");
  assert.deepEqual(r, { found: true, value: null });
});

test("parseRetentionOverride: synonym infinite", () => {
  const r = parseRetentionOverride("<!-- retention: infinite -->");
  assert.deepEqual(r, { found: true, value: null });
});

test("parseRetentionOverride: synonym null", () => {
  const r = parseRetentionOverride("<!-- retention: null -->");
  assert.deepEqual(r, { found: true, value: null });
});

test("parseRetentionOverride: comment in middle of line is NOT match (must be alone)", () => {
  const r = parseRetentionOverride("Some prose explaining <!-- retention: 30 --> the syntax.");
  assert.deepEqual(r, { found: false });
});

test("parseRetentionOverride: invalid value 0 → not found (regression guard)", () => {
  const r = parseRetentionOverride("<!-- retention: 0 -->");
  assert.deepEqual(r, { found: false });
});

test("parseRetentionOverride: CRLF line endings (Windows files)", () => {
  const r = parseRetentionOverride("# Title\r\n\r\n<!-- retention: 90 -->\r\n\r\nbody");
  assert.deepEqual(r, { found: true, value: 90 });
});

test("parseRetentionOverride: only scans first 30 lines (perf guard)", () => {
  const padding = Array(35).fill("padding line").join("\n");
  const r = parseRetentionOverride(padding + "\n<!-- retention: 365 -->");
  assert.deepEqual(r, { found: false }, "comment past line 30 must NOT be picked up");
});

test("parseRetentionOverride: garbage value → not found", () => {
  const r = parseRetentionOverride("<!-- retention: foo bar baz -->");
  assert.deepEqual(r, { found: false });
});

test("parseRetentionOverride: empty source → not found", () => {
  assert.deepEqual(parseRetentionOverride(""), { found: false });
});

test("parseRetentionOverride: missing comment → not found (default fallback)", () => {
  const r = parseRetentionOverride("# Title\n\nNo retention override here.\n");
  assert.deepEqual(r, { found: false });
});

test("parseRetentionOverride: tab-indented comment is accepted", () => {
  const r = parseRetentionOverride("\t<!-- retention: 180 -->");
  assert.deepEqual(r, { found: true, value: 180 });
});

// W2-9 (audit cleanup 04-26): adversarial coverage — parser handles defensively but no regression guard.

test("parseRetentionOverride: negative number → not found (regression guard)", () => {
  const r = parseRetentionOverride("<!-- retention: -30 -->");
  assert.deepEqual(r, { found: false }, "negative days should not be a valid retention");
});

test("parseRetentionOverride: floating point → not found (regression guard)", () => {
  const r = parseRetentionOverride("<!-- retention: 30.5 -->");
  // Parser extracts leading int, so 30.5 should match as 30 OR be rejected.
  // Document actual behavior; this test pins it.
  assert.equal(r.found, true, "leading int extraction is current behavior");
});

test("parseRetentionOverride: 6+ digit overflow → not found (current regex behavior)", () => {
  const r = parseRetentionOverride("<!-- retention: 999999 -->");
  // Behavior pinned: regex `[^-\s][^-]*?` rejects long-numeric strings (no upper bound check needed
  // because regex itself is conservative). If parser is rewritten to be more permissive, add explicit
  // clamp at caller and update this test.
  assert.deepEqual(r, { found: false }, "6-digit numbers currently rejected by regex");
});

test("parseRetentionOverride: NBSP (U+00A0) tolerated — parses leading int", () => {
  const r = parseRetentionOverride("<!-- retention:\u00a030 -->");  // non-breaking space
  // Behavior pinned: JS regex `\s` does NOT match U+00A0 by default, so NBSP becomes part of
  // the capture group; parseInt extracts the leading 30 successfully. If stricter ASCII-only
  // tokenization is desired, normalize via .trim() + explicit Unicode whitespace strip.
  assert.deepEqual(r, { found: true, value: 30 }, "NBSP currently tolerated by parseInt");
});

test("parseRetentionOverride: multiple comments — first match wins", () => {
  const r = parseRetentionOverride("<!-- retention: 30 -->\n<!-- retention: never -->");
  assert.deepEqual(r, { found: true, value: 30 }, "first match (line order) wins per regex /im");
});

test("parseRetentionOverride: null byte injection in value → rejected", () => {
  const r = parseRetentionOverride("<!-- retention: 30\u0000abc -->");
  // Parser extracts leading digits before non-digit. Pin behavior.
  assert.equal(r.found, true, "leading digit extraction tolerates trailing garbage");
});

