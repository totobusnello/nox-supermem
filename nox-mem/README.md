# nox-mem

Pain-weighted hybrid memory engine for AI agents. Self-hosted, zero vendor lock-in.

**Stack:** TypeScript · Node 20+ · SQLite (FTS5 + sqlite-vec) · Gemini embeddings (default) · OpenAI-compat optional

---

## Prerequisites

### System packages (Linux)

```bash
apt-get update
apt-get install -y build-essential python3 python3-pip inotify-tools
```

`build-essential` and `python3` are required by `better-sqlite3` (compiles a native addon) and `@xenova/transformers` (optional local embeddings).

### Node.js 20+

```bash
# Via NodeSource (Ubuntu/Debian)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node --version  # expect v20.x or higher
```

---

## Install

### From tarball (recommended for production)

```bash
# Unpack and install globally from the directory
npm install -g .
```

### From source (build yourself)

```bash
npm ci
npm run build
npm install -g .
```

After either method, the `nox-mem` command is available globally.

---

## Environment variables

Copy `.env.example` to `.env` in your install directory and fill in the required values, then source it before running:

```bash
set -a; source /path/to/.env; set +a
nox-mem stats
```

### Required

| Var | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | — | Google AI Studio key (default LLM + embedding provider). |
| `NOX_DB_PATH` | `<cwd>/nox-mem.db` | SQLite database path. Its directory is auto-added to the op-audit allowlist. |
| `NOX_MEM_DIR` | — | Directory of markdown memory files to ingest/watch. |

### API server

| Var | Default | Purpose |
|---|---|---|
| `NOX_API_PORT` | `18802` | HTTP API port. |
| `NOX_API_HOST` | `127.0.0.1` | HTTP API bind host. |
| `NOX_API_TOKEN` | — | If set, requires `Authorization: Bearer <token>` on the API. |

### Multi-provider (optional — default is Gemini / AI Studio)

| Var | Default | Purpose |
|---|---|---|
| `NOX_LLM_PROVIDER` | `gemini` | `gemini` or `openai` (any OpenAI-compatible endpoint). |
| `NOX_LLM_MODEL` | `gemini-2.5-flash-lite` / `gpt-4o-mini` | LLM model id. |
| `NOX_LLM_BASE_URL` | provider default | OpenAI-compat endpoint — DeepSeek/OpenRouter/Together/local. |
| `NOX_LLM_API_KEY` | falls back to `GEMINI_API_KEY` / `OPENAI_API_KEY` | LLM key. |
| `NOX_LLM_FALLBACK` | — | Fallback chain, e.g. `openai:gpt-4o-mini`. |
| `NOX_EMBEDDING_PROVIDER` | `gemini` | `gemini` or `openai`. Alias: `NOX_EMBED_PROVIDER`. |
| `NOX_EMBEDDING_MODEL` | `gemini-embedding-001` / `text-embedding-3-small` | Embedding model. Alias: `NOX_EMBED_MODEL`. |
| `NOX_EMBEDDING_BASE_URL` | provider default | Embedding endpoint. Alias: `NOX_EMBED_BASE_URL`. |
| `NOX_EMBEDDING_API_KEY` | falls back to provider key | Embedding key. Alias: `NOX_EMBED_API_KEY`. |
| `NOX_EMBEDDING_DIM` | `3072` | Vector dim. **MUST equal the vec0 table dim** — changing it requires re-embedding the whole corpus. Alias: `NOX_EMBED_DIM`. |

> ⚠️ Embeddings from different models/dims are not comparable. Pick one embedding model up front; mixing silently corrupts semantic search. `text-embedding-3-large` supports `dimensions=3072` for parity with the default table.

### Advanced (safe to leave unset — defaults are standalone-neutral)

| Var | Default | Purpose |
|---|---|---|
| `OPENCLAW_WORKSPACE` | `/root/.openclaw/workspace` | Origin platform workspace root (origin/legacy only). |
| `NOX_OP_AUDIT_ALLOWED_PREFIXES` | derived from `NOX_DB_PATH`/`NOX_MEM_DIR` + origin defaults | Comma-sep path prefixes the DB/snapshots may live under. |
| `NOX_PRE_OP_SNAPSHOT_DIR` | `<NOX_MEM_DIR>/.nox-snapshots` (standalone) | Pre-op snapshot directory. |
| `NOX_PROTECTED_NAMES` | empty | Comma-sep names never auto-merged in the KG. |
| `NOX_NAME_ALIASES` | empty | `from:To` name-normalization pairs for the KG. |
| `NOX_ENTITY_PATTERNS` / `NOX_PROJECT_PATTERNS` | empty | Terms for the legacy regex entity extractor. |
| `NOX_KNOWN_PROJECTS` | empty | Project slugs for `project-context-gen`. |
| `NOX_AGENTS` / `NOX_AGENTS_DIR` | `nox,atlas,boris,cipher,forge,lex` / `/root/.openclaw/agents` | Multi-agent cross-search layout (no-op standalone). |
| `NOX_WATCH_DIRS` | origin layout | Comma-sep dirs for the file watcher. |
| `NOX_SPEAKER_FILTER` | empty | One-time V7 migration speaker classification. |
| `NOX_NOTION_TOKEN` / `NOX_NOTION_TOKEN_PATH` | — / `/root/.config/notion/api_key` | Optional Notion sync token (value or file path). |

---

## Multi-provider support

By default nox-mem uses **Gemini via AI Studio** (`gemini/gemini-2.5-flash-lite` model, key = `GEMINI_API_KEY`).

To switch to any OpenAI-compatible provider (DeepSeek, OpenRouter, local Ollama, etc.):

```bash
NOX_LLM_PROVIDER=openai
NOX_LLM_BASE_URL=https://openrouter.ai/api/v1
NOX_LLM_MODEL=deepseek/deepseek-chat
NOX_LLM_API_KEY=sk-...

NOX_EMBED_PROVIDER=openai
NOX_EMBED_BASE_URL=https://openrouter.ai/api/v1
NOX_EMBED_MODEL=text-embedding-3-small
NOX_EMBED_API_KEY=sk-...
```

Provider-switching works at runtime — no rebuild required.

---

## Operation audit snapshots

All destructive operations (reindex, consolidate, compact, crystallize, kg-prune) create an atomic SQLite snapshot before mutating data. Snapshots land in `$NOX_PRE_OP_SNAPSHOT_DIR` (default: `/var/backups/nox-mem/pre-op/`). Retention: 7 days. Do NOT restore with raw `cp` — use the `safeRestore()` path or the `--restore` flag which handles WAL/SHM cleanup correctly.

---

## Sanity check

After install, verify the engine is healthy:

```bash
# Start the API server
nox-mem serve &

# Check vector coverage (should be close to 1.0)
curl -s http://127.0.0.1:18802/api/health | jq .vectorCoverage
```

A `vectorCoverage` value below 0.99 means some chunks are not yet embedded — run `nox-mem vectorize` to catch up.

---

## Key commands

```
nox-mem search "query"     — hybrid search (FTS5 + semantic + RRF)
nox-mem ingest <file>      — ingest a markdown or entity file
nox-mem reindex            — rebuild FTS5 index
nox-mem vectorize          — embed any unembedded chunks
nox-mem stats              — chunk/entity/vector counts
nox-mem kg-build           — extract knowledge graph entities
nox-mem reflect            — surface high-salience insights
nox-mem serve              — start HTTP API on $NOX_API_PORT (default 18802)
nox-mem --help             — full command reference
```

---

## sqlite-vec and platform binaries

`sqlite-vec` ships native `.so`/`.dylib`/`.dll` files as platform-specific optional npm packages (`sqlite-vec-linux-x64`, `sqlite-vec-darwin-arm64`, etc.). A plain `npm install` on a supported platform automatically resolves and downloads the correct binary — no `postinstall` script required. The nox-mem `package.json` explicitly lists all platform variants under `optionalDependencies` so package managers that strip optional deps by default still see them declared.

---

*MIT License — Copyright (c) 2026 Luiz Antonio Busnello (Toto)*
