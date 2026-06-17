# Plano — Re-deploy de lineage do nox-mem na VPS

> **⛔ STATUS: DESCARTADO (2026-06-17).** A FASE 0 confirmou que o `nox-mem` 3.2.1 é SUBSET do lineage da VPS (109 vs 230 módulos) — migrar regrediria ~122 módulos. Os lineages são intencionalmente diferentes; não unificar. Decisão e detalhes em `INCIDENT-crystallize-fts5-2026-06-17.md` §6. Documento mantido como contexto da análise.

> Objetivo: fazer o deploy de produção (VPS `srv1465941`) convergir com o lineage canônico publicado (`github.com/totobusnello/nox-mem`, pacote npm `nox-mem`), eliminando o drift de lineage. **Não urgente** — o bug crítico (crystallize FTS5) já foi corrigido in-place na VPS (commit `3fb6aa40`). Isto é higiene de arquitetura.

## ⚠️ A nuance que mata a abordagem ingênua

NÃO é "instalar `nox-mem@3.2.1` e pronto". Os dois lineages **divergiram**:

- **VPS** roda `nox-workspace/tools/nox-mem` (git remote `nox-workspace.git`, HEAD `caddb574`, schema 18). Tem flags de features de pesquisa ativas: `NOX_BRIEF_DIVERSITY=shadow`, `NOX_TEMPORAL_PATH=shadow`, `NOX_MUTEX_QUERY_ENTITY_THRESHOLD=2`.
- **Canônico** `nox-mem` 3.2.1 é o **"core-kit trim"** (PR #21 — "trim to the core engine"). Foi **deliberadamente enxugado** pra publicação open-source.

→ **Hipótese a confirmar: o 3.2.1 é um SUBSET da VPS.** Re-deployar cego pode **regredir** features que o Toto usa (briefing/temporal/shadow/notion-sync/digest). Por isso a FASE 0 abaixo é obrigatória.

## Estado atual (coletado 2026-06-17)

| Item | Valor |
|---|---|
| Path deploy | `/root/.openclaw/workspace/tools/nox-mem` |
| Serviços | `nox-mem-api.service` (`node dist/api-server.js`, Mem 3.5G) · `nox-mem-watch.service` (`nox-mem-watch.sh`) |
| EnvironmentFile | `/root/.openclaw/.env` (GEMINI/GROQ/OPENAI/NOTION/… keys) |
| Env extra (api) | `NOX_BRIEF_DIVERSITY=shadow`, `NOX_TEMPORAL_PATH=shadow`, `NOX_MUTEX_QUERY_ENTITY_THRESHOLD=2` |
| DB | `nox-mem.db` ~1,5 GB, ~70k chunks, schema 18, integrity ok |
| Node | v22.22.2 / npm 10.9.7 |
| Working tree | 34 arquivos sujos — TODOS runtime do workspace (`agents/`,`memory/`,`shared/`), **0 código nox-mem** |
| Código nox-mem | sem mods locais (crystallize fix já commitado) |

## FASE 0 — Análise de divergência funcional (BLOQUEIA o cutover)

Antes de decidir a direção, responder: **o 3.2.1 cobre tudo que a VPS usa?**

1. Diff de superfície: `git diff --stat` entre VPS HEAD (`caddb574`) e `nox-mem@3.2.1` (clonar lado a lado, comparar `src/`).
2. Inventário de módulos só-na-VPS: arquivos/comandos/rotas de API presentes na VPS e ausentes no 3.2.1.
3. Checar os flags shadow: `NOX_BRIEF_DIVERSITY`, `NOX_TEMPORAL_PATH` — o 3.2.1 lê esses env vars? Se não, são no-op (perda silenciosa de comportamento).
4. Rotas da API consumidas pelo openclaw/secretary (briefing, digest, answer, etc) — todas existem no 3.2.1?

**Saída da FASE 0 → decide a direção:**
- **(a) 3.2.1 ⊇ VPS** (cobre tudo): cutover direto pro 3.2.1 (Fase 1-3 abaixo).
- **(b) 3.2.1 ⊂ VPS** (VPS tem mais): NÃO migrar a VPS pro core-kit. Em vez disso, portar os fixes do 3.2.1 que faltam pra VPS, OU promover as features extras da VPS pro repo canônico antes de convergir. Decisão do Toto.

## FASE 1 — Preparação (side-by-side, sem tocar produção)

1. Backup fresco do DB: `cp nox-mem.db /var/backups/nox-mem/pre-redeploy-$(date +%F-%H%M).db` + verificar md5.
2. Clonar canônico: `git clone https://github.com/totobusnello/nox-mem /root/.openclaw/workspace/tools/nox-mem-NEW` (checkout tag/commit do 3.2.1).
3. `cd .../nox-mem-NEW/nox-mem && npm ci && npm run build` (Node 22 ok; rebuild `better-sqlite3` se ABI reclamar).
4. Apontar o NEW pro MESMO DB (via config/env) **em modo leitura de teste** ou cópia do DB — nunca os dois serviços escrevendo no mesmo DB ao mesmo tempo.
5. Smoke test no NEW (serviço numa porta alternativa): subir api, `nox-mem doctor`, busca de sanidade, `crystallize` de teste + delete → confirmar que NÃO corrompe (valida o fix no novo lineage).

## FASE 2 — Cutover (janela curta, serviços parados)

> Regra de ouro (do incidente original): **parar `nox-mem-api` + `nox-mem-watch` antes** de qualquer swap — escrita concorrente no DB durante o swap corrompe.

1. `systemctl stop nox-mem-api nox-mem-watch`
2. Backup do DB de novo (estado final pré-cut).
3. Swap: renomear `tools/nox-mem` → `tools/nox-mem-OLD`, `tools/nox-mem-NEW` → `tools/nox-mem` (ou usar symlink `tools/nox-mem -> nox-mem-3.2.1` pra rollback instantâneo).
4. Garantir DB, `.env` e os 3 env vars shadow no lugar (replicar no service se ainda usados; remover se a FASE 0 disser que viraram no-op).
5. `systemctl start nox-mem-api nox-mem-watch`

## FASE 3 — Verificação

- `systemctl is-active` ambos = active; `journalctl -u nox-mem-api -n 50` sem erros.
- `sqlite3 nox-mem.db "PRAGMA integrity_check"` = ok; contagem de chunks preservada.
- Busca real retorna resultados; KG responde; briefing/digest (se usados) funcionam.
- Versão: `nox-mem --version` = 3.2.1.

## Rollback

Symlink-based: `systemctl stop ...; ln -sfn nox-mem-OLD tools/nox-mem; systemctl start ...`. DB intacto (mesmo schema 18). < 1 min.

## Riscos

| Risco | Mitigação |
|---|---|
| 3.2.1 regride features (core-kit subset) | FASE 0 obrigatória antes do cutover |
| Corrupção por escrita concorrente | serviços parados durante swap |
| Perda de DB | 2 backups (pré-prep + pré-cut) |
| Flags shadow viram no-op | FASE 0 item 3 |
| ABI better-sqlite3 (Node) | `npm rebuild better-sqlite3` |
| MCP wiring quebra | mapear como o openclaw spawna o MCP antes do cut |

## Pendência paralela

O MCP `nox-mem` da máquina local do Toto (`/opt/homebrew`, era 3.1.1) também deve ir pra 3.2.1: `npm i -g nox-mem@3.2.1`.
