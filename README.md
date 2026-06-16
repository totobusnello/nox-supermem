<h1 align="center">NOX-Supermem</h1>

<p align="center"><em>Pain-weighted hybrid memory for AI agents &mdash; genuinely yours. SQLite on your disk, provider your choice, zero vendor lock-in.</em></p>

<p align="center">
  <img src="https://img.shields.io/badge/Q-Quality-00C896?style=for-the-badge&labelColor=1A1A2E" alt="Quality: numbers #1">
  <img src="https://img.shields.io/badge/A-Autonomy-00C896?style=for-the-badge&labelColor=1A1A2E" alt="Autonomy: data yours, provider yours">
  <img src="https://img.shields.io/badge/P-Product-00C896?style=for-the-badge&labelColor=1A1A2E" alt="Product: UX that ships">
</p>

<p align="center">
  <a href="LICENSE.md"><img src="https://img.shields.io/github/license/totobusnello/nox-supermem?style=for-the-badge&color=00C896" alt="License: MIT"></a>
  <a href="https://github.com/totobusnello/nox-supermem/stargazers"><img src="https://img.shields.io/github/stars/totobusnello/nox-supermem?style=for-the-badge&color=00C896" alt="Stars"></a>
  <a href="https://github.com/totobusnello/nox-supermem/actions/workflows/build.yml"><img src="https://img.shields.io/github/actions/workflow/status/totobusnello/nox-supermem/build.yml?style=for-the-badge&color=00C896&label=ci" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-00C896?style=for-the-badge" alt="Node >=20">
  <img src="https://img.shields.io/badge/interfaces-CLI%20%C2%B7%20MCP%20%C2%B7%20HTTP-00C896?style=for-the-badge" alt="CLI · MCP · HTTP">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/memory_benchmark-SOTA-00C896?style=flat-square&labelColor=1A1A2E" alt="Memory benchmark SOTA">
  <img src="https://img.shields.io/badge/KG_path-2.5ms_p50-00C896?style=flat-square&labelColor=1A1A2E" alt="KG path 2.5ms p50">
  <img src="https://img.shields.io/badge/KG_query-%240.00-00C896?style=flat-square&labelColor=1A1A2E" alt="$0.00 per KG query">
  <img src="https://img.shields.io/badge/footprint-399MB_single_process-00C896?style=flat-square&labelColor=1A1A2E" alt="399MB single process">
  <img src="https://img.shields.io/badge/store-1_SQLite_file-00C896?style=flat-square&labelColor=1A1A2E" alt="1 SQLite file">
</p>

<p align="center">
  <a href="#-quick-install">⚡ Install</a> &middot;
  <a href="#-three-ways-to-use-it">Interfaces</a> &middot;
  <a href="#-for-ai-agents-openclaw--hermes--others">For agents</a> &middot;
  <a href="#-the-numbers">Numbers</a> &middot;
  <a href="#-multi-provider">Multi-provider</a>
</p>

Long-term memory engine that any agent (OpenClaw, Hermes, Claude Code, custom) can use to *remember decisions, search past context, and never ask "where were we?" again.* Hybrid retrieval (FTS5 keyword + vector semantic + reciprocal-rank fusion), a knowledge graph, and salience ranking that weights what hurt to forget. The engine lives in [`nox-mem/`](./nox-mem) and ships with **no data** — your memory starts empty.

---

## ⚡ Quick Install

```bash
# 1. Get it + build (needs Node 20+, build-essential, python3)
git clone https://github.com/totobusnello/nox-supermem.git
cd nox-supermem/nox-mem
npm ci && npm run build && npm install -g .

# 2. Point it at a key + a place to store memory
export GEMINI_API_KEY=AIza...                 # https://aistudio.google.com/apikey
export NOX_DB_PATH="$HOME/.nox-mem/nox.db"
export NOX_MEM_DIR="$HOME/.nox-mem/memory"
mkdir -p "$HOME/.nox-mem/memory"

# 3. Use it
nox-mem stats                                 # first run creates the schema (empty)
nox-mem ingest "$HOME/.nox-mem/memory/note.md"
nox-mem vectorize
nox-mem search "what did we decide?"
```

> 🐧 **One-liner installer:** `bash install.sh` (add `--dry-run` to preview). 🍎 macOS / 🐧 Linux. Full step-by-step (humans) and a deterministic bootstrap (agents) are below.

---

## 🧩 Three ways to use it

| Interface | Command | Best for |
|---|---|---|
| **CLI** | `nox-mem <cmd>` | humans, scripts, cron |
| **MCP server** | `node nox-mem/dist/mcp-server.js` | **agents** (OpenClaw, Hermes, Claude Code…) — 20 tools |
| **HTTP API** | `node nox-mem/dist/api-server.js` | services, dashboards, remote agents |

**Stack:** TypeScript · Node 20+ · SQLite (FTS5 + sqlite-vec) · Gemini embeddings by default · any OpenAI-compatible API optional.

---

## 📥 Installation — step by step (humans)

### 0. Prerequisites (Linux / macOS)

```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install -y build-essential python3 inotify-tools
node --version   # must be >= 20
```

`build-essential` + `python3` compile the native modules (`better-sqlite3`, `sqlite-vec`). `inotify-tools` is only needed for the optional file watcher.

### 1–2. Clone, build, install

```bash
git clone https://github.com/totobusnello/nox-supermem.git
cd nox-supermem/nox-mem
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

## 🤖 For AI agents (OpenClaw / Hermes / others)

Agents connect over **MCP** (preferred) or the **HTTP API**. The bootstrap below is idempotent — each step verifies before continuing.

### Deterministic bootstrap (run in order; stop on first failure)

```bash
# 1. preconditions
node --version | grep -qE 'v(2[0-9]|[3-9][0-9])' || { echo "need Node >=20"; exit 1; }

# 2. clone + build + install
git clone https://github.com/totobusnello/nox-supermem.git
cd nox-supermem/nox-mem && npm ci && npm run build && npm install -g .

# 3. config
export GEMINI_API_KEY="<key>" NOX_DB_PATH="/data/nox/nox.db" NOX_MEM_DIR="/data/nox/memory"
mkdir -p "$NOX_MEM_DIR"

# 4. verify schema
nox-mem stats | grep -q "Chunks:" || { echo "schema init failed"; exit 1; }
```

### As an MCP server (recommended)

20 tools (`nox_mem_search`, `nox_mem_ingest`, `nox_mem_primer`, `nox_mem_reflect`, `nox_mem_kg_query`, `nox_mem_decision_*`, `nox_mem_cross_search`, …). Add to your agent's MCP config (Claude Code `.mcp.json`, OpenClaw/Hermes equivalent):

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

The agent calls `nox_mem_search` to recall and `nox_mem_ingest` to store. Run `nox_mem_primer` at session start for context recovery. Three reusable agent profiles (`assistente-pessoal`, `financeiro`, `pesquisador`) live in [`perfis/`](./perfis); generic SOUL/HEARTBEAT/IDENTITY templates in [`templates/`](./templates).

### As an HTTP API

```bash
set -a; source /data/nox/.env; set +a
node "$(npm root -g)/nox-mem/dist/api-server.js"      # or: node nox-mem/dist/api-server.js from the repo
```

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

## 📊 The numbers

The engine is the same core benchmarked in [`memoria-nox`](https://github.com/totobusnello/memoria-nox). All results 5-batch + 95% CI verified.

### Memory & multi-hop SOTA

| Benchmark | nox-mem | Best competitor | Δ |
|---|---:|---|---:|
| **EverMemBench Overall** (Gemini-3-flash) | **63.28%** | MemOS 42.55% | **+20.73pp** |
| **EverMemBench MA composite** | **88.42%** | MemOS 55.68% | **+32.74pp** |
| **LoCoMo retrieval@10 strict** | **74.52%** | Mem0 SOTA F1 66.88% | above |
| **MuSiQue F1** (n=2,417, single-shot) | **58.62%** | IRCoT 35.80% / EX(SA) 49.70% | **+22.82pp / +8.92pp** |
| **HotPotQA ans_F1** (n=7,405 distractor) | **73.37%** | DPR+FiD reader 65–72% | **above band** |

### Production characteristics

| Dimension | nox-mem | Comparison |
|---|---:|---|
| **KG path latency** | **2.5ms p50** | none sub-10ms published |
| **KG path cost/query** | **$0.00** | Mem0 Cloud $0.001 → **769× cheaper** |
| **Self-hosted footprint** | **399MB single-process** | Zep/Mem0/MemOS run 4+ services |
| **Backbone portability** | **−10.54pp on backbone swap** | MemOS −16.72pp → **1.6× more portable** |
| **Monthly OPEX** (embed + KG + VPS) | **< $11/mo** all-in | — |

<sub>Methodology, paper, and full competitive analysis: [`memoria-nox`](https://github.com/totobusnello/memoria-nox). MemOS arXiv:2602.01313 · MuSiQue (Trivedi 2022) · HotPotQA (Yang 2018).</sub>

---

## 🔌 Multi-provider

Default is **Gemini via Google AI Studio**. Point the LLM/embeddings at any **OpenAI-compatible** endpoint (DeepSeek, OpenRouter, Together, local Ollama/vLLM):

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

## 🩺 Verify & troubleshoot

```bash
node "$(npm root -g)/nox-mem/dist/api-server.js" &
curl -s "http://127.0.0.1:${NOX_API_PORT:-18800}/api/health" | jq .vectorCoverage
# close to 1.0 = all chunks embedded; below 0.99 → run `nox-mem vectorize`
```

| Symptom | Fix |
|---|---|
| `vectorize` says "0 embedded" | env not sourced — `set -a; source .env; set +a` |
| `vec0 ... cannot open shared object` | platform binary missing — `npm i -g sqlite-vec` or reinstall on the target OS |
| `better-sqlite3` build error | install `build-essential` + `python3`, then `npm ci` again |
| API port in use | set `NOX_API_PORT` (code default is 18800) |
| path rejected by op-audit guard | set `NOX_OP_AUDIT_ALLOWED_PREFIXES`, or keep DB under `NOX_DB_PATH`/`NOX_MEM_DIR` (auto-allowed) |

Full env-var reference and per-command notes: **[`nox-mem/README.md`](./nox-mem/README.md)**.

---

## License

MIT © 2026 Luiz Antonio Busnello (Toto). Use it, fork it, ship it.
