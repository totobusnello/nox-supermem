# FAQ — Solução de Problemas NOX-Supermem

---

## 🔧 Instalação

### "Node.js não encontrado" ou "versão incorreta"

**Causa:** Node.js não está instalado ou está desatualizado (precisa de v20+).

**Solução:**
```bash
# Verificar versão atual
node --version

# Instalar Node.js 20 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
```

---

### "Workspace não detectado" ou instalou no lugar errado

**Causa:** OpenClaw não está no PATH ou workspace está em local não padrão.

**Solução:**
```bash
# Verificar workspace do OpenClaw
openclaw config get workspace

# Definir manualmente antes de instalar
export OPENCLAW_WORKSPACE=/caminho/para/workspace
bash install.sh
```

---

### "Permission denied" ao criar symlink em /usr/local/bin

**Causa:** instalando sem permissão de root.

**Solução:**
```bash
sudo bash install.sh
# ou
sudo ln -sf ~/.openclaw/workspace/tools/nox-mem/dist/index.js /usr/local/bin/nox-mem
```

---

### npm install falhou com erros de compilação (better-sqlite3)

**Causa:** falta de ferramentas de compilação nativas (node-gyp).

**Solução:**
```bash
apt-get install -y build-essential python3
cd ~/.openclaw/workspace/tools/nox-mem
npm install
```

---

## 🤖 Ollama

### "Ollama offline" ou consolidação não funciona

**Causa:** Ollama não está rodando.

**Solução:**
```bash
# Verificar status
curl http://localhost:11434/api/tags

# Iniciar Ollama
ollama serve &

# Verificar se o modelo está disponível
ollama list
```

---

### "Modelo não encontrado" (llama3.2:3b)

**Causa:** modelo não foi baixado na instalação.

**Solução:**
```bash
ollama pull llama3.2:3b

# Para usar outro modelo, edite config.json:
# "ollama": { "model": "mistral:7b" }
```

---

### Consolidação muito lenta (>5 minutos por arquivo)

**Causa:** VPS com pouca RAM ou CPU sobrecarregada. llama3.2:3b precisa de ~4GB RAM.

**Solução:**
```bash
# Verificar uso de memória
free -h

# Usar modelo menor
ollama pull qwen2.5:1.5b
# Atualizar config.json: "model": "qwen2.5:1.5b"
```

---

### Ollama retorna JSON inválido

**Causa:** modelo tendo alucinação na estrutura JSON.

**Solução:**
```bash
# Reprocessar os arquivos com falha
nox-mem retry-failed

# Se continuar falhando, tentar modelo diferente
```

---

## 🔍 Busca (FTS5)

### "FTS5 not found" ou erro de banco de dados

**Causa:** SQLite compilado sem suporte a FTS5 (raro em sistemas modernos).

**Solução:**
```bash
# Verificar suporte FTS5
node -e "const db = require('better-sqlite3')(':memory:'); db.exec('CREATE VIRTUAL TABLE t USING fts5(x)'); console.log('FTS5 OK')"

# Se falhar, reinstalar better-sqlite3
cd ~/.openclaw/workspace/tools/nox-mem
npm rebuild better-sqlite3
```

---

### Busca não retorna resultados esperados

**Causa:** arquivo não foi indexado ou chunks muito fragmentados.

**Solução:**
```bash
# Verificar se o arquivo está indexado
nox-mem stats

# Reindexar tudo
nox-mem reindex

# Tentar variações do termo
nox-mem search "decisão"
nox-mem search "decidiu"
```

---

### Caracteres especiais (ã, ç, é) não funcionam na busca

**Causa:** encoding do arquivo fonte incorreto.

**Solução:**
```bash
# Verificar encoding
file -i memory/2026-03-15.md

# Converter para UTF-8 se necessário
iconv -f LATIN1 -t UTF-8 arquivo.md > arquivo-utf8.md
```

---

## 📁 Consolidação

### "Nothing to consolidate" mas existem notas diárias

**Causa:** arquivos já foram consolidados ou não têm o tipo correto no índice.

**Solução:**
```bash
# Verificar stats
nox-mem stats

# Reindexar e tentar novamente
nox-mem reindex
nox-mem consolidate
```

---

### Consolidação falha em todos os arquivos

**Causa:** Ollama offline ou prompt inválido.

**Solução:**
```bash
# Verificar Ollama
curl http://localhost:11434/api/generate \
  -d '{"model":"llama3.2:3b","prompt":"teste","stream":false}'

# Verificar log de erros
tail -50 ~/.openclaw/workspace/logs/nox-mem.log
```

---

### Itens duplicados nos arquivos de memória

**Causa:** arquivo foi reindexado e consolidado duas vezes.

**Solução:**
```bash
# O sistema de deduplicação cobre a maioria dos casos
# Para casos extremos, editar manualmente memory/decisions.md
# e rodar reindex
nox-mem reindex
```

---

## 👀 Watcher (Monitoramento automático)

### "inotifywait: command not found"

**Causa:** inotify-tools não instalado.

**Solução:**
```bash
apt-get install -y inotify-tools
# Ou no CentOS/RHEL:
yum install -y inotify-tools
```

---

### Watcher não detecta mudanças nos arquivos

**Causa:** systemd service não está rodando ou VPS não tem suporte a inotify.

**Solução:**
```bash
# Verificar status do service
systemctl status nox-mem-watcher

# Reiniciar
systemctl restart nox-mem-watcher

# Ver logs
tail -20 /tmp/nox-mem-watcher.log
```

---

### Watcher consumindo muito CPU

**Causa:** loop de debounce com intervalo muito curto ou muitos arquivos sendo modificados simultaneamente.

**Solução:**
Editar `config.json` e aumentar o debounce:
```json
"watcher": {
  "debounceMs": 10000
}
```

---

## 🩺 Diagnóstico geral

### Como rodar um diagnóstico completo

```bash
nox-mem doctor
```

Mostra: Ollama, SQLite, modelo, workspace, crons, watcher.

---

### Como ver estatísticas do índice

```bash
nox-mem stats
```

Mostra: total de chunks, arquivos indexados, última consolidação, arquivos pendentes.

---

### Como reindexar tudo do zero

```bash
nox-mem reindex
```

**Atenção:** o reindex preserva o estado de consolidação (arquivos já consolidados não são reprocessados).

---

## 📞 Ainda com problema?

- **Tier B:** abra uma issue com o output de `nox-mem doctor` e o log em `/tmp/nox-supermem-install.log`
- **Tier C:** acesse o suporte em `suporte/ACESSO-SUPORTE.md`
