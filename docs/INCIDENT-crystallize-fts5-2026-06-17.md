# Postmortem — crystallize corrompe FTS5 external-content (SQLITE_CORRUPT_VTAB)

- **Data:** 2026-06-17
- **Severidade:** P0 (corrompe o índice de busca; toda busca FTS quebra após o gatilho)
- **Status:** ✅ Resolvido — corrigido em produção (VPS) e no pacote público (npm 3.2.1)
- **Componente:** `nox-mem` · `src/crystallize.ts`

---

## TL;DR

`crystallize()` re-indexava manualmente no FTS5 um chunk que o trigger `chunks_ai` **já havia indexado**, criando duas postings divergentes pro mesmo rowid numa tabela **external-content**. Isso quebra a invariante 1:1 do índice e dispara `SQLITE_CORRUPT_VTAB` no primeiro `DELETE`/`UPDATE` subsequente. Fix: **remover o INSERT manual** (o trigger já indexa). Corrigido na VPS (commit `3fb6aa40`) e publicado em `nox-mem@3.2.1`.

---

## 1. O bug

### Sintoma
Após rodar `crystallize`, qualquer `DELETE`/`UPDATE` em `chunks` dispara:
```
SQLITE_CORRUPT_VTAB: database disk image is malformed
```
e toda busca FTS passa a falhar.

### Causa-raiz
`chunks_fts` é uma tabela FTS5 **external-content**:
```sql
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  chunk_text, source_file, chunk_type, fts_anchor,
  content=chunks, content_rowid=id,
  tokenize='unicode61 remove_diacritics 2'
);
```
A sincronização índice↔tabela é feita por triggers. O `chunks_ai` (AFTER INSERT) já indexa o chunk completo:
```sql
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, chunk_text, source_file, chunk_type, fts_anchor)
  VALUES (new.id, new.chunk_text, new.source_file, new.chunk_type, new.fts_anchor);
END;
```
O `crystallize` fazia, **depois** do `INSERT INTO chunks` (que já disparou o trigger), uma segunda indexação manual — e incompleta (só `chunk_text`):
```ts
// crystallize.ts:67 (3.2.0) / dist/crystallize.js:40
db.prepare("INSERT INTO chunks_fts (rowid, chunk_text) VALUES (?, ?)").run(id, chunkText);
```
Resultado: duas postings divergentes pro mesmo rowid → invariante 1:1 do external-content quebrada → o primeiro `'delete'` do trigger não casa os postings → `SQLITE_CORRUPT_VTAB`.

> ⚠️ Correção de uma imprecisão comum: o INSERT manual com `rowid+colunas` **não** é proibido em external-content — é exatamente o que os triggers fazem. O problema era a **dupla indexação**, não a forma do INSERT. Por isso o fix correto é **remover a linha**, não trocá-la por `INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')` (que funciona como workaround, mas reindexa a tabela inteira a cada crystallize — caro e desnecessário).

### Fix
Remover o bloco `try { INSERT manual } catch {}`. O trigger `chunks_ai` já indexa. Edit mínimo, sem mexer na estrutura.

---

## 2. Alcance

Presente em todo o lineage 3.x: detectado no relatório como 3.0.0, confirmado em **3.0.0 (VPS)**, **3.1.1 (MCP local)** e **3.2.0 (npm latest)** — todas idênticas na linha do bug.

Atenuante de sorte na VPS: havia **0 chunks `type=procedure`** (crystallize nunca rodou com sucesso), então o DB de produção estava íntegro (`integrity_check = ok`, 70.695 chunks == 70.695 fts) — era uma **bomba não-detonada**, prestes a corromper no primeiro `crystallize` via MCP.

---

## 3. Timeline da investigação (e um erro de mapa)

1. Diagnóstico estático do bug a partir do código instalado (`nox-mem@3.1.1`).
2. **Erro de mapa:** conclusão inicial de que `nox-supermem` era um fork 2.1.2 "imune sem crystallize". Causa: o **clone local estava morto/divergente** (`bced35a`, 17 commits atrás / 18 à frente do origin). O repo real (origin/main) estava em 3.2.0 **com** o bug.
3. Correção via `git fetch`: o repo `nox-supermem` (origin/main) **é** o `nox-mem` 3.x publicado no npm (release #22). O clone local é que estava obsoleto.
4. Rastreamento do source de publish: clones temporários em `/private/tmp` (nox-pub/clean/fix) → todos clones do repo `nox-supermem`, subdir `nox-mem/`.

**Lição (memória `verify-git-fetch-before-trusting-local`):** nunca afirmar versão/feature/"está corrigido?" de um repo sem `git fetch` + comparar com origin. Working tree local pode estar congelado.

---

## 4. Topologia dos lineages `nox-mem` (descoberta-chave)

Existem cópias distintas com o mesmo nome de pacote:

| Onde | Versão | Papel | crystallize |
|---|---|---|---|
| **npm `nox-mem`** | 3.2.1 | pacote público (core-kit) | corrigido |
| **Repo `github.com/totobusnello/nox-mem`** (ex-`nox-supermem`), subdir `nox-mem/` | 3.2.1 | source canônico do npm | corrigido |
| **VPS** `srv1465941:/root/.openclaw/workspace/tools/nox-mem` (remote `nox-workspace.git`) | HEAD `014b536a`, schema 18 | engine **completo privado** (produção) | corrigido (`3fb6aa40`) |
| **`~/Claude/Projetos/memoria-nox`** | — | monorepo de pesquisa/paper (não é source de produção) | n/a |

Acesso à VPS: `root@187.77.234.79` (porta 22 pública) **ou** Tailscale `root@100.87.8.44` (host `srv1465941`, tailnet `tail4caa5b.ts.net`) — usar a rota Tailscale quando a rede local bloquear a 22.

---

## 5. Ações executadas

### VPS (produção)
1. Backup do DB 1,5 GB → `/var/backups/nox-mem/nox-mem.db.2026-06-17-102350` (md5 conferido).
2. Patch `src/crystallize.ts` (remoção do INSERT manual) → `npm run build` → dist limpo.
3. `systemctl restart nox-mem-api nox-mem-watch` (ambos active).
4. `integrity_check = ok`; chunks 70.695 == fts 70.695.
5. Commit `3fb6aa40` no repo `nox-workspace`.

### Pacote público (npm)
1. Reset do clone local podre → `origin/main` (3.2.0); linha morta preservada em branch `backup-local-pre-reset`.
2. Branch `fix/crystallize-fts-corruption`, mesmo patch, build limpo, **testes 586 pass / 0 fail** (após `npm rebuild better-sqlite3` por mismatch de ABI do Node), bump **3.2.1**.
3. Commit `0b7924e` → PR **#24** → squash merge `2afd0f8`.
4. `npm publish` → `nox-mem@3.2.1` (latest). Tarball verificado sem o bug.

### Naming (decisão: alinhar tudo em `nox-mem`)
1. Repo renomeado `totobusnello/nox-supermem` → **`nox-mem`** (GitHub redireciona URLs antigas).
2. `package.json` `repository`/`homepage`/`bugs` atualizados → commit `0158bf2`.
3. Remote local atualizado; branch de fix deletada.

### MCP local
`npm i -g nox-mem@3.2.1` (era 3.1.1) — sem o bug. Requer reiniciar a sessão/MCP pra ativar.

---

## 6. Re-deploy de lineage da VPS — avaliado e **DESCARTADO**

Hipótese inicial: migrar a VPS (3.0.0/lineage `nox-workspace`) pro `nox-mem` 3.2.1 pra "alinhar".

**FASE 0 (análise de divergência) — veredito:** o 3.2.1 é **SUBSET** do lineage da VPS.

| Lineage | módulos src |
|---|---|
| `nox-mem` 3.2.1 (core-kit público) | 109 |
| VPS `nox-workspace` (real, HEAD `014b536a`) | **230** |
| **na VPS, ausentes no 3.2.1** | **122** |

Migrar regrediria ~122 módulos: `privacy-br/` (LGPD/PII), `archive/` (backup criptografado), `confidence/`, `conflict/`, `hooks/`, `observability/` + `viewer/`, `ocr/`, `notion-sync`, `evals`, `plugins/nox-hooks`, vários comandos CLI e MCP tools.

**Decisão:** os dois lineages são **intencionalmente diferentes** — `nox-mem` é o core-kit público enxuto (#21 "trim to the core engine"); `nox-workspace` é o engine completo privado da VPS. **Não unificar.** O correto é **sincronizar fixes** entre os dois (como foi feito com este bug, corrigido em ambos), não migrar.

O schema é o mesmo (v18) nos dois, e os flags `NOX_BRIEF_DIVERSITY`/`NOX_TEMPORAL_PATH` existem em ambos.

---

## 7. Verificações

- VPS: `integrity_check = ok`, contagens preservadas, serviços active, bug ausente (0 ocorrências).
- npm: `nox-mem@3.2.1` é latest; tarball publicado sem o INSERT manual.
- Source: `tsc --noEmit` 0 erros; `npm test` 586/0.
- Os 31 erros TS reportados existiam só no deploy VPS 3.0.0 — no source canônico 3.2.x já estavam zerados (#21).

---

## 8. Lições

1. **`git fetch` antes de concluir** sobre versão/feature/estado de um repo — clone local pode estar podre. (memória dedicada)
2. **External-content FTS5:** nunca escrever no índice manualmente quando há triggers de sync — deixa o trigger ser a única fonte. Dupla escrita = corrupção latente.
3. **Bomba não-detonada ≠ seguro:** DB íntegro só porque o caminho bugado nunca rodou. Tratar como P0.
4. **Operações de schema/rebuild em produção:** parar `nox-mem-api` + `nox-mem-watch` antes (escrita concorrente durante rebuild também corrompe).
5. **Tailscale como rota de contorno** quando a porta 22 pública é bloqueada pela rede local.

---

## 9. Estado final

Nada pendente. Bug morto em produção e no pacote público; naming alinhado; lineages documentados; decisão de não-migração registrada.

### Referências
- Repo: https://github.com/totobusnello/nox-mem · PR #24 · npm `nox-mem@3.2.1`
- Memórias: `nox-mem-lineage`, `verify-git-fetch-before-trusting-local`
- Plano de re-deploy (descartado, contexto): `docs/REDEPLOY-VPS-LINEAGE-PLAN.md`
