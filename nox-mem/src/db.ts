import Database from "better-sqlite3";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = resolve(__dirname, "..", "nox-mem.db");
const SCHEMA_VERSION = 2;

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db && _db.open) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  ensureSchema(_db);
  return _db;
}

export function closeDb(): void {
  if (_db && _db.open) {
    _db.close();
    _db = null;
  }
}

function ensureSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );`);

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  const currentVersion = row ? parseInt(row.value, 10) : 0;

  if (currentVersion === SCHEMA_VERSION) return;
  if (currentVersion > SCHEMA_VERSION) {
    throw new Error(`DB schema ${currentVersion} > expected ${SCHEMA_VERSION}`);
  }

  if (currentVersion < 1) migrateToV1(db);
  if (currentVersion < 2) migrateToV2(db);

  db.prepare("INSERT OR REPLACE INTO meta (key, value, updated_at) VALUES ('schema_version', ?, datetime('now'))").run(String(SCHEMA_VERSION));
}

function migrateToV1(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      chunk_type TEXT NOT NULL,
      source_date TEXT,
      is_consolidated INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      metadata TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      chunk_text, source_file, chunk_type,
      content=chunks, content_rowid=id,
      tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, chunk_text, source_file, chunk_type)
      VALUES (new.id, new.chunk_text, new.source_file, new.chunk_type);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, chunk_text, source_file, chunk_type)
      VALUES ('delete', old.id, old.chunk_text, old.source_file, old.chunk_type);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, chunk_text, source_file, chunk_type)
      VALUES ('delete', old.id, old.chunk_text, old.source_file, old.chunk_type);
      INSERT INTO chunks_fts(rowid, chunk_text, source_file, chunk_type)
      VALUES (new.id, new.chunk_text, new.source_file, new.chunk_type);
    END;
    CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_file);
    CREATE INDEX IF NOT EXISTS idx_chunks_type ON chunks(chunk_type);
    CREATE INDEX IF NOT EXISTS idx_chunks_date ON chunks(source_date);
  `);
}

function migrateToV2(db: Database.Database): void {
  // Separate consolidation state from chunks — survives reindex
  db.exec(`
    CREATE TABLE IF NOT EXISTS consolidated_files (
      source_file TEXT PRIMARY KEY,
      status INTEGER NOT NULL DEFAULT 1,
      processed_at TEXT DEFAULT (datetime('now'))
    );
  `);
  // Migrate existing consolidated state
  db.exec(`
    INSERT OR IGNORE INTO consolidated_files (source_file, status, processed_at)
    SELECT DISTINCT source_file, 1, datetime('now')
    FROM chunks WHERE is_consolidated = 1;
  `);
  // Drop the index that was on is_consolidated (no longer needed)
  db.exec(`DROP INDEX IF EXISTS idx_chunks_consolidated;`);
  // Drop the UPDATE trigger that caused FTS5 write amplification
  db.exec(`DROP TRIGGER IF EXISTS chunks_au;`);
}
