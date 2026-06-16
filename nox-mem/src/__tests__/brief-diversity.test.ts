// D2 — testes do brief diversity/novelty term (re-rank pós-salience).
// Spec: memoria-nox specs/2026-06-07-D2-brief-diversity-term.md
//
// Run: cd tools/nox-mem && npx tsc && node --test dist/__tests__/brief-diversity.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  noveltyPenalty,
  briefScore,
  diffBriefs,
  diversityConfigFromEnv,
  DIVERSITY_DEFAULTS,
  type DiversityConfig,
} from "../api/brief-diversity.js";
import {
  buildBrief,
  buildBriefDiverse,
  serveCounts,
  handleBrief,
  ensureBriefLog,
  _resetBriefLogMemo,
  type BriefDb,
} from "../api/brief.js";

const CFG: DiversityConfig = { mode: "active", ...DIVERSITY_DEFAULTS };

// ─── makeDb (espelha brief.test.ts) ──────────────────────────────────────────

function makeDb(): BriefDb & InstanceType<typeof Database> {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      source_file TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      chunk_type TEXT NOT NULL DEFAULT 'other',
      source_type TEXT,
      tier TEXT DEFAULT 'peripheral',
      pain REAL DEFAULT 0.2,
      importance REAL DEFAULT 0.5,
      retention_days INTEGER,
      source_date TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      last_accessed_at TEXT,
      access_count INTEGER DEFAULT 0
    );
  `);
  _resetBriefLogMemo();
  return db as unknown as BriefDb & InstanceType<typeof Database>;
}

interface Seed {
  source_file: string;
  chunk_text?: string;
  pain?: number;
  importance?: number;
  access_count?: number;
  created_at?: string; // SQL literal ou datetime('now',...) já resolvido
}

/** Insere chunks; created_at/updated_at aceitam SQL via marcador __SQL__. */
function seed(db: BriefDb, rows: Seed[]): void {
  for (const r of rows) {
    const created = r.created_at ?? "2026-06-01 00:00:00";
    db.prepare(
      `INSERT INTO chunks (source_file, chunk_text, pain, importance, access_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ${created.startsWith("datetime(") ? created : "?"}, ${created.startsWith("datetime(") ? created : "?"})`,
    ).run(
      ...(created.startsWith("datetime(")
        ? [r.source_file, r.chunk_text ?? "conteúdo", r.pain ?? 0.2, r.importance ?? 0.5, r.access_count ?? 0]
        : [r.source_file, r.chunk_text ?? "conteúdo", r.pain ?? 0.2, r.importance ?? 0.5, r.access_count ?? 0, created, created]),
    );
  }
}

/** Loga N serves de um chunk a `offsetHours` atrás no brief_log. */
function logServes(db: BriefDb, chunkId: number, n: number, offsetHours = 1): void {
  ensureBriefLog(db);
  const ins = db.prepare(
    `INSERT INTO brief_log (chunk_id, scope, served_at) VALUES (?, 'global', datetime('now', ?))`,
  );
  for (let i = 0; i < n; i++) ins.run(chunkId, `-${offsetHours} hours`);
}

// ─── noveltyPenalty (puro) ───────────────────────────────────────────────────

test("penalty: high-pain floor (pain ≥ painFloor) ⇒ 0 imune", () => {
  assert.equal(noveltyPenalty(99999, 0.9, CFG), 0);
  assert.equal(noveltyPenalty(99999, 0.95, CFG), 0);
  assert.ok(noveltyPenalty(99999, 0.89, CFG) > 0, "pain abaixo do floor não é imune");
});

test("penalty: n_serves 0 ⇒ 0 (nada servido, nada penaliza)", () => {
  assert.equal(noveltyPenalty(0, 0.2, CFG), 0);
});

test("penalty: cresce em log e satura em pMax", () => {
  const p5 = noveltyPenalty(5, 0.2, CFG);
  const p10 = noveltyPenalty(10, 0.2, CFG);
  assert.ok(p10 > p5 && p5 > 0, "monotônico antes do cap");
  // satura: servir 100× ≈ servir 2000× (ambos batem pMax)
  assert.equal(noveltyPenalty(100, 0.2, CFG), CFG.pMax);
  assert.equal(noveltyPenalty(2000, 0.2, CFG), CFG.pMax);
});

test("briefScore: salience − penalty", () => {
  const s = briefScore(0.5, 0, 0.2, CFG); // sem serves
  assert.equal(s, 0.5);
  assert.ok(briefScore(0.5, 100, 0.2, CFG) < 0.5, "muito servido desce");
});

// ─── diversityConfigFromEnv ──────────────────────────────────────────────────

test("config: default off + calibração D3", () => {
  const c = diversityConfigFromEnv({});
  assert.equal(c.mode, "off");
  assert.equal(c.painFloor, 0.9);
  assert.equal(c.freshSlots, 2);
  assert.equal(c.windowSql, "-72 hours");
});

test("config: env override (mode/lambda/window/slots)", () => {
  const c = diversityConfigFromEnv({
    NOX_BRIEF_DIVERSITY: "shadow",
    NOX_BRIEF_DIV_LAMBDA: "0.1",
    NOX_BRIEF_DIV_WINDOW_HOURS: "24",
    NOX_BRIEF_DIV_FRESH_SLOTS: "3",
  });
  assert.equal(c.mode, "shadow");
  assert.equal(c.lambda, 0.1);
  assert.equal(c.windowSql, "-24 hours");
  assert.equal(c.freshSlots, 3);
});

test("config: mode inválido ⇒ off (fail-safe)", () => {
  assert.equal(diversityConfigFromEnv({ NOX_BRIEF_DIVERSITY: "ON" }).mode, "off");
});

// ─── diffBriefs ──────────────────────────────────────────────────────────────

test("diff: would_enter/leave corretos", () => {
  const d = diffBriefs([1, 2, 3], [1, 4, 3], [4]);
  assert.deepEqual(d.would_enter, [4]);
  assert.deepEqual(d.would_leave, [2]);
  assert.deepEqual(d.fresh_added, [4]);
  assert.equal(d.churn, 1);
});

// ─── serveCounts (query brief_log) ───────────────────────────────────────────

test("serveCounts: conta na janela, ignora fora dela", () => {
  const db = makeDb();
  seed(db, [{ source_file: "x/a.md" }, { source_file: "x/b.md" }]);
  logServes(db, 1, 5, 1); // 5 serves há 1h (dentro de 72h)
  logServes(db, 1, 3, 100); // 3 serves há 100h (fora)
  logServes(db, 2, 2, 1);
  const counts = serveCounts(db, [1, 2], "-72 hours");
  assert.equal(counts.get(1), 5, "só os de dentro da janela");
  assert.equal(counts.get(2), 2);
});

test("serveCounts: fail-open com ids vazios", () => {
  const db = makeDb();
  assert.equal(serveCounts(db, [], "-72 hours").size, 0);
});

// ─── buildBriefDiverse (A: novelty penalty) ──────────────────────────────────

test("A: chunk muito-servido desce, abre espaço pro menos-servido (mesma salience)", () => {
  const db = makeDb();
  // dois chunks ~salience igual (mesma importance/pain/age), textos distintos
  seed(db, [
    { source_file: "x/muito.md", chunk_text: "tópico alfa muito repetido no brief", importance: 0.6 },
    { source_file: "x/pouco.md", chunk_text: "tópico beta raramente servido ainda", importance: 0.6 },
  ]);
  logServes(db, 1, 500, 1); // chunk 1 servido 500× na janela
  const { current, alt } = buildBriefDiverse(db, { scope: "x", n: 1, format: "json" }, CFG, Date.now());
  // current (salience pura): empate → ordem de salience/updated_at
  // alt: penalty derruba o muito-servido ⇒ o pouco-servido vence
  assert.equal(alt.items[0].id, 2, "novelty penalty promove o menos-servido");
  assert.ok(current.items.length === 1 && alt.items.length === 1);
});

test("A: high-pain floor — incident crítico muito-servido NÃO é deslocado", () => {
  const db = makeDb();
  seed(db, [
    { source_file: "x/incident.md", chunk_text: "incident gateway fratricide produção", importance: 0.6, pain: 0.95 },
    { source_file: "x/novo.md", chunk_text: "nota recente qualquer sem pain", importance: 0.6, pain: 0.2 },
  ]);
  logServes(db, 1, 500, 1); // incident servidíssimo
  const { alt } = buildBriefDiverse(db, { scope: "x", n: 1, format: "json" }, CFG, Date.now());
  assert.equal(alt.items[0].id, 1, "high-pain≥0.9 imune ao penalty (floor)");
});

test("FLOOR vs freshness: high-pain do brief atual NÃO é expulso pelo slot B", () => {
  const db = makeDb();
  // A/C/D regulares high-salience; B high-pain pain=1.0 na 4ª posição. source_date
  // abril (não vira fresh candidate) + last_accessed recente (recency alta).
  // Sem o floor, o freshness slot (reduz mainTarget) empurraria B pra fora.
  const ins = db.prepare(
    `INSERT INTO chunks (source_file, chunk_text, importance, pain, access_count, source_date, last_accessed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 40, '2026-04-01', datetime('now','-1 days'), '2026-04-01 00:00:00', datetime('now','-1 days'))`,
  );
  ins.run("x/a.md", "decisão alfa gateway fallback chain", 0.95, 0.2);  // id1
  ins.run("x/c.md", "schema migração vacuum backup atômico", 0.85, 0.2); // id2
  ins.run("x/d.md", "rollback deploy regression noturno", 0.8, 0.2);     // id3
  ins.run("x/incident.md", "incident fratricide produção crítico down", 0.6, 1.0); // id4 high-pain
  db.prepare(
    `INSERT INTO chunks (source_file, chunk_text, importance, pain, access_count, created_at, updated_at)
     VALUES ('x/fresco.md', 'achado novo relevante desta semana', 0.75, 0.2, 0, datetime('now','-1 days'), datetime('now','-1 days'))`,
  ).run(); // id5 fresh
  const cfg: DiversityConfig = { ...CFG, freshSlots: 1 };
  const { current, alt } = buildBriefDiverse(db, { scope: "x", n: 4, format: "json" }, cfg, Date.now());
  assert.ok(current.items.map((i) => i.id).includes(4), "high-pain está no brief atual (top-4)");
  assert.ok(alt.items.map((i) => i.id).includes(4), "FLOOR: high-pain preservado apesar do freshness slot");
});

// ─── buildBriefDiverse (B: freshness slot) ───────────────────────────────────

/** Insere 4 dominantes high-salience (source_date recente ⇒ recency alta;
 *  importance/pain/access máximos) que ocupam folgado os slots por salience.
 *  recencyComponent usa last_accessed_at ?? source_date — daí o source_date. */
function seedDominants(db: BriefDb): void {
  // Dominantes = conteúdo ANTIGO (source_date abril ⇒ fora do freshness pool)
  // mas MUITO acessado (last_accessed_at recente ⇒ recency alta ⇒ salience
  // domina os slots por salience). Espelha o real: incidents/decisões velhas
  // que perpetuam o brief. Textos DISTINTOS pra não colapsarem por near-dup.
  const texts = [
    "gateway fratricide produção fallback chain",
    "schema migração vacuum encrypted backup atômico",
    "rollback deploy noturno regression boost multiplicativo",
    "vetorização embeddings gemini prepaid canary depleted",
  ];
  // pain 0.5 (NÃO high-pain) — dominam por importance+recency, mas não viram
  // pinned do floor (senão encheriam o brief e barrariam o teste de freshness).
  const ins = db.prepare(
    `INSERT INTO chunks (source_file, chunk_text, importance, pain, access_count, source_date, last_accessed_at, created_at, updated_at)
     VALUES (?, ?, 0.95, 0.5, 50, '2026-04-01', datetime('now','-1 days'), '2026-04-01 00:00:00', datetime('now','-1 days'))`,
  );
  texts.forEach((t, i) => ins.run(`x/dom${i + 1}.md`, t));
}

test("B: novidade recente relevante não-servida entra no freshness slot", () => {
  const db = makeDb();
  seedDominants(db); // ids 1-4, salience alta, source_date recente
  // fresco: passa FRESH_MIN_IMP, recente, source_date null ⇒ recency neutra 0.5
  db.prepare(
    `INSERT INTO chunks (source_file, chunk_text, importance, pain, access_count, created_at, updated_at)
     VALUES ('x/fresco.md', 'achado novo relevante desta semana', 0.75, 0.2, 0, datetime('now','-1 days'), datetime('now','-1 days'))`,
  ).run(); // id 5
  const cfg: DiversityConfig = { ...CFG, freshSlots: 1 };
  const { current, alt } = buildBriefDiverse(db, { scope: "x", n: 3, format: "json" }, cfg, Date.now());
  const curIds = current.items.map((i) => i.id);
  const altIds = alt.items.map((i) => i.id);
  assert.ok(!curIds.includes(5), "fresco fica fora do brief atual (4 dominantes > fresco)");
  assert.ok(altIds.includes(5), "fresco entra via freshness slot no alt");
});

test("B: lixo recente (importance baixo) NÃO entra no freshness slot", () => {
  const db = makeDb();
  seedDominants(db); // ids 1-4 dominam os 3 slots
  db.prepare(
    `INSERT INTO chunks (source_file, chunk_text, importance, pain, access_count, created_at, updated_at)
     VALUES ('x/lixo.md', 'ruído recente irrelevante', 0.3, 0.2, 0, datetime('now','-1 days'), datetime('now','-1 days'))`,
  ).run(); // id 5
  const cfg: DiversityConfig = { ...CFG, freshSlots: 1 };
  const { alt } = buildBriefDiverse(db, { scope: "x", n: 3, format: "json" }, cfg, Date.now());
  assert.ok(!alt.items.map((i) => i.id).includes(5), "lixo abaixo de FRESH_MIN_IMP não vira freshness candidate");
});

// ─── handleBrief (shadow/active/off via env) ─────────────────────────────────

function withEnv(vars: Record<string, string>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { fn(); } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

test("shadow: surface = brief ATUAL (não muda o que é servido)", () => {
  const db = makeDb();
  seed(db, [
    { source_file: "x/muito.md", chunk_text: "tópico alfa muito servido", importance: 0.6 },
    { source_file: "x/pouco.md", chunk_text: "tópico beta pouco servido", importance: 0.6 },
  ]);
  logServes(db, 1, 500, 1);
  const baseline = buildBrief(db, { scope: "x", n: 1, format: "json" });
  withEnv({ NOX_BRIEF_DIVERSITY: "shadow" }, () => {
    const out = handleBrief(db, { scope: "x", n: "1" }) as { status: number; body: { items: { id: number }[] } };
    assert.equal(out.status, 200);
    assert.deepEqual(
      out.body.items.map((i) => i.id),
      baseline.items.map((i) => i.id),
      "shadow serve o brief atual, não o alt",
    );
  });
});

test("active: surface = alt (penalty/freshness aplicados)", () => {
  const db = makeDb();
  seed(db, [
    { source_file: "x/muito.md", chunk_text: "tópico alfa muito servido aqui", importance: 0.6 },
    { source_file: "x/pouco.md", chunk_text: "tópico beta pouco servido aqui", importance: 0.6 },
  ]);
  logServes(db, 1, 500, 1);
  withEnv({ NOX_BRIEF_DIVERSITY: "active" }, () => {
    const out = handleBrief(db, { scope: "x", n: "1" }) as { status: number; body: { items: { id: number }[] } };
    assert.equal(out.body.items[0].id, 2, "active serve o menos-servido");
  });
});

test("off (default): caminho v1.2 intocado", () => {
  const db = makeDb();
  seed(db, [{ source_file: "x/a.md", chunk_text: "conteúdo a" }, { source_file: "x/b.md", chunk_text: "conteúdo b" }]);
  const baseline = buildBrief(db, { scope: "x", n: 2, format: "json" });
  const out = handleBrief(db, { scope: "x", n: "2" }) as { status: number; body: { items: { id: number }[] } };
  assert.deepEqual(out.body.items.map((i) => i.id), baseline.items.map((i) => i.id));
});

test("fail-open: erro no caminho diverso não derruba o priming", () => {
  const db = makeDb();
  seed(db, [{ source_file: "x/a.md", chunk_text: "conteúdo a" }]);
  // brief_log inexistente força erro nas queries de diversidade → cai pro atual
  withEnv({ NOX_BRIEF_DIVERSITY: "active" }, () => {
    const out = handleBrief(db, { scope: "x", n: "1" }) as { status: number };
    assert.equal(out.status, 200, "serve mesmo com diversidade falhando");
  });
});
