// E13 — Temporal-aware Ranking tests.
// Spec: memoria-nox/specs/2026-05-06-E13-temporal-aware-ranking.md
//
// Run: cd /root/.openclaw/workspace/tools/nox-mem && npx tsc &&
//      node --test dist/__tests__/temporal-detector.test.js

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  isTemporalQuery,
  effectiveSectionBoost,
  getOverride,
  getMode,
  SECTION_BOOST_TEMPORAL,
} from "../lib/temporal-detector.js";

beforeEach(() => {
  delete process.env.NOX_TEMPORAL_BOOST_MODE;
  delete process.env.NOX_TEMPORAL_BOOST_LOG;
});

// ─────────────────────────────────────────────────────────────────────
// 1. detector positive cases (PT-BR triggers)
// ─────────────────────────────────────────────────────────────────────

test("isTemporalQuery: 'quando o salience foi ativado' → true", () => {
  assert.equal(isTemporalQuery("quando o salience foi ativado"), true);
});

test("isTemporalQuery: 'primeira lição do incident' → true", () => {
  assert.equal(isTemporalQuery("primeira lição do incident"), true);
});

test("isTemporalQuery: 'ativado' single token → true", () => {
  assert.equal(isTemporalQuery("ativado"), true);
});

test("isTemporalQuery: ISO date '2026-04-25' in query → true", () => {
  assert.equal(isTemporalQuery("query com 2026-04-25 contexto"), true);
});

test("isTemporalQuery: 'Quando subiu schema v12?' (case-insensitive) → true", () => {
  assert.equal(isTemporalQuery("Quando subiu schema v12?"), true);
});

// ─────────────────────────────────────────────────────────────────────
// 2. detector negative cases
// ─────────────────────────────────────────────────────────────────────

test("isTemporalQuery: 'o que é nox-mem' → false (factual)", () => {
  assert.equal(isTemporalQuery("o que é nox-mem"), false);
});

test("isTemporalQuery: 'relação entre A e B' → false", () => {
  assert.equal(isTemporalQuery("relação entre A e B"), false);
});

test("isTemporalQuery: empty/short query → false", () => {
  assert.equal(isTemporalQuery(""), false);
  assert.equal(isTemporalQuery("ab"), false);
});

// Edge: "deployment" sozinho NÃO bate (precisa "deployado/deployed/deployamento")
test("isTemporalQuery: 'deployment automatizado' → false (radical sem modifier)", () => {
  assert.equal(isTemporalQuery("deployment automatizado"), false);
});

// ─────────────────────────────────────────────────────────────────────
// 3. effectiveSectionBoost — override só em mode=active
// ─────────────────────────────────────────────────────────────────────

test("effectiveSectionBoost: mode=off retorna baseline (sem override)", () => {
  // baseline timeline = 0.8; override seria 1.4
  const v = effectiveSectionBoost(0.8, "timeline", true, "off");
  assert.equal(v, 0.8);
});

test("effectiveSectionBoost: mode=shadow retorna baseline (não muta)", () => {
  const v = effectiveSectionBoost(0.8, "timeline", true, "shadow");
  assert.equal(v, 0.8);
});

test("effectiveSectionBoost: mode=active + isTemporal + section=timeline → 1.4 override", () => {
  const v = effectiveSectionBoost(0.8, "timeline", true, "active");
  assert.equal(v, 1.4);
});

test("effectiveSectionBoost: mode=active + isTemporal + section=compiled → 1.0 (neutro)", () => {
  const v = effectiveSectionBoost(2.0, "compiled", true, "active");
  assert.equal(v, 1.0);
});

test("effectiveSectionBoost: mode=active mas isTemporal=false → baseline preservado", () => {
  const v = effectiveSectionBoost(2.0, "compiled", false, "active");
  assert.equal(v, 2.0);
});

test("effectiveSectionBoost: section=null → baseline retornado", () => {
  const v = effectiveSectionBoost(1.0, null, true, "active");
  assert.equal(v, 1.0);
});

// ─────────────────────────────────────────────────────────────────────
// 4. getMode env reader (off/shadow/active fallback)
// ─────────────────────────────────────────────────────────────────────

test("getMode: default off quando env unset", () => {
  delete process.env.NOX_TEMPORAL_BOOST_MODE;
  assert.equal(getMode(), "off");
});

test("getMode: lowercase shadow", () => {
  process.env.NOX_TEMPORAL_BOOST_MODE = "SHADOW";
  assert.equal(getMode(), "shadow");
});

test("getMode: invalid value → off fallback", () => {
  process.env.NOX_TEMPORAL_BOOST_MODE = "garbage";
  assert.equal(getMode(), "off");
});

// ─────────────────────────────────────────────────────────────────────
// 5. getOverride pure lookup
// ─────────────────────────────────────────────────────────────────────

test("getOverride: timeline → 1.4", () => {
  assert.equal(getOverride("timeline"), 1.4);
});

test("getOverride: section desconhecida → null", () => {
  assert.equal(getOverride("xyz"), null);
});

test("SECTION_BOOST_TEMPORAL: invariants — timeline>compiled>frontmatter", () => {
  assert.ok(SECTION_BOOST_TEMPORAL.timeline > SECTION_BOOST_TEMPORAL.compiled);
  assert.ok(SECTION_BOOST_TEMPORAL.compiled > SECTION_BOOST_TEMPORAL.frontmatter);
});
