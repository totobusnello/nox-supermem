# NOX-Supermem — Implementation Plan (v2)

> Plano revisado por Forge em 2026-03-15. Inclui melhorias de segurança, testes e empacotamento.

**Goal:** Package nox-mem into a sellable digital product (NOX-Supermem) for the Brazilian OpenClaw market on Hotmart.
**Source spec:** `2026-03-14-nox-supermem-produto-design.md` and `2026-03-14-nox-supermem-produto.md`
**Target repo:** `totobusnello/nox-supermem` (private)
**Local path (Mac):** `/Users/lab/Claude/Projetos/nox-supermem/`

---

## Current State (after initial Forge commit)

- ✅ Folder structure created
- ✅ Source code copied from VPS with credentials sanitized
- ✅ Prompts copied (PT-BR, production-ready)
- ✅ `.gitignore` configured
- ✅ `config.example.json` with all configurable options
- ✅ GitHub Actions CI (build + credential check)
- ⬜ `config.ts` — needs implementation (PRIORITY 1)
- ⬜ All `src/*.ts` — needs genericization (replace WORKSPACE env var with `getConfig()`)
- ⬜ `install.sh` — needs creation
- ⬜ Templates, profiles, docs — needs creation

---

## Phase 0 — DONE (Forge)

- [x] Verify source code on VPS
- [x] Clone repo locally on VPS
- [x] Create folder structure
- [x] Copy + sanitize source code
- [x] Add CI, .gitignore, config.example.json
- [x] Push initial commit

---

## Phase 1 — Config System + Core Genericization

### Task 1: Create config.ts

**File:** `nox-mem/src/config.ts`

Create `SupermemConfig` interface and `getConfig()` singleton:

```typescript
interface SupermemConfig {
  workspace: string;       // OPENCLAW_WORKSPACE or detected
  promptsDir: string;      // auto-derived: resolve(__dirname, "..", "prompts")
  dbPath: string;          // auto-derived: {workspace}/tools/nox-mem/nox-mem.db
  ollama: {
    url: string;           // default: "http://localhost:11434"
    model: string;         // default: "llama3.2:3b"
  };
  notion: {
    enabled: boolean;      // default: false
    token: string;
    databaseId: string;
    apiVersion: string;    // default: "2025-09-03"
  };
  consolidation: {
    maxFilesPerRun: number; // default: 5
    timeoutMs: number;      // default: 120000
    retries: number;        // default: 3
  };
  watcher: {
    debounceMs: number;     // default: 3000
    excludeFiles: string[]; // default: ["MEMORY.md", "SESSION-STATE.md"]
  };
}
```

Detection chain for `workspace`:
1. `config.json` at project root (resolve from `__dirname`)
2. `$OPENCLAW_WORKSPACE` env var
3. `openclaw config get workspace` shell command (try/catch)
4. `~/.openclaw/workspace` fallback

- [ ] Create `nox-mem/src/config.ts`
- [ ] Verify: `cd nox-mem && npx tsc --noEmit src/config.ts`
- [ ] Commit: `feat: add config system`

---

### Task 2: Genericize db.ts

Replace `WORKSPACE` env var line with `getConfig()`:
```typescript
import { getConfig } from "./config.js";
// Remove: const WORKSPACE = process.env...
// Use: getConfig().dbPath
```

- [ ] Update `nox-mem/src/db.ts`
- [ ] Verify typecheck
- [ ] Commit: `feat: genericize db.ts`

---

### Task 3: Genericize ingest.ts

Same pattern — replace `WORKSPACE` constant with `getConfig().workspace`.

- [ ] Update `nox-mem/src/ingest.ts`
- [ ] Commit: `feat: genericize ingest.ts`

---

### Task 4: Genericize primer.ts + reindex.ts

Same pattern.

- [ ] Update `nox-mem/src/primer.ts`
- [ ] Update `nox-mem/src/reindex.ts`
- [ ] Commit: `feat: genericize primer and reindex`

---

### Task 5: Extract appendInSection utility

Extract from `consolidate.ts` into standalone module:

- [ ] Create `nox-mem/src/appendInSection.ts`
  - `ensureFile(path, header)`: creates file with header if it doesn't exist
  - `appendInSection(path, section, content)`: inserts inside correct markdown section
- [ ] Commit: `feat: extract appendInSection utility`

---

### Task 6: Genericize consolidate.ts

Largest change:
- Import `getConfig()` and `appendInSection` from new modules
- Replace `WORKSPACE`, `OLLAMA_URL`, `MODEL`, `MAX_FILES_PER_RUN` with config values
- Replace `PROMPT_PATH` with `resolve(getConfig().promptsDir, "consolidate.txt")`
- Fix pending category: `"Insight"` → `"Pendencia"`

- [ ] Update `nox-mem/src/consolidate.ts`
- [ ] Commit: `feat: genericize consolidate.ts`

---

### Task 7: Genericize digest.ts + notion-sync.ts + doctor.ts

- `digest.ts`: replace WORKSPACE/OLLAMA_URL/MODEL with config
- `notion-sync.ts`: replace env vars with `getConfig().notion.*`, skip if `!config.notion.enabled`
- `doctor.ts`: use `getConfig()` for all checks; report "Notion: desabilitado" if not enabled

- [ ] Update all three files
- [ ] Commit: `feat: genericize digest, notion-sync, doctor`

---

### Task 8: Full build verification

- [ ] `cd nox-mem && npm install && npm run build`
- [ ] Zero TypeScript errors
- [ ] Commit: `feat: phase 1 complete — all modules genericized`

---

## Phase 2 — Installer + CI + Testes

### Task 9: Create install.sh

One-command installer with safety features:
- Colored output with progress
- `--dry-run` flag (shows what it would do, no execution)
- Error checkpoints: `|| { echo "❌ ERRO na etapa X: $?"; exit 1; }`
- Log em `/tmp/nox-supermem-install.log`

Steps:
1. Detect workspace
2. Check Node.js 20+
3. Install inotify-tools
4. Install + pull Ollama model
5. Copy nox-mem/ to workspace
6. Create config.json from template
7. `npm install && npm run build`
8. Create `/usr/local/bin/nox-mem` symlink
9. Install systemd watcher service
10. Run initial reindex
11. Setup 2 crons (23h consolidate, Sun 21h digest)
12. Run `nox-mem doctor`

- [ ] Create `install.sh`
- [ ] Make executable: `chmod +x install.sh`
- [ ] Test with `--dry-run`
- [ ] Commit: `feat: add one-command installer with dry-run`

---

### Task 10: Create systemd service template

- [ ] Create `nox-mem/nox-mem-watcher.service` with `__NOX_MEM_PATH__` placeholder
- [ ] Commit: `feat: add systemd service template`

---

### Task 11: Create smoke test script

- [ ] Create `scripts/test.sh`:
  ```bash
  #!/bin/bash
  nox-mem doctor
  nox-mem stats
  echo "teste de busca" | nox-mem ingest /dev/stdin
  nox-mem search "teste"
  echo "✅ Smoke test passed"
  ```
- [ ] Make executable
- [ ] Commit: `feat: add smoke test script`

---

### Task 12: Create tier packaging scripts

- [ ] Create `scripts/build-tiers.sh`:
  - `build-tier-a.sh` → ZIP com nox-mem/ + templates/ + README + GUIA + LICENSE
  - `build-tier-b.sh` → Tier A + video/ + perfis/ + troubleshooting/
  - `build-tier-c.sh` → Tier B + suporte/
- [ ] Commit: `feat: add tier packaging scripts`

---

## Phase 3 — Content (Templates + Profiles + Docs)

### Task 13: Create base templates (6 files)

- [ ] `templates/SOUL.md` — personalidade genérica (placeholder customizável)
- [ ] `templates/MEMORY.md` — índice + ciclo de 6 etapas (diagrama ASCII)
- [ ] `templates/TOOLS.md` — tabela dos 10 comandos nox-mem + crons
- [ ] `templates/HEARTBEAT.md` — checklist por sessão/dia/semana
- [ ] `templates/IDENTITY.md` — campos placeholder
- [ ] `templates/SESSION-STATE.md` — schema WAL-style
- [ ] Commit: `feat: add 6 base agent templates`

---

### Task 14: Create agent profiles (Tier B)

- [ ] `perfis/assistente-pessoal/` (SOUL.md, HEARTBEAT.md, README.md)
- [ ] `perfis/pesquisador/` (SOUL.md, HEARTBEAT.md, README.md)
- [ ] `perfis/financeiro/` (SOUL.md, HEARTBEAT.md, README.md)
- [ ] Commit: `feat: add 3 agent profiles`

---

### Task 15: Create documentation

- [ ] `README.md` — product README PT-BR (headline, features, install, commands)
- [ ] `LICENSE.md` — uso pessoal, até 3 instalações
- [ ] `GUIA-INSTALACAO.md` — guia 15 seções com copy-paste (→ PDF manual)
- [ ] `troubleshooting/FAQ.md` — 23 problemas comuns
- [ ] Commit: `feat: add documentation`

---

### Task 16: Create support access files (Tier B + C)

- [ ] `video/ACESSO-VIDEO.md` — link placeholder + outline do vídeo
- [ ] `suporte/ACESSO-SUPORTE.md` — link chatbot, email, validade 7 dias
- [ ] `suporte/CHATBOT-INFO.md` — o que o chatbot sabe responder
- [ ] Commit: `feat: add support files for Tier B and C`

---

## Phase 4 — Final Verification + Launch Prep

### Task 17: Final build + structure verification

- [ ] Verify all files per spec Section 4 (Tier A, B, C contents)
- [ ] Full TypeScript build: `cd nox-mem && npm run build`
- [ ] Run smoke test: `bash scripts/test.sh`
- [ ] Run credential scan (CI does this automatically on push)
- [ ] Push to GitHub: `git push origin main`
- [ ] Forge reviews on GitHub

---

## Post-Implementation: Manual Tasks (Not Code)

| # | Task | Owner | When |
|---|------|-------|------|
| 1 | Gravar vídeo walkthrough (30-60min) | Toto | Após código estável |
| 2 | Criar página Hotmart (copy do spec seção 5) | Toto | Após vídeo |
| 3 | Setup chatbot Typebot/Chatbase | Toto | Antes do lançamento |
| 4 | Configurar email suporte no Nox | Toto | Antes do lançamento |
| 5 | Converter GUIA-INSTALACAO.md em PDF com screenshots | Toto | Após install.sh testado |
| 6 | Criar 3 Reels Instagram | Toto | Pós-lançamento |
| 7 | Escrever 2 blog posts SEO | Toto | Pós-lançamento |
| 8 | Design logo/ícone Supermem | Toto | Quando necessário |

---

## Workflow Claude Code → Forge

1. Claude Code trabalha em `/Users/lab/Claude/Projetos/nox-supermem/`
2. Abre PR por task ou por fase
3. Forge revisa via `gh pr review` na VPS
4. Merge no main → CI valida build + credentials

**Branch naming:** `feat/task-N-descricao` (ex: `feat/task-1-config-system`)
