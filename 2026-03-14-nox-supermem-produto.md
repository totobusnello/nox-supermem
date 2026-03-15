# NOX-Supermem Product Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the nox-mem memory system into a sellable digital product (NOX-Supermem) for the Brazilian OpenClaw market on Hotmart.

**Architecture:** Copy and genericize the proven nox-mem TypeScript codebase into a standalone repo (`nox-supermem`). Replace all hardcoded paths with a `config.json` loaded at startup. Add install.sh for one-command setup, Markdown templates for agent profiles, and PT-BR documentation.

**Tech Stack:** TypeScript, better-sqlite3, FTS5, Ollama, systemd, inotifywait, Notion API (optional)

**Source code reference:** `/tmp/nox-mem-v2/` and `/tmp/nox-mem-v3/` (latest versions of each file)
> **NOTE:** These are temp paths from the development session. Before starting implementation, verify they exist. If cleaned up, the code is also deployed at `root@100.87.8.44:/root/.openclaw/workspace/tools/nox-mem/src/` (VPS via Tailscale).
**Product spec:** `~/Claude/Projetos/memoria-nox/specs/2026-03-14-nox-supermem-produto-design.md`
**Target repo:** `~/Claude/Projetos/nox-supermem/` (GitHub: totobusnello/nox-supermem, private)

---

## File Structure

```
nox-supermem/
+-- README.md                          -- Welcome, index, requirements (PT-BR)
+-- GUIA-INSTALACAO.md                 -- Step-by-step guide (15 sections, convert to PDF manually)
+-- LICENSE.md                         -- Personal use, no redistribution
+-- install.sh                         -- One-command automated installer
+-- nox-mem/
|   +-- package.json                   -- Dependencies (better-sqlite3, commander)
|   +-- tsconfig.json                  -- TypeScript config (ES2022, NodeNext)
|   +-- config.example.json            -- Example configuration
|   +-- src/
|   |   +-- config.ts                  -- Config loader (config.json + env vars + defaults)
|   |   +-- index.ts                   -- CLI entry point (10 commands)
|   |   +-- db.ts                      -- SQLite singleton + FTS5 schema + migrations
|   |   +-- ingest.ts                  -- Markdown/JSON chunking + UTF-8 sanitization
|   |   +-- search.ts                  -- FTS5 search + BM25 + boost + recency
|   |   +-- primer.ts                  -- Context recovery post-compaction (~500 tokens)
|   |   +-- consolidate.ts             -- AI fact extraction via Ollama
|   |   +-- notion-sync.ts             -- Optional Notion sync
|   |   +-- digest.ts                  -- Weekly digest via Ollama
|   |   +-- reindex.ts                 -- Full index rebuild (preserves consolidation)
|   |   +-- doctor.ts                  -- System diagnostics
|   |   +-- stats.ts                   -- Memory statistics
|   |   +-- appendInSection.ts         -- Markdown section inserter utility
|   +-- prompts/
|   |   +-- consolidate.txt            -- Fact extraction prompt (PT-BR)
|   |   +-- digest.txt                 -- Weekly summary prompt (PT-BR)
|   +-- nox-mem-watch.sh               -- File watcher with debounce
|   +-- nox-mem-watcher.service        -- systemd unit file template
+-- templates/
|   +-- SOUL.md                        -- Agent personality (customizable)
|   +-- MEMORY.md                      -- Memory index with cycle explained
|   +-- TOOLS.md                       -- Tool documentation
|   +-- HEARTBEAT.md                   -- Proactive checklist
|   +-- IDENTITY.md                    -- Agent identity
|   +-- SESSION-STATE.md               -- Session state (WAL protocol)
+-- perfis/                            -- Agent profiles (Tier B)
|   +-- assistente-pessoal/
|   |   +-- SOUL.md
|   |   +-- HEARTBEAT.md
|   |   +-- README.md
|   +-- pesquisador/
|   |   +-- SOUL.md
|   |   +-- HEARTBEAT.md
|   |   +-- README.md
|   +-- financeiro/
|       +-- SOUL.md
|       +-- HEARTBEAT.md
|       +-- README.md
+-- troubleshooting/
|   +-- FAQ.md                         -- 20+ common problems with solutions
+-- video/
|   +-- ACESSO-VIDEO.md                -- Private video link (Tier B)
+-- suporte/
    +-- ACESSO-SUPORTE.md              -- Support access instructions (Tier C)
    +-- CHATBOT-INFO.md                -- What the chatbot can answer
```

---

## Chunk 1: Project Scaffold + Config System + Core Modules

### Task 1: Initialize project structure

**Files:**
- Create: `nox-supermem/nox-mem/package.json`
- Create: `nox-supermem/nox-mem/tsconfig.json`
- Create: `nox-supermem/.gitignore`

- [ ] **Step 1: Create package.json with dependencies**

package.json with name "nox-supermem", version "1.0.0", type "module",
bin pointing to "dist/index.js", dependencies: better-sqlite3 ^11.0.0, commander ^12.0.0,
devDependencies: @types/better-sqlite3, @types/node, typescript ^5.6.0.
Scripts: build (tsc), start (node dist/index.js), test (node --test).

- [ ] **Step 2: Create tsconfig.json**

Target ES2022, module NodeNext, outDir dist, rootDir src, strict true.

- [ ] **Step 3: Create .gitignore**

Ignore: node_modules/, dist/, *.db, *.db-wal, *.db-shm, .DS_Store, last-sync.json

- [ ] **Step 4: Commit scaffold**

```bash
cd ~/Claude/Projetos/nox-supermem
git add nox-mem/package.json nox-mem/tsconfig.json .gitignore
git commit -m "feat: initialize project scaffold"
```

---

### Task 2: Create config system (key genericization layer)

**Files:**
- Create: `nox-supermem/nox-mem/src/config.ts`
- Create: `nox-supermem/nox-mem/config.example.json`

Every hardcoded value from the original nox-mem becomes configurable here.

- [ ] **Step 1: Create config.ts**

Define `SupermemConfig` interface with sections:
- `workspace`: string (detection chain: config.json > $OPENCLAW_WORKSPACE > `openclaw config get workspace` > ~/.openclaw/workspace)
- `promptsDir`: string (auto-derived: resolve(__dirname, "..", "prompts") -- not user-configurable)
- `ollama`: { url, model } (defaults: localhost:11434, llama3.2:3b)
- `notion`: { enabled, token, databaseId, apiVersion } (default: disabled)
- `consolidation`: { maxFilesPerRun, timeoutMs, retries } (defaults: 5, 120000, 3)
- `watcher`: { debounceMs, excludeFiles } (defaults: 3000, [MEMORY.md, SESSION-STATE.md])

Implement `getConfig()` as singleton with this detection chain (in priority order):
1. Reads `config.json` from project root (resolve(__dirname, "..", "config.json"))
2. Falls back to `$OPENCLAW_WORKSPACE` env var
3. Falls back to `openclaw config get workspace` shell command (try/catch, ignore if not available)
4. Falls back to `~/.openclaw/workspace` default
5. Deep-merges user config with defaults
6. Expands `~` in workspace path
7. Caches result

The config also derives `promptsDir` automatically: `resolve(__dirname, "..", "prompts")` — this ensures consolidate.ts and digest.ts can always find their prompt files regardless of where nox-mem is installed.

- [ ] **Step 2: Create config.example.json**

JSON with all configurable options and descriptive values (e.g., "ntn_seu_token_aqui").

- [ ] **Step 3: Verify compiles**

Run: `cd nox-supermem/nox-mem && npm install && npx tsc --noEmit src/config.ts`

- [ ] **Step 4: Commit**

```bash
git add nox-mem/src/config.ts nox-mem/config.example.json
git commit -m "feat: add config system replacing all hardcoded paths"
```

---

### Task 3: Genericize db.ts

**Files:**
- Create: `nox-supermem/nox-mem/src/db.ts`

- [ ] **Step 1: Create db.ts**

Copy from `/tmp/nox-mem-v2/db.ts`. Changes:
- Import `getConfig` from `./config.js`
- Replace `DB_PATH` constant with `getDbPath()` function that derives path from `config.workspace`
- DB location: `{workspace}/tools/nox-mem/nox-mem.db`
- Keep entire schema migration system (v1 + v2) exactly as-is
- Keep `getDb()` singleton and `closeDb()` unchanged

- [ ] **Step 2: Verify compiles**

Run: `cd nox-supermem/nox-mem && npx tsc --noEmit src/db.ts`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add nox-mem/src/db.ts
git commit -m "feat: genericize db.ts with config-based path"
```

---

### Task 4: Genericize ingest.ts

**Files:**
- Create: `nox-supermem/nox-mem/src/ingest.ts`

- [ ] **Step 1: Create ingest.ts**

Copy from `/tmp/nox-mem-v3/ingest.ts`. Single change:
- Replace `const WORKSPACE = "/root/.openclaw/workspace"` with `import { getConfig } from "./config.js"`
- Use `getConfig().workspace` wherever `WORKSPACE` was used
- Keep all chunking logic, UTF-8 sanitization, TYPE_MAP unchanged

- [ ] **Step 2: Verify compiles**

Run: `cd nox-supermem/nox-mem && npx tsc --noEmit src/ingest.ts`

- [ ] **Step 3: Commit**

```bash
git add nox-mem/src/ingest.ts
git commit -m "feat: genericize ingest.ts with config workspace"
```

---

### Task 5: Copy search.ts + stats.ts (no changes needed)

**Files:**
- Create: `nox-supermem/nox-mem/src/search.ts`
- Create: `nox-supermem/nox-mem/src/stats.ts`

- [ ] **Step 1: Verify search.ts has no hardcoded paths**

Run: `grep -n "openclaw\|/root/" /tmp/nox-mem-v2/search.ts`
Expected: No matches (only uses getDb(), no workspace references)

- [ ] **Step 2: Copy search.ts from /tmp/nox-mem-v2/search.ts**

Confirmed no changes needed - uses only `getDb()`.

- [ ] **Step 3: Verify stats.ts has no hardcoded paths**

Run: `grep -n "openclaw\|/root/" /tmp/nox-mem-v2/stats.ts`
Expected: No matches

- [ ] **Step 4: Copy stats.ts from /tmp/nox-mem-v2/stats.ts**

Confirmed no changes needed.

- [ ] **Step 5: Commit**

```bash
git add nox-mem/src/search.ts nox-mem/src/stats.ts
git commit -m "feat: add search and stats modules"
```

---

### Task 6: Genericize primer.ts

**Files:**
- Create: `nox-supermem/nox-mem/src/primer.ts`

- [ ] **Step 1: Create primer.ts**

Copy from `/tmp/nox-mem-v4/primer.ts`. Change:
- Replace `const WORKSPACE` with `import { getConfig } from "./config.js"`
- Use `getConfig().workspace` for SESSION-STATE.md path
- Keep extractDecisionLine() with all 3 format parsers unchanged

- [ ] **Step 2: Verify compiles**

Run: `cd nox-supermem/nox-mem && npx tsc --noEmit src/primer.ts`

- [ ] **Step 3: Commit**

```bash
git add nox-mem/src/primer.ts
git commit -m "feat: genericize primer.ts with config workspace"
```

---

## Chunk 2: Complex Modules + CLI

### Task 7: Extract appendInSection utility

**Files:**
- Create: `nox-supermem/nox-mem/src/appendInSection.ts`

- [ ] **Step 1: Create appendInSection.ts**

Extract `appendInSection()` and `ensureFile()` from `/tmp/nox-mem-v3/consolidate.ts` (lines 72-104) into standalone module.
- `ensureFile(path, header)`: creates file with header if it doesn't exist
- `appendInSection(path, section, content)`: inserts content inside correct markdown section (before next ## or end of file)

- [ ] **Step 2: Commit**

```bash
git add nox-mem/src/appendInSection.ts
git commit -m "feat: extract appendInSection utility module"
```

---

### Task 8: Genericize consolidate.ts

**Files:**
- Create: `nox-supermem/nox-mem/src/consolidate.ts`

Largest module. Key changes from `/tmp/nox-mem-v3/consolidate.ts`:

- [ ] **Step 1: Create consolidate.ts**

Copy from `/tmp/nox-mem-v3/consolidate.ts` with these changes:
- Replace `WORKSPACE`, `OLLAMA_URL`, `MODEL`, `MAX_FILES_PER_RUN` constants with `getConfig()` calls
- Import `appendInSection`, `ensureFile` from `./appendInSection.js` (remove local definitions)
- Remove unused `appendFileSync` import
- Replace PROMPT_PATH with `resolve(getConfig().promptsDir, "consolidate.txt")`
- In `callOllama()`: use `config.ollama.url`, `config.ollama.model`, `config.consolidation.timeoutMs`
- In `consolidate()`: use `config.consolidation.maxFilesPerRun`, `config.workspace` for all file paths
- In `gitCommit()`: use `config.workspace` for git -C path
- Fix pending Notion category: change `"Insight"` to `"Pendencia"`
- Use `execFileSync` (already used) for git commands (safe, no shell injection)

- [ ] **Step 2: Commit**

```bash
git add nox-mem/src/consolidate.ts
git commit -m "feat: genericize consolidate.ts with config and fix pending category"
```

---

### Task 9: Genericize notion-sync.ts

**Files:**
- Create: `nox-supermem/nox-mem/src/notion-sync.ts`

- [ ] **Step 1: Create notion-sync.ts**

Copy from `/tmp/nox-mem-v2/notion-sync.ts` with:
- Import `getConfig` from `./config.js`
- At start of `syncToNotion()`: check `config.notion.enabled`, skip if false
- Check `config.notion.token` and `config.notion.databaseId`, skip if empty
- Replace hardcoded NOTION_TOKEN, DATABASE_ID, Notion-Version with config values
- Keep rate limit (350ms between requests), saveSyncLog/loadSyncLog unchanged

- [ ] **Step 2: Commit**

```bash
git add nox-mem/src/notion-sync.ts
git commit -m "feat: genericize notion-sync with config and optional toggle"
```

---

### Task 10: Genericize digest.ts

**Files:**
- Create: `nox-supermem/nox-mem/src/digest.ts`

- [ ] **Step 1: Create digest.ts**

Copy from `/tmp/nox-mem-v3/digest.ts`, replace WORKSPACE/OLLAMA_URL/MODEL with `getConfig()`.
Use `getConfig().promptsDir` to locate `digest.txt` prompt file.

- [ ] **Step 2: Verify compiles**

Run: `cd nox-supermem/nox-mem && npx tsc --noEmit src/digest.ts`

- [ ] **Step 3: Commit**

```bash
git add nox-mem/src/digest.ts
git commit -m "feat: genericize digest.ts with config"
```

---

### Task 11: Genericize doctor.ts

**Files:**
- Create: `nox-supermem/nox-mem/src/doctor.ts`

- [ ] **Step 1: Create doctor.ts**

Copy from `/tmp/nox-mem-v2/doctor.ts`, replace hardcoded paths with `getConfig()`.
When `config.notion.enabled === false`, doctor should report "Notion: desabilitado (config)" instead of testing the connection.
Use `config.ollama.url` and `config.ollama.model` for health checks.

- [ ] **Step 2: Verify compiles**

Run: `cd nox-supermem/nox-mem && npx tsc --noEmit src/doctor.ts`

- [ ] **Step 3: Commit**

```bash
git add nox-mem/src/doctor.ts
git commit -m "feat: genericize doctor.ts with config and conditional Notion check"
```

---

### Task 12: Genericize reindex.ts

**Files:**
- Create: `nox-supermem/nox-mem/src/reindex.ts`

- [ ] **Step 1: Create reindex.ts**

Copy from `/tmp/nox-mem-v3/reindex.ts`, replace `WORKSPACE` with `getConfig().workspace`.

- [ ] **Step 2: Verify compiles**

Run: `cd nox-supermem/nox-mem && npx tsc --noEmit src/reindex.ts`

- [ ] **Step 3: Commit**

```bash
git add nox-mem/src/reindex.ts
git commit -m "feat: genericize reindex.ts with config workspace"
```

---

### Task 13: Create CLI entry point + prompts

**Files:**
- Create: `nox-supermem/nox-mem/src/index.ts`
- Create: `nox-supermem/nox-mem/prompts/consolidate.txt`
- Create: `nox-supermem/nox-mem/prompts/digest.txt`

- [ ] **Step 1: Create index.ts**

Copy from `/tmp/nox-mem-v3/index.ts` (latest version with 10 commands: search, ingest, reindex, primer, stats, consolidate, retry-failed, digest, sync-notion, doctor).
The spec says "8 comandos" but the implementation evolved to 10 during development (added retry-failed and doctor). All 10 ship in the product.
Change version to "1.0.0". No config changes needed (index.ts just wires commands).

- [ ] **Step 2: Create prompts/consolidate.txt**

PT-BR prompt for Ollama fact extraction. Instructs model to extract:
decisions, lessons, people, projects, pending items as JSON.
Rules: only concrete facts, use PT-BR, empty arrays if none, strategic vs tactical lessons.

- [ ] **Step 3: Create prompts/digest.txt**

PT-BR prompt for weekly summary. 5 sections: decisions, lessons, project progress, pending, patterns.
300-500 words, direct and practical.

- [ ] **Step 4: Build and verify**

Run: `cd nox-supermem/nox-mem && npm install && npm run build`
Expected: Clean compilation, dist/ folder with all .js files

- [ ] **Step 5: Commit**

```bash
git add nox-mem/src/index.ts nox-mem/prompts/
git commit -m "feat: add CLI entry point and PT-BR prompts"
```

---

### End-of-Chunk 2 Verification

- [ ] **Full type check across all modules**

Run: `cd nox-supermem/nox-mem && npx tsc --noEmit`
Expected: Zero errors across all 12 source files

---

## Chunk 3: Installer + Watcher + Service

### Task 14: Create file watcher script

**Files:**
- Create: `nox-supermem/nox-mem/nox-mem-watch.sh`

- [ ] **Step 1: Create nox-mem-watch.sh**

Bash script that:
1. Loads workspace from config.json (via node one-liner) or falls back to $OPENCLAW_WORKSPACE
2. Uses `inotifywait -m -r` to monitor memory/ and shared/ for .md/.json changes
3. Excludes MEMORY.md and SESSION-STATE.md
4. Debounces with lock files in /tmp/nox-mem-locks/ (3s per file, using md5sum)
5. Calls `node dist/index.js ingest "$FULL_PATH"` on change

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x nox-supermem/nox-mem/nox-mem-watch.sh
git add nox-mem/nox-mem-watch.sh
git commit -m "feat: add file watcher with config-based workspace detection"
```

---

### Task 15: Create systemd service template

**Files:**
- Create: `nox-supermem/nox-mem/nox-mem-watcher.service`

- [ ] **Step 1: Create service file**

systemd unit with `__NOX_MEM_PATH__` placeholder (replaced by install.sh).
Type=simple, Restart=always, RestartSec=5.

- [ ] **Step 2: Commit**

```bash
git add nox-mem/nox-mem-watcher.service
git commit -m "feat: add systemd service template"
```

---

### Task 16: Create install.sh

**Files:**
- Create: `nox-supermem/install.sh`

The **one-command installer** -- core of Tier A value proposition.

- [ ] **Step 1: Create install.sh**

Bash script with colored output that:
1. Detects workspace ($OPENCLAW_WORKSPACE or common locations)
2. Checks Node.js 20+
3. Installs inotify-tools (apt-get or yum)
4. Installs Ollama if not present (curl | sh)
5. Pulls llama3.2:3b model
6. Copies nox-mem/ to $WORKSPACE/tools/nox-mem/ (including config.example.json as reference)
7. Creates config.json with detected workspace
8. Runs npm install && npx tsc
9. Creates /usr/local/bin/nox-mem symlink
10. Installs systemd watcher service (replaces __NOX_MEM_PATH__ placeholder)
11. Runs initial reindex
12. Sets up 2 crons (23h consolidate, Sun 21h digest)
13. Runs doctor diagnostic
14. Prints success message with available commands

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x nox-supermem/install.sh
git add install.sh
git commit -m "feat: add one-command automated installer"
```

---

## Chunk 4: Templates + Agent Profiles + Documentation

### Task 17: Create base templates

**Files:**
- Create: `nox-supermem/templates/SOUL.md`
- Create: `nox-supermem/templates/MEMORY.md`
- Create: `nox-supermem/templates/TOOLS.md`
- Create: `nox-supermem/templates/HEARTBEAT.md`
- Create: `nox-supermem/templates/IDENTITY.md`
- Create: `nox-supermem/templates/SESSION-STATE.md`

- [ ] **Step 1: Create SOUL.md**

Sections:
- **Identidade**: Nome (placeholder), Papel, Tom (direto, pratico)
- **Principios**: 4 regras (consultar memoria antes de perguntar, registrar decisoes, nao repetir perguntas, usar nox-mem search)
- **Memoria**: Instrucoes de uso do `nox-mem primer` e `nox-mem search "palavra-chave"` com exemplos de comandos
- **Diario**: Como registrar notas em `memory/YYYY-MM-DD.md` e que a consolidacao 23h extrai fatos

- [ ] **Step 2: Create MEMORY.md**

Sections:
- **Ciclo de Memoria**: Diagrama ASCII do fluxo de 6 etapas: Sessao > Nota diaria > Consolidacao (23h cron) > Arquivos de topico > FTS5 search > Primer recovery
- **Arquivos de Memoria**: Tabela com 5 arquivos (decisions.md, lessons.md, people.md, projects.md, pending.md) e o que cada um contem
- **Como Funciona**: 5 comandos principais com descricao de 1 linha

- [ ] **Step 3: Create TOOLS.md**

Tabela com todos 10 comandos nox-mem (search, ingest, reindex, primer, stats, consolidate, retry-failed, digest, sync-notion, doctor). Secao separada para Notion (opcional). Tabela de crons (23h consolidacao, dom 21h digest).

- [ ] **Step 4: Create HEARTBEAT.md**

Tres secoes de checklist:
- **A cada sessao** (3 items): nox-mem primer, verificar pendencias, atualizar SESSION-STATE
- **Diario** (3 items): criar nota do dia, registrar decisoes, anotar licoes
- **Semanal** (3 items): nox-mem stats, verificar digest, limpar pendencias resolvidas

- [ ] **Step 5: Create IDENTITY.md**

Campos placeholder: Nome, Criador, Versao, Especialidade. Secao "Memoria" explicando que usa Supermem. Secao "Como me usar" com 4 passos.

- [ ] **Step 6: Create SESSION-STATE.md**

Schema WAL-style:
- **Tarefa Ativa**: campo unico com placeholder "_Nada em andamento no momento._"
- **Contexto Rapido**: ultima sessao (data), decisoes pendentes (ref pending.md), proximos passos
- **Historico Recente**: tabela Markdown com colunas Data | Tarefa | Status
- [ ] **Step 7: Commit**

```bash
git add templates/
git commit -m "feat: add 6 base agent templates"
```

---

### Task 18: Create agent profiles (Tier B)

**Files:**
- Create: `nox-supermem/perfis/assistente-pessoal/{SOUL.md,HEARTBEAT.md,README.md}`
- Create: `nox-supermem/perfis/pesquisador/{SOUL.md,HEARTBEAT.md,README.md}`
- Create: `nox-supermem/perfis/financeiro/{SOUL.md,HEARTBEAT.md,README.md}`

- [ ] **Step 1: Create assistente-pessoal profile**

SOUL.md: Nome "Assistente", papel "gerente de produtividade", tom "organizado, proativo". Foco: tarefas, agenda, emails, rotina. Usa `nox-mem primer` sempre e lembra preferencias/padroes/contatos.
HEARTBEAT.md: Manha (primer, pendencias, compromissos, priorizar 3 focos). Fim do dia (atualizar nota, mover nao-concluidas, briefing dia seguinte).
README.md: Para que serve, como usar (copiar arquivos + customizar), ideal para (freelancers, empreendedores solo).

- [ ] **Step 2: Create pesquisador profile**

SOUL.md: Nome "Pesquisador", papel "deep research", tom "analitico, metódico". Foco: pesquisa profunda, organizar descobertas, rastrear fontes, identificar padroes. Usa `nox-mem search "topico"` antes de pesquisar.
HEARTBEAT.md: Antes (search topico, revisar notas anteriores, definir perguntas). Apos (registrar descobertas, categorizar fatos, listar proximas perguntas).
README.md: Para pesquisa de mercado, analise de tecnologias, acumulo de conhecimento.

- [ ] **Step 3: Create financeiro profile**

SOUL.md: Nome "Analista Financeiro", tom "preciso, cauteloso, baseado em dados". Foco: analise financeira, KPIs, alertas de anomalias, relatorios periodicos. Usa primer para contexto e search para historico de metricas.
HEARTBEAT.md: Diario (primer, alertas, metricas). Semanal (KPIs, comparar semanas, relatorio). Mensal (consolidar metricas, tendencias 3 meses, decisoes pendentes).
README.md: Para controle financeiro, investimentos, KPIs de negocio.
- [ ] **Step 4: Commit**

```bash
git add perfis/
git commit -m "feat: add 3 agent profiles (assistente-pessoal, pesquisador, financeiro)"
```

---

### Task 19: Create README.md

**Files:**
- Create: `nox-supermem/README.md`

- [ ] **Step 1: Create README.md**

PT-BR README with:
- Headline from spec section 5: "O Upgrade de Memoria do seu Agente OpenClaw"
- Subheadline from spec: "Busca inteligente, consolidacao com IA local, e memoria que nunca se perde"
- 6 bullet-point features from spec section 5 (busca <1s, consolidacao IA, recovery, Notion sync, instala 30min, custo zero)
- Requirements (VPS 4GB+, Node 20+, OpenClaw)
- Quick install command (`bash install.sh`)
- Commands table (10 commands)
- Kit structure overview (tree diagram)
- Config example (config.json snippet)
- Support section (FAQ reference, chatbot for Tier C, email)
- Footer: "Criado por Toto Busnello | Licenca: uso pessoal"

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "feat: add product README in PT-BR"
```

---

### Task 20: Create LICENSE.md

**Files:**
- Create: `nox-supermem/LICENSE.md`

- [ ] **Step 1: Create LICENSE.md**

Personal use license (PT-BR):
- Up to 3 installations per buyer
- No redistribution, no derivative commercial products
- Code modification for personal use OK
- No warranty, support per tier
- 6 months of minor updates

- [ ] **Step 2: Commit**

```bash
git add LICENSE.md
git commit -m "feat: add personal use license"
```

---

### Task 21: Create FAQ.md

**Files:**
- Create: `nox-supermem/troubleshooting/FAQ.md`

- [ ] **Step 1: Create FAQ.md with 23 problems**

Organized by category:
- Installation (4 problems): Node.js, workspace, permissions, npm build
- Ollama (4 problems): offline, model missing, slow, invalid JSON
- Search (3 problems): FTS5 missing, no results, encoding
- Consolidation (3 problems): nothing to consolidate, failures, duplicates
- Watcher (3 problems): inotifywait missing, not working, high CPU
- Notion (3 problems): disabled, unauthorized, bad request
- Diagnostic (3 problems): doctor command, stats, reindex

Each with: cause, solution with exact commands.

- [ ] **Step 2: Commit**

```bash
git add troubleshooting/
git commit -m "feat: add FAQ with 23 common problems and solutions"
```

---

### Task 22: Create support files (Tier B + C)

**Files:**
- Create: `nox-supermem/video/ACESSO-VIDEO.md`
- Create: `nox-supermem/suporte/ACESSO-SUPORTE.md`
- Create: `nox-supermem/suporte/CHATBOT-INFO.md`

- [ ] **Step 1: Create video access file**

Link placeholder + video contents outline (5 sections from spec, 30-60min):
1. Criar VPS na Hostinger (ou similar)
2. Rodar install.sh
3. Testar busca, primer e consolidacao
4. Configurar crons e watcher
5. Ver resultado no Notion (opcional)
- [ ] **Step 2: Create support access file** -- Chatbot link, email, 7-day validity, renewal at R$30/week
- [ ] **Step 3: Create chatbot info file** -- Coverage list (what chatbot knows) + out-of-scope items
- [ ] **Step 4: Commit**

```bash
git add video/ suporte/
git commit -m "feat: add support files for Tier B and Tier C"
```

---

### Task 23: Create GUIA-INSTALACAO.md

**Files:**
- Create: `nox-supermem/GUIA-INSTALACAO.md`

The spec requires GUIA-INSTALACAO.pdf (Tier A). We create the Markdown source here; PDF conversion with screenshots is a manual post-implementation task.

- [ ] **Step 1: Create GUIA-INSTALACAO.md**

15-section installation guide in PT-BR:
1. Requisitos (VPS, Node.js, RAM, disco)
2. Acessar VPS via SSH
3. Verificar Node.js e npm
4. Baixar o kit (scp/git clone)
5. Executar install.sh
6. Verificar instalacao (nox-mem doctor)
7. Testar busca (nox-mem search)
8. Testar primer (nox-mem primer)
9. Testar consolidacao (nox-mem consolidate)
10. Configurar Notion (opcional)
11. Customizar templates
12. Verificar crons
13. Verificar watcher service
14. Proximos passos
15. Troubleshooting rapido (top 5 erros com solucao)

Each section: titulo, explicacao breve, comando(s) com copy-paste, output esperado.

- [ ] **Step 2: Commit**

```bash
git add GUIA-INSTALACAO.md
git commit -m "feat: add installation guide in Markdown (PDF conversion manual)"
```

---

### Task 24: Final build verification + push

- [ ] **Step 1: Verify all files exist per File Structure**

```bash
cd ~/Claude/Projetos/nox-supermem
find . -not -path './.git/*' -type f | sort
```

- [ ] **Step 2: Verify tier contents match spec Section 4**

Cross-reference checklist:
- Tier A: README.md, GUIA-INSTALACAO.md, install.sh, nox-mem/ (src + prompts + watch + service), templates/ (6 files), LICENSE.md
- Tier B (adds): video/ACESSO-VIDEO.md, perfis/ (3 profiles x 3 files = 9 files), troubleshooting/FAQ.md
- Tier C (adds): suporte/ACESSO-SUPORTE.md, suporte/CHATBOT-INFO.md

- [ ] **Step 3: Full TypeScript build**

```bash
cd nox-mem && npm install && npm run build
```
Expected: Clean compilation

- [ ] **Step 4: Push to GitHub**

```bash
cd ~/Claude/Projetos/nox-supermem
git push -u origin main
```

- [ ] **Step 5: Verify Forge access**

```bash
gh repo view totobusnello/nox-supermem
```

---

## Post-Implementation: Manual Tasks (Not Code)

| # | Task | Owner | When |
|---|------|-------|------|
| 1 | Record video walkthrough (30-60min) | Toto | After code stable |
| 2 | Create Hotmart product page (copy from spec section 5) | Toto | After video |
| 3 | Setup Typebot/Chatbase chatbot with product docs as RAG | Toto | Before launch |
| 4 | Configure Nox email support via gog | Toto | Before launch |
| 5 | Convert GUIA-INSTALACAO.md to PDF with screenshots | Toto | After install.sh tested |
| 6 | Create 3 Instagram Reels | Toto | Post-launch |
| 7 | Write 2 SEO blog posts | Toto | Post-launch |
| 8 | Design Supermem logo/icon | Toto | When needed |
