// D1 — canary access_count contamination fix (2026-06-07).
// O healthcheck semantic-canary roda /api/search 2×/h e, via searchHybrid,
// incrementava access_count de dezenas de chunks por chamada — inflando a
// salience de um punhado de chunks (feedback loop). recordAccess() agora
// respeita um flag `enabled`; healthchecks passam enabled=false.
//
// Run: cd tools/nox-mem && npx tsc && node --test dist/__tests__/search-track-access.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { _internals } from "../search.js";

type Row = { id: number; access_count: number; last_accessed_at: string | null };

function makeDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      access_count INTEGER DEFAULT 0,
      last_accessed_at TEXT
    );
    INSERT INTO chunks (id, access_count) VALUES (1, 0), (2, 5), (3, 0);
  `);
  return db;
}

test("recordAccess: enabled=false não toca access_count nem last_accessed_at", () => {
  const db = makeDb();
  _internals.recordAccess(db, [1, 2, 3], false);
  const rows = db.prepare("SELECT id, access_count, last_accessed_at FROM chunks ORDER BY id").all() as Row[];
  assert.deepEqual(rows.map((r) => r.access_count), [0, 5, 0]);
  assert.ok(rows.every((r) => r.last_accessed_at === null));
  db.close();
});

test("recordAccess: enabled=true incrementa apenas os ids dados (preserva default)", () => {
  const db = makeDb();
  _internals.recordAccess(db, [1, 3], true);
  const rows = db.prepare("SELECT id, access_count, last_accessed_at FROM chunks ORDER BY id").all() as Row[];
  assert.deepEqual(rows.map((r) => r.access_count), [1, 5, 1]); // id=2 intocado
  assert.notEqual(rows[0]!.last_accessed_at, null);
  assert.equal(rows[1]!.last_accessed_at, null);
  assert.notEqual(rows[2]!.last_accessed_at, null);
  db.close();
});

test("recordAccess: ids vazios / undefined é no-op seguro", () => {
  const db = makeDb();
  _internals.recordAccess(db, [], true);
  _internals.recordAccess(db, [undefined, undefined], true);
  const rows = db.prepare("SELECT access_count FROM chunks ORDER BY id").all() as Row[];
  assert.deepEqual(rows.map((r) => r.access_count), [0, 5, 0]);
  db.close();
});
