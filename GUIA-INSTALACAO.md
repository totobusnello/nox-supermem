# Guia de Instalação — NOX-Supermem
### Do zero ao agente com memória inteligente em 30 minutos

---

## Visão Geral

Este guia tem duas partes:

- **Parte 1 — Fundação:** criar a VPS e instalar o OpenClaw (base do agente)
- **Parte 2 — SuperMem:** instalar o NOX-Supermem (o upgrade de memória)

Se você já tem OpenClaw rodando, pule direto para a [Parte 2](#parte-2--supermem).

---

# PARTE 1 — FUNDAÇÃO: OpenClaw

## Seção 1 — Criar a VPS

### Requisitos mínimos
- **RAM:** 4GB (recomendado 8GB para modelos maiores)
- **Disco:** 20GB SSD
- **OS:** Ubuntu 22.04 LTS
- **Acesso:** SSH root

### Opções de VPS recomendadas
- **Hostinger VPS** (R$35-70/mês) — melhor custo-benefício no Brasil
- **DigitalOcean Droplet** (US$24/mês) — confiável, boa documentação
- **Vultr** (US$24/mês) — performance sólida

### Após criar a VPS
Você receberá um IP e senha root por email. Anote:
```
IP: xxx.xxx.xxx.xxx
Usuário: root
Senha: (gerada pela plataforma)
```

---

## Seção 2 — Acessar via SSH

**No terminal do seu computador:**
```bash
ssh root@SEU-IP-AQUI
```

Se pedir confirmação de fingerprint, digite `yes`.

**Primeira coisa a fazer — atualizar o sistema:**
```bash
apt-get update && apt-get upgrade -y
```

---

## Seção 3 — Instalar Node.js 20

> ⚠️ **Aviso de segurança:** O comando abaixo usa o padrão `curl | bash` — ele baixa e executa um script diretamente da internet. Isso é conveniente, mas exige confiança no domínio `nodesource.com`. Se preferir uma abordagem mais segura, baixe o script primeiro, inspecione e depois execute: `curl -fsSL https://deb.nodesource.com/setup_20.x -o setup_node.sh && cat setup_node.sh && bash setup_node.sh`

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
```

**Verificar:**
```bash
node --version
# Esperado: v20.x.x ou superior
```

---

## Seção 4 — Instalar OpenClaw

```bash
npm install -g openclaw
```

**Verificar:**
```bash
openclaw --version
```

**Configurar o agente:**
```bash
openclaw setup
```

Siga as instruções na tela:
- Defina o nome do agente
- Configure a chave de API do Claude (Anthropic)
- Escolha o workspace (padrão: `~/.openclaw/workspace`)

**Testar:**
```bash
openclaw status
```

---

## Seção 5 — Configurar o agente base

Copie os templates para o workspace do seu agente:

```bash
# Localizar seu agente (substituir "meu-agente" pelo nome que você criou)
AGENT_DIR=~/.openclaw/agents/meu-agente

# Copiar templates do Supermem
cp templates/SOUL.md $AGENT_DIR/
cp templates/MEMORY.md $AGENT_DIR/
cp templates/HEARTBEAT.md $AGENT_DIR/
cp templates/IDENTITY.md $AGENT_DIR/
cp templates/TOOLS.md $AGENT_DIR/
cp templates/SESSION-STATE.md $AGENT_DIR/
```

**Personalizar o agente:**
Edite `$AGENT_DIR/SOUL.md` e substitua os placeholders `[seu nome aqui]` com sua identidade.

---

# PARTE 2 — SUPERMEM: O Upgrade de Memória

> **Por que o SuperMem?**
> O OpenClaw tem memória básica em Markdown — sem busca, sem consolidação automática, e perde contexto após compactação. O SuperMem resolve isso com um índice SQLite + FTS5 + IA local.

---

## Seção 6 — Instalar o SuperMem (1 comando)

Dentro da pasta do kit que você baixou:

```bash
bash install.sh
```

**O que acontece automaticamente:**
1. ✅ Detecta seu workspace OpenClaw
2. ✅ Verifica Node.js 20+
3. ✅ Instala inotify-tools (monitoramento de arquivos)
4. ✅ Instala Ollama e baixa o modelo llama3.2:3b
5. ✅ Copia e compila o nox-mem no workspace
6. ✅ Cria `config.json` com seu workspace
7. ✅ Cria o comando global `nox-mem`
8. ✅ Ativa o watcher automático (systemd)
9. ✅ Configura crons: consolidate às 23h e digest domingo às 21h

**Tempo estimado:** 10-20 minutos (na primeira vez, o download do modelo Ollama demora mais)

**Modo preview (sem instalar nada):**
```bash
bash install.sh --dry-run
```

---

## Seção 7 — Verificar a instalação

```bash
nox-mem doctor
```

**Output esperado (todos verdes):**
```
✅ Ollama: online (llama3.2:3b)
✅ SQLite: schema v2
✅ Workspace: /root/.openclaw/workspace
✅ Watcher: ativo
✅ Crons: configurados
```

Se algum item aparecer com ⚠️, consulte o `troubleshooting/FAQ.md`.

---

## Seção 8 — Testar a busca

Primeiro, indexe os arquivos existentes do seu workspace:

```bash
nox-mem reindex
```

Agora teste a busca:

```bash
nox-mem search "OpenClaw"
nox-mem search "agente"
```

Ver estatísticas do índice:

```bash
nox-mem stats
```

---

## Seção 9 — Configurar o SOUL.md do agente

Adicione ao `SOUL.md` do seu agente para ativar o SuperMem:

```markdown
## Memória (SuperMem)
Ao iniciar TODA sessão, executar obrigatoriamente:
\`\`\`bash
nox-mem primer
\`\`\`

Para buscar informações anteriores:
\`\`\`bash
nox-mem search "palavra-chave"
\`\`\`
```

---

## Seção 10 — Criar a primeira nota diária

O SuperMem funciona a partir de notas diárias em Markdown:

```bash
# Criar nota do dia
nano ~/.openclaw/workspace/memory/2026-03-15.md
```

**Formato recomendado:**
```markdown
# 2026-03-15

## Decisões
- Decidi usar TypeScript para o projeto X por ser mais seguro que JS puro

## Aprendizados
- Descobri que o FTS5 suporta busca por prefixo: nox-mem search "deci*"

## Pendências
- [ ] Revisar configuração do Ollama até sexta
```

Salve o arquivo — o watcher detecta a mudança e indexa automaticamente em ~3 segundos.

---

## Seção 11 — Testar a consolidação com IA

Após criar algumas notas diárias (1-3 dias), rode a consolidação manual:

```bash
nox-mem consolidate
```

**O que acontece:**
1. Ollama lê as notas do dia
2. Extrai decisões, lições, pessoas, projetos e pendências
3. Salva nos arquivos `memory/decisions.md`, `memory/lessons.md`, etc.
4. Faz commit automático no git

**Verificar resultado:**
```bash
cat ~/.openclaw/workspace/memory/decisions.md
cat ~/.openclaw/workspace/memory/lessons.md
```

---

## Seção 12 — Testar o primer (recovery)

O primer é o que garante que seu agente nunca perde contexto após compactação:

```bash
nox-mem primer
```

**Output:** resumo de ~500 tokens com as decisões, lições e pendências mais recentes. Cole isso no início da sessão do agente quando ele precisar de contexto.

---

## Seção 13 — Verificar crons

```bash
crontab -l
```

**Output esperado:**
```
0 23 * * * /usr/local/bin/nox-mem consolidate >> ~/.openclaw/workspace/logs/nox-mem.log 2>&1
0 21 * * 0 /usr/local/bin/nox-mem digest >> ~/.openclaw/workspace/logs/nox-mem.log 2>&1
```

Ver logs da execução automática:
```bash
tail -f ~/.openclaw/workspace/logs/nox-mem.log
```

---

## Seção 14 — Verificar watcher

```bash
systemctl status nox-mem-watcher
```

**Output esperado:** `active (running)`

Testar: edite qualquer arquivo `.md` em `memory/` e aguarde ~3 segundos. O watcher detecta e indexa automaticamente.

```bash
tail -5 /tmp/nox-mem-watcher.log
```

---

## Seção 15 — Próximos passos

**Seu agente agora tem:**
- ✅ Busca em <1 segundo em toda a memória
- ✅ Consolidação automática às 23h com IA local
- ✅ Digest semanal todo domingo às 21h
- ✅ Recovery automático pós-compactação
- ✅ Indexação em tempo real de novas notas

**Para avançar:**

Se comprou o **Tier B**, explore os perfis prontos em `perfis/`:
```bash
# Copiar perfil de assistente pessoal
cp perfis/assistente-pessoal/SOUL.md ~/.openclaw/agents/meu-agente/
cp perfis/assistente-pessoal/HEARTBEAT.md ~/.openclaw/agents/meu-agente/
```

**Problemas?**
- Consulte `troubleshooting/FAQ.md` (20+ problemas resolvidos)
- Tier C: acesse `suporte/ACESSO-SUPORTE.md` para suporte direto

---

*NOX-Supermem v1.0 | Criado por Toto Busnello*
