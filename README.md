# NOX-Supermem

> **Pain-weighted hybrid memory for AI agents.** Self-hosted, multi-provider, zero vendor lock-in. MIT.

Long-term memory engine that any agent (OpenClaw, Hermes, Claude Code, custom) can use to *remember decisions, search past context, and never ask "where were we?" again.* Hybrid retrieval (FTS5 keyword + vector semantic + reciprocal-rank fusion), a knowledge graph, and salience ranking that weights what hurt to forget.

**Stack:** TypeScript · Node 20+ · SQLite (FTS5 + sqlite-vec) · Gemini embeddings by default · any OpenAI-compatible API optional.

The engine lives in [`nox-mem/`](./nox-mem). It ships with **no data** — your memory starts empty.

---

## Three ways to use it

| Interface | Command | Best for |
|---|---|---|
| **CLI** | `nox-mem <cmd>` | humans, scripts, cron |
| **MCP server** | `node nox-mem/dist/mcp-server.js` | **agents** (OpenClaw, Hermes, Claude Code…) — 20 tools |
| **HTTP API** | `node nox-mem/dist/api-server.js` | services, dashboards, remote agents |

---

## TL;DR (copy-paste)

```bash
git clone https://github.com/totobusnello/nox-supermem.git
cd nox-supermem/nox-mem
npm ci && npm run build && npm install -g .      # needs Node 20+, build-essential, python3

export GEMINI_API_KEY=AIza...                    # https://aistudio.google.com/apikey
export NOX_DB_PATH="$HOME/.nox-mem/nox.db"
export NOX_MEM_DIR="$HOME/.nox-mem/memory"
mkdir -p "$HOME/.nox-mem/memory"

nox-mem stats                                    # creates schema v10 on first run
echo "# my first memory" > "$HOME/.nox-mem/memory/note.md"
nox-mem ingest "$HOME/.nox-mem/memory/note.md"
nox-mem vectorize
nox-mem search "first memory"
```

---

## Installation — step by step (humans)

### 0. Prerequisites (Linux / macOS)

```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y build-essential python3 inotify-tools
node --version   # must be >= 20
```

`build-essential` + `python3` compile the native modules (`better-sqlite3`, `sqlite-vec`). `inotify-tools` is only needed for the optional file watcher.

### 1. Get the code

```bash
git clone https://github.com/totobusnello/nox-supermem.git
cd nox-supermem
```

### 2. Build & install the engine

Either the one-liner installer:

```bash
bash install.sh            # add --dry-run to preview without changing anything
```

…or manually:

```bash
cd nox-mem
npm ci
npm run build              # tsc → dist/
npm install -g .           # exposes `nox-mem` globally
nox-mem --help
```

### 3. Configure

Create a `.env` (template in [`nox-mem/.env.example`](./nox-mem/.env.example)):

```bash
# Required
GEMINI_API_KEY=AIza...                 # Google AI Studio key
NOX_DB_PATH=/root/.nox-mem/nox.db      # SQLite database (any path you can write)
NOX_MEM_DIR=/root/.nox-mem/memory      # folder of markdown memories

# HTTP API (optional) — code default port is 18800; 18802 recommended to avoid clashes
NOX_API_PORT=18802
NOX_API_HOST=127.0.0.1
# NOX_API_TOKEN=change-me              # if set, API requires Authorization: Bearer <token>
```

Always load it before running the CLI in a shell, cron, or service:

```bash
set -a; source /root/.nox-mem/.env; set +a
```

> ⚠️ Without sourcing the env, `vectorize`/`kg-*` fail **silently** ("Done: 0 embedded").

### 4. Initialize & verify

```bash
nox-mem stats     # first run creates the v10 schema (11 tables) automatically — no migrations to run
nox-mem doctor    # diagnostic: SQLite, FTS5, vector extension, config
```

### 5. Ingest, embed, search

```bash
nox-mem ingest /path/to/notes.md     # plain markdown is fine
nox-mem vectorize                    # embeds new chunks (needs GEMINI_API_KEY)
nox-mem search "what did we decide about pricing"
nox-mem primer                       # ~500-token context-recovery summary
```

---

## Installation — for AI agents (OpenClaw / Hermes / others)

Agents should connect over **MCP** (preferred) or the **HTTP API**. The deterministic bootstrap below is idempotent — each step verifies before continuing.

### Deterministic bootstrap (run in order; stop on first failure)

```bash
# 1. preconditions
node --version | grep -qE 'v(2[0-9]|[3-9][0-9])' || { echo "need Node >=20"; exit 1; }

# 2. clone + build + install
git clone https://github.com/totobusnello/nox-supermem.git
cd nox-supermem/nox-mem && npm ci && npm run build && npm install -g .

# 3. config (export or write .env)
export GEMINI_API_KEY="<key>" NOX_DB_PATH="/data/nox/nox.db" NOX_MEM_DIR="/data/nox/memory"
mkdir -p "$NOX_MEM_DIR"

# 4. verify schema + health
nox-mem stats | grep -q "Chunks:" || { echo "schema init failed"; exit 1; }
```

### As an MCP server (recommended for agents)

The MCP server exposes **20 tools** (`nox_mem_search`, `nox_mem_ingest`, `nox_mem_primer`, `nox_mem_reflect`, `nox_mem_kg_query`, `nox_mem_decision_*`, `nox_mem_cross_search`, …).

Add this to your agent's MCP config (Claude Code `.mcp.json`, OpenClaw/Hermes equivalent):

```json
{
  "mcpServers": {
    "nox-mem": {
      "command": "node",
      "args": ["/abs/path/to/nox-supermem/nox-mem/dist/mcp-server.js"],
      "env": {
        "GEMINI_API_KEY": "AIza...",
        "NOX_DB_PATH": "/data/nox/nox.db",
        "NOX_MEM_DIR": "/data/nox/memory"
      }
    }
  }
}
```

The agent then calls `nox_mem_search` to recall and `nox_mem_ingest` to store. Run `nox-mem primer` (or the MCP `nox_mem_primer` tool) at session start for context recovery.

### As an HTTP API

```bash
set -a; source /data/nox/.env; set +a
node "$(npm root -g)/nox-mem/dist/api-server.js"      # or: node nox-mem/dist/api-server.js from the repo
```

Endpoints on `http://$NOX_API_HOST:$NOX_API_PORT`:

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | status + `vectorCoverage` (embedded vs total) |
| `GET /api/search?q=...` | hybrid search |
| `GET /api/brief` | salience-ranked session priming |
| `POST /api/answer` | RAG answer over memory |
| `GET /api/kg`, `/api/kg/path` | knowledge graph |
| `GET /api/reflect` | high-salience insights |

If `NOX_API_TOKEN` is set, send `Authorization: Bearer <token>`.

---

## Multi-provider (LLM + embeddings)

Default is **Gemini via Google AI Studio**. To run the LLM/embeddings against any **OpenAI-compatible** endpoint (DeepSeek, OpenRouter, Together, local Ollama/vLLM), set:

```bash
# LLM
NOX_LLM_PROVIDER=openai
NOX_LLM_BASE_URL=https://api.deepseek.com/v1     # or openrouter.ai/api/v1, api.together.xyz/v1, http://127.0.0.1:11434/v1
NOX_LLM_MODEL=deepseek-chat
NOX_LLM_API_KEY=sk-...

# Embeddings (keep one model/dim for the whole corpus)
NOX_EMBEDDING_PROVIDER=openai
NOX_EMBEDDING_BASE_URL=https://api.openai.com/v1
NOX_EMBEDDING_MODEL=text-embedding-3-large
NOX_EMBEDDING_DIM=3072        # MUST equal the vec0 table dim; changing model/dim requires re-embedding
NOX_EMBEDDING_API_KEY=sk-...
```

> ⚠️ Embeddings from different models/dimensions are not comparable. Pick one up front — mixing silently corrupts semantic search. Full env reference: [`nox-mem/README.md`](./nox-mem/README.md).

---

## Verify it's healthy

```bash
node "$(npm root -g)/nox-mem/dist/api-server.js" &
curl -s "http://127.0.0.1:${NOX_API_PORT:-18800}/api/health" | jq .vectorCoverage
# close to 1.0 = all chunks embedded; below 0.99 → run `nox-mem vectorize`
```

---

## Command reference

`nox-mem --help` lists all commands. Highlights:

```
search · ingest · ingest-entity · vectorize · reindex · stats · doctor · primer
kg-build · kg-query · kg-path · kg-merge · reflect · crystallize
decision-set/get/history/list · cross-search · digest · watch
```

Full env-var reference and per-command notes: **[`nox-mem/README.md`](./nox-mem/README.md)**.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `vectorize` says "0 embedded" | env not sourced — `set -a; source .env; set +a` |
| `vec0 ... cannot open shared object` | platform binary missing — `npm i -g sqlite-vec` or reinstall on the target OS |
| `better-sqlite3` build error | install `build-essential` + `python3`, then `npm ci` again |
| API port in use | set `NOX_API_PORT` (code default is 18800) |
| path rejected by op-audit guard | DB/snapshot must sit under an allowed prefix — set `NOX_OP_AUDIT_ALLOWED_PREFIXES` or use `NOX_DB_PATH`/`NOX_MEM_DIR` (auto-allowed) |

---

## License

MIT © 2026 Luiz Antonio Busnello (Toto). Use it, fork it, ship it.
