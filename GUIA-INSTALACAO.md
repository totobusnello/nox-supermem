# Guia de Instalação — NOX-Supermem
### Motor de memória híbrida para agentes de IA — instalação standalone

---

## O que é o nox-mem

O nox-mem é um motor de memória para agentes AI: ele indexa arquivos Markdown, constrói um grafo de conhecimento e expõe busca híbrida (FTS5 + embeddings semânticos + RRF). Roda como processo Node.js em qualquer VPS Linux. **Não depende do OpenClaw** — pode ser usado com qualquer agente.

**Não existe pacote publicado no npm.** A instalação é via tarball ou clone do repositório.

---

## Pré-requisitos

| Requisito | Mínimo | Notas |
|---|---|---|
| SO | Ubuntu 22.04 LTS | Debian 11+ e CentOS 8+ também funcionam |
| RAM | 2 GB | 4 GB+ recomendado para KG extraction |
| Disco | 10 GB | Cresce com o volume de memória |
| Node.js | 20+ | Ver instruções abaixo |
| build-essential | qualquer | Requerido pelo `better-sqlite3` (addon nativo) |
| python3 | 3.8+ | Requerido por `@xenova/transformers` |

---

## Seção 1 — Preparar o servidor

```bash
# Atualizar pacotes
apt-get update && apt-get upgrade -y

# Instalar dependências de build
apt-get install -y build-essential python3 python3-pip inotify-tools
```

---

## Seção 2 — Instalar Node.js 20+

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Verificar
node --version   # v20.x.x ou superior
npm --version
```

---

## Seção 3 — Obter o nox-mem

### Opção A — Tarball (distribuição)

```bash
# Descompactar o tarball recebido
tar -xzf nox-supermem-*.tar.gz
cd nox-supermem-*/
```

### Opção B — Clone do repositório (build manual)

```bash
git clone https://github.com/totobusnello/nox-supermem.git
cd nox-supermem/
```

---

## Seção 4 — Instalar (1 comando)

```bash
bash install.sh
```

**O que acontece:**
1. Verifica Node.js >= 20 e dependências de sistema
2. Executa `npm ci` + `tsc` dentro de `nox-mem/`
3. Instala globalmente com `npm install -g .` (o comando `nox-mem` fica disponível)
4. Cria `.env` a partir do `.env.example` (você precisa preencher)
5. Instala watcher systemd (opcional, se systemd disponível)
6. Configura crons: consolidate às 23h e vectorize a cada 4h (opcionais)

**Preview sem instalar nada:**
```bash
bash install.sh --dry-run
```

---

## Seção 5 — Configurar variáveis de ambiente

O instalador cria `nox-mem/.env`. Edite-o e preencha no mínimo:

```bash
nano nox-mem/.env
```

Variáveis obrigatórias:

```bash
GEMINI_API_KEY=AIz...      # https://aistudio.google.com/apikey
NOX_DB_PATH=/root/nox-mem.db
NOX_MEM_DIR=/root/memory    # diretório com seus arquivos .md
NOX_API_TOKEN=              # gerar: openssl rand -hex 32
```

Depois de preencher, source o arquivo:

```bash
set -a; source nox-mem/.env; set +a
```

> **Nota sobre a chave Gemini:** o saldo prepaid é por projeto GCP, não por chave. Se você receber erro 429 com uma chave nova, o projeto pode estar sem saldo.

---

## Seção 6 — Verificar a instalação

```bash
# Verificar que o comando existe
nox-mem --help

# Indexar arquivos existentes no NOX_MEM_DIR
nox-mem reindex

# Iniciar a API
nox-mem serve &

# Health check — vectorCoverage deve ser >= 0.99
curl -s http://127.0.0.1:18802/api/health | jq .vectorCoverage
```

Se `vectorCoverage` estiver abaixo de 0.99, rode:

```bash
nox-mem vectorize
```

---

## Seção 7 — Multi-provider (alternativa ao Gemini)

Por padrão o nox-mem usa Gemini via AI Studio. Para usar outro provider (DeepSeek, OpenRouter, Ollama local, etc.), adicione ao `.env`:

```bash
# LLM (raciocínio e consolidação)
NOX_LLM_PROVIDER=openai-compat
NOX_LLM_BASE_URL=https://openrouter.ai/api/v1
NOX_LLM_MODEL=deepseek/deepseek-chat
NOX_LLM_API_KEY=sk-...

# Embeddings
NOX_EMBED_PROVIDER=openai-compat
NOX_EMBED_BASE_URL=https://openrouter.ai/api/v1
NOX_EMBED_MODEL=text-embedding-3-small
NOX_EMBED_API_KEY=sk-...
```

A troca é feita em runtime — não precisa recompilar.

---

## Seção 8 — Usar o motor

### Busca

```bash
nox-mem search "decisão de arquitetura"
nox-mem search "erro prod" --limit 10
```

### Ingerir arquivos

```bash
# Markdown convencional
nox-mem ingest /root/memory/2026-06-15.md

# Entity file (formato frontmatter + compiled + timeline)
nox-mem ingest-entity /root/memory/entities/person/toto.md
```

### Estatísticas

```bash
nox-mem stats
# Mostra: chunks, vetores, entidades KG, cobertura
```

### Grafo de conhecimento

```bash
nox-mem kg-build          # extrai entidades e relações com Gemini
nox-mem kg-search "nome"  # busca no grafo
```

### API HTTP (porta 18802)

```bash
# Busca via API
curl -H "Authorization: Bearer $NOX_API_TOKEN" \
     "http://127.0.0.1:18802/api/search?q=query"

# Health
curl http://127.0.0.1:18802/api/health | jq .
```

---

## Seção 9 — Backups e operações destrutivas

O nox-mem cria snapshots automáticos antes de qualquer operação destrutiva (`reindex`, `consolidate`, `compact`, `crystallize`, `kg-prune`). Os snapshots ficam em `$NOX_PRE_OP_SNAPSHOT_DIR` (padrão: `/var/backups/nox-mem/pre-op/`), retenção 7 dias.

**NÃO restaure com `cp snapshot.db nox-mem.db`** — isso corrompe o WAL. Use o flag `--restore` ou a função `safeRestore()` interna.

Para testar qualquer operação destrutiva sem mutar dados:

```bash
nox-mem reindex --dry-run
nox-mem kg-prune --dry-run
```

---

## Seção 10 — Crons automáticos

O instalador sugere dois crons:

```
0 23 * * *   nox-mem consolidate >> /var/log/nox-mem/nox-mem.log 2>&1
0 */4 * * *  nox-mem vectorize   >> /var/log/nox-mem/nox-mem.log 2>&1
```

Verificar:

```bash
crontab -l | grep -A5 NOX-SUPERMEM

tail -f /var/log/nox-mem/nox-mem.log
```

---

## Seção 11 — Watcher de arquivos (tempo real)

Se o systemd instalou o watcher:

```bash
systemctl status nox-mem-watcher
```

O watcher detecta qualquer `.md` salvo em `$NOX_MEM_DIR` e ingere automaticamente em ~3 segundos.

Logs do watcher:

```bash
tail -f /tmp/nox-mem-watcher.log
```

---

## Seção 12 — Troubleshooting

**`nox-mem: command not found` após instalação**

```bash
# Verificar onde npm instala globalmente
npm prefix -g
# Adicionar ao PATH se necessário
export PATH="$(npm prefix -g)/bin:$PATH"
```

**`vectorize` retorna "0 embedded, N errors"**

```bash
# O env não foi carregado. Verificar:
echo $GEMINI_API_KEY
# Recarregar:
set -a; source nox-mem/.env; set +a
nox-mem vectorize
```

**`sqlite-vec` não encontrado / `vec0` não carrega**

O `sqlite-vec` usa binários nativos por plataforma. Após `npm ci`, verifique:

```bash
ls node_modules/sqlite-vec-linux-x64/  # deve existir um .node ou .so
```

Se estiver faltando, reinstale com:

```bash
cd nox-mem && npm ci --include=optional
```

**API não responde**

```bash
# Verificar se está rodando
ps aux | grep "nox-mem serve"

# Verificar a porta
ss -tlnp | grep 18802

# Iniciar manualmente
set -a; source nox-mem/.env; set +a
nox-mem serve
```

---

*NOX-Supermem | MIT License | github.com/totobusnello/nox-supermem*
