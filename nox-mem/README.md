# nox-mem

Pain-weighted hybrid memory engine for AI agents. Self-hosted, zero vendor lock-in.

**Stack:** TypeScript · Node 20+ · SQLite (FTS5 + sqlite-vec) · Gemini embeddings (default) · OpenAI-compat optional

## Quick start

```bash
npm i -g nox-mem
export GEMINI_API_KEY=AIza...   # https://aistudio.google.com/apikey
export NOX_DB_PATH="$HOME/.nox-mem/nox.db"
export NOX_MEM_DIR="$HOME/.nox-mem/memory"
mkdir -p "$HOME/.nox-mem/memory"
nox-mem stats
```

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

### From npm (recommended)

```bash
npm i -g nox-mem
nox-mem stats
```

### Build from source

```bash
git clone https://github.com/totobusnello/nox-supermem.git
cd nox-supermem/nox-mem
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
| `NOX_LLM_PROVIDER` | `gemini` | `gemini`, `openai` (any OpenAI-compatible endpoint), or `anthropic`. |
| `NOX_LLM_MODEL` | `gemini-2.5-flash-lite` | LLM model id (e.g. `gpt-4o-mini`, `claude-3-5-haiku-20241022`). |
| `NOX_LLM_BASE_URL` | provider default | OpenAI-compat base URL — DeepSeek/OpenRouter/Together/Ollama/vLLM. Ignored for `anthropic`. |
| `NOX_LLM_API_KEY` | falls back to `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | LLM key. |
| `NOX_LLM_FALLBACK` | — | Fallback chain, e.g. `openai:gpt-4o-mini`. |
| `NOX_EMBEDDING_PROVIDER` | `gemini` | `gemini`, `openai` (any OpenAI-compat endpoint), or `voyage`. Alias: `NOX_EMBED_PROVIDER`. |
| `NOX_EMBEDDING_MODEL` | `gemini-embedding-001` | Embedding model id (e.g. `text-embedding-3-large`, `voyage-3`). Alias: `NOX_EMBED_MODEL`. |
| `NOX_EMBEDDING_BASE_URL` | provider default | Embedding base URL for OpenAI-compat providers. Alias: `NOX_EMBED_BASE_URL`. |
| `NOX_EMBEDDING_API_KEY` | falls back to provider key | Embedding key. Alias: `NOX_EMBED_API_KEY`. |
| `NOX_EMBEDDING_DIM` | `3072` | Vector dimension. **MUST equal the vec0 table dim** — changing it requires re-embedding the whole corpus. Alias: `NOX_EMBED_DIM`. |

> ⚠️ **Dimension lock:** the sqlite-vec table is created with a fixed dimension. Switching embedding provider or model requires re-embedding the **entire corpus** with a single model at a single dimension, and that dimension must match the `vec0` table. `text-embedding-3-large` supports `dimensions=3072` (matches the default Gemini table); `text-embedding-3-small` is 1536 — only usable with a fresh/empty database. Set `NOX_EMBEDDING_MODEL` + `NOX_EMBEDDING_DIM` deliberately. Vectors from different models are not comparable — mixing silently corrupts semantic search.

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

By default nox-mem uses **Gemini via Google AI Studio** for both LLM synthesis and embeddings (`GEMINI_API_KEY`, model `gemini-2.5-flash-lite`, embeddings `gemini-embedding-001` at 3072 dimensions).

Both axes are independently pluggable at runtime — no rebuild required.

### LLM synthesis (reflect, answer, kg-extract)

Supported values for `NOX_LLM_PROVIDER`: `gemini` (default) · `openai` (any OpenAI-compatible endpoint) · `anthropic`.

**Example — DeepSeek via direct API (OpenAI-compat):**
```bash
NOX_LLM_PROVIDER=openai
NOX_LLM_BASE_URL=https://api.deepseek.com/v1
NOX_LLM_MODEL=deepseek-chat
NOX_LLM_API_KEY=sk-...
```

**Example — Anthropic Claude:**
```bash
NOX_LLM_PROVIDER=anthropic
NOX_LLM_MODEL=claude-3-5-haiku-20241022
NOX_LLM_API_KEY=sk-ant-...   # or set ANTHROPIC_API_KEY
```

**Example — local Ollama:**
```bash
NOX_LLM_PROVIDER=openai
NOX_LLM_BASE_URL=http://127.0.0.1:11434/v1
NOX_LLM_MODEL=llama3.2
NOX_LLM_API_KEY=ollama
```

**Fallback chain:** `NOX_LLM_FALLBACK=openai:gpt-4o-mini` — tried if the primary LLM call fails.

### Embedding provider

Supported values for `NOX_EMBEDDING_PROVIDER` (alias `NOX_EMBED_PROVIDER`): `gemini` (default) · `openai` (any OpenAI-compat endpoint, including local Ollama/vLLM) · `voyage`.

**Example — OpenAI native (3072-dim parity with default Gemini table):**
```bash
NOX_EMBEDDING_PROVIDER=openai
NOX_EMBEDDING_BASE_URL=https://api.openai.com/v1
NOX_EMBEDDING_MODEL=text-embedding-3-large
NOX_EMBEDDING_DIM=3072
NOX_EMBEDDING_API_KEY=sk-...
```

**Example — local Ollama embedding:**
```bash
NOX_EMBEDDING_PROVIDER=openai
NOX_EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1
NOX_EMBEDDING_MODEL=nomic-embed-text
NOX_EMBEDDING_DIM=768          # must match the model's output dim
NOX_EMBEDDING_API_KEY=ollama
```

> ⚠️ **Dimension lock:** the sqlite-vec table is created once with a fixed dimension. Switching embedding provider or model requires re-embedding the **entire corpus** with a single model at a single dimension, and that dimension must match the `vec0` table. `text-embedding-3-large` supports `dimensions=3072` (matches the default Gemini table). `text-embedding-3-small` outputs 1536 — only usable with a fresh/empty database. Set `NOX_EMBEDDING_MODEL` + `NOX_EMBEDDING_DIM` deliberately and do not mix vectors from different models.

---

## Operation audit snapshots

All destructive operations (reindex, consolidate, compact, crystallize, kg-prune) create an atomic SQLite snapshot before mutating data. Snapshots land in `$NOX_PRE_OP_SNAPSHOT_DIR` (default: `/var/backups/nox-mem/pre-op/`). Retention: 7 days. Do NOT restore with raw `cp` — use the `safeRestore()` path or the `--restore` flag which handles WAL/SHM cleanup correctly.

---

## Sanity check

After install, verify the engine is healthy:

```bash
# Start the API server (no `serve` subcommand — run the server entry directly)
node "$(npm root -g)/nox-mem/dist/api-server.js" &

# Check vector coverage (should be close to 1.0). Code default port is 18800.
curl -s "http://127.0.0.1:${NOX_API_PORT:-18800}/api/health" | jq .vectorCoverage
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
node dist/api-server.js    — start HTTP API on $NOX_API_PORT (code default 18800)
node dist/mcp-server.js    — start MCP server (20 tools, for agents)
nox-mem --help             — full command reference
```

---

## sqlite-vec and platform binaries

`sqlite-vec` ships native `.so`/`.dylib`/`.dll` files as platform-specific optional npm packages (`sqlite-vec-linux-x64`, `sqlite-vec-darwin-arm64`, etc.). A plain `npm install` on a supported platform automatically resolves and downloads the correct binary — no `postinstall` script required. The nox-mem `package.json` explicitly lists all platform variants under `optionalDependencies` so package managers that strip optional deps by default still see them declared.

---

*MIT License — Copyright (c) 2026 Luiz Antonio Busnello (Toto)*
