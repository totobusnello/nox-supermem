// Item 2 plano Cipher simbiose — churn detection por embedding KNN.
// Spec: memoria-nox specs/2026-06-05-cipher-simbiose-itens-1-2-3.md (Task 4).
//
// Run: cd tools/nox-mem && npx tsc && node --test dist/__tests__/churn.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { detectChurn, churnReportMd } from "../churn.js";

const DIMS = 8;

function mkDb(): Database.Database {
  const db = new Database(":memory:");
  sqliteVec.load(db);
  db.exec(`
    CREATE TABLE chunks (id INTEGER PRIMARY KEY, source_file TEXT, chunk_text TEXT, chunk_type TEXT, created_at TEXT);
    CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[${DIMS}]);
    CREATE TABLE vec_chunk_map (vec_rowid INTEGER PRIMARY KEY, chunk_id INTEGER);
  `);
  return db;
}

function insert(db: Database.Database, id: number, text: string, createdAt: string, emb: number[], type = "team") {
  db.prepare("INSERT INTO chunks (id, source_file, chunk_text, chunk_type, created_at) VALUES (?,?,?,?,?)")
    .run(id, `src-${id}.md`, text, type, createdAt);
  const r = db.prepare("INSERT INTO vec_chunks (embedding) VALUES (?)").run(JSON.stringify(emb));
  db.prepare("INSERT INTO vec_chunk_map (vec_rowid, chunk_id) VALUES (?,?)").run(r.lastInsertRowid, id);
}

// vetor unitário 8d parametrizado por x — e(1.00) ≈ e(1.02), ortogonal a e(-5)
function e(x: number): number[] {
  const v = [x, 1, 0, 0, 0, 0, 0, 0];
  const n = Math.hypot(...v);
  return v.map((a) => a / n);
}

test("detectChurn flaga re-decisão (novo similar a antigo) e ignora tópico novo", () => {
  const db = mkDb();
  insert(db, 1, "Decisão: porta API 18802",     "2026-04-01 00:00:00", e(1.0));   // antigo, tópico T
  insert(db, 2, "Re-decisão: porta API mantida", "2026-06-01 12:00:00", e(1.02)); // novo ≈ T → churn
  insert(db, 3, "Decisão: tema ortogonal",       "2026-06-02 09:00:00", e(-5));   // novo, sem par → não
  const pairs = detectChurn(db, { since: "2026-05-01T00:00:00Z", threshold: 0.8, k: 5 });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].newChunkId, 2);
  assert.equal(pairs[0].oldChunkId, 1);
  assert.ok(pairs[0].similarity >= 0.8, `sim=${pairs[0].similarity}`);
});

test("detectChurn ignora pares novo↔novo (só vizinho antigo conta)", () => {
  const db = mkDb();
  insert(db, 10, "Novo A sobre tópico Z", "2026-06-01 10:00:00", e(3.0));
  insert(db, 11, "Novo B sobre tópico Z", "2026-06-02 10:00:00", e(3.05));
  const pairs = detectChurn(db, { since: "2026-05-01T00:00:00Z", threshold: 0.8, k: 5 });
  assert.equal(pairs.length, 0);
});

test("detectChurn respeita filtro de types quando passado", () => {
  const db = mkDb();
  insert(db, 20, "Decisão antiga", "2026-04-01 00:00:00", e(2.0), "decision");
  insert(db, 21, "Re-decisão nova", "2026-06-01 00:00:00", e(2.02), "daily");
  const all = detectChurn(db, { since: "2026-05-01T00:00:00Z", threshold: 0.8 });
  assert.equal(all.length, 1); // sem filtro: pega
  const onlyDecision = detectChurn(db, { since: "2026-05-01T00:00:00Z", threshold: 0.8, types: ["decision"] });
  assert.equal(onlyDecision.length, 0); // novo é daily → fora do filtro
});

test("churnReportMd renderiza pares e caso vazio", () => {
  const md = churnReportMd([], "2026-05-01T00:00:00Z");
  assert.match(md, /Nenhum churn/);
  const md2 = churnReportMd(
    [{ newChunkId: 2, newFile: "a.md", newText: "Re-decisão: porta API", newCreatedAt: "2026-06-01 12:00:00", oldChunkId: 1, oldFile: "b.md", oldText: "Decisão: porta API", oldCreatedAt: "2026-04-01 00:00:00", similarity: 0.97 }],
    "2026-05-01T00:00:00Z"
  );
  assert.match(md2, /0\.97/);
  assert.match(md2, /#2/);
});
