// E05 — Edge typing tests.
// Cobre: schema v12 migration, normalizeRelationReason enum guard, SPO surface reason.
//
// Run: cd /root/.openclaw/workspace/tools/nox-mem && npx tsc &&
//      node --test dist/__tests__/edge-typing.test.js

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  VALID_RELATION_REASONS,
  normalizeRelationReason,
  type RelationReason,
} from "../kg-llm.js";

const TMP_ROOT = mkdtempSync(join(process.env.NOX_TEST_TMP_ROOT || tmpdir(), "nox-mem-edge-test-"));
const TEST_DB = join(TMP_ROOT, "test.db");
process.env.NOX_DB_PATH = TEST_DB;

let getDb: any, closeDb: any;
let lookupTopK: any;

before(async () => {
  const dbMod = await import("../db.js");
  const spoMod = await import("../lib/spo-injection.js");
  getDb = dbMod.getDb;
  closeDb = dbMod.closeDb;
  lookupTopK = spoMod.lookupTopK;
  getDb(); // triggers ensureSchema → v12
});

after(() => {
  try { closeDb(); } catch { /* ignore */ }
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────
// Enum guard
// ─────────────────────────────────────────────────────────────────────

test("VALID_RELATION_REASONS has exactly 7 closed values", () => {
  assert.equal(VALID_RELATION_REASONS.length, 7);
  assert.deepEqual(
    [...VALID_RELATION_REASONS].sort(),
    ["depends_on", "derived_from", "extends", "mentions", "opposes", "replaces", "unknown"].sort()
  );
});

test("normalizeRelationReason: passes valid lowercase", () => {
  assert.equal(normalizeRelationReason("depends_on"), "depends_on");
  assert.equal(normalizeRelationReason("extends"), "extends");
});

test("normalizeRelationReason: case-insensitive + trims whitespace", () => {
  assert.equal(normalizeRelationReason("  Depends_On  "), "depends_on");
  assert.equal(normalizeRelationReason("REPLACES"), "replaces");
});

test("normalizeRelationReason: invalid string → unknown", () => {
  assert.equal(normalizeRelationReason("foo"), "unknown");
  assert.equal(normalizeRelationReason("requires"), "unknown");
});

test("normalizeRelationReason: non-string → unknown", () => {
  assert.equal(normalizeRelationReason(null), "unknown");
  assert.equal(normalizeRelationReason(undefined), "unknown");
  assert.equal(normalizeRelationReason(123), "unknown");
  assert.equal(normalizeRelationReason({}), "unknown");
});

// ─────────────────────────────────────────────────────────────────────
// Schema v12 migration
// ─────────────────────────────────────────────────────────────────────

test("schema v12: PRAGMA user_version >= 12 (additive forward-compat)", () => {
  const db = getDb();
  const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert.ok(v >= 12, `expected >=12, got ${v}`);
});

test("schema v12: kg_relations.relation_reason column exists", () => {
  const db = getDb();
  const cols = db.prepare("PRAGMA table_info(kg_relations)").all() as Array<{ name: string }>;
  const names = cols.map((c) => c.name);
  assert.ok(names.includes("relation_reason"), `cols: ${names.join(",")}`);
});

test("schema v12: idx_kg_relations_reason index exists", () => {
  const db = getDb();
  const idx = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_kg_relations_reason'"
  ).get();
  assert.ok(idx, "idx_kg_relations_reason missing");
});

test("schema v12: default 'unknown' applied to new INSERT without reason", () => {
  const db = getDb();
  const insE = db.prepare("INSERT INTO kg_entities (name, entity_type) VALUES (?, ?)");
  const e1 = insE.run("test_a", "concept").lastInsertRowid as number;
  const e2 = insE.run("test_b", "concept").lastInsertRowid as number;
  // Insert WITHOUT reason — should default to 'unknown'
  db.prepare(
    "INSERT INTO kg_relations (source_entity_id, relation_type, target_entity_id) VALUES (?, ?, ?)"
  ).run(e1, "uses", e2);
  const row = db.prepare(
    "SELECT relation_reason FROM kg_relations WHERE source_entity_id=? AND target_entity_id=?"
  ).get(e1, e2) as { relation_reason: string };
  assert.equal(row.relation_reason, "unknown");
});

// ─────────────────────────────────────────────────────────────────────
// SPO injection surfaces reason
// ─────────────────────────────────────────────────────────────────────

test("lookupTopK: returns reason field in triples", () => {
  const db = getDb();
  const insE = db.prepare("INSERT INTO kg_entities (name, entity_type) VALUES (?, ?)");
  const ax = insE.run("alpha", "tool").lastInsertRowid as number;
  const bx = insE.run("beta", "tool").lastInsertRowid as number;
  db.prepare(
    "INSERT INTO kg_relations (source_entity_id, relation_type, target_entity_id, confidence, relation_reason) VALUES (?, ?, ?, ?, ?)"
  ).run(ax, "depends_on", bx, 0.9, "depends_on");
  const triples = lookupTopK(["alpha"], db, 5);
  const found = triples.find((t: any) => t.subject === "alpha" && t.object === "beta");
  assert.ok(found);
  assert.equal(found.reason, "depends_on");
});
