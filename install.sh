#!/usr/bin/env bash
# =============================================================================
# NOX-Supermem — Instalador Automatizado
# =============================================================================
# Uso: bash install.sh [--dry-run]
# Requisitos: VPS Linux, Node.js 20+, OpenClaw instalado
# =============================================================================

set -euo pipefail

# --- Cores ---
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

# --- Flags ---
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

LOG_FILE="/tmp/nox-supermem-install.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Utilitários ---
log()  { echo -e "${GREEN}[✓]${RESET} $*" | tee -a "$LOG_FILE"; }
info() { echo -e "${BLUE}[→]${RESET} $*" | tee -a "$LOG_FILE"; }
warn() { echo -e "${YELLOW}[!]${RESET} $*" | tee -a "$LOG_FILE"; }
err()  { echo -e "${RED}[✗]${RESET} $*" | tee -a "$LOG_FILE"; exit 1; }
step() { echo -e "\n${BOLD}${BLUE}━━ $* ${RESET}" | tee -a "$LOG_FILE"; }
dry()  { echo -e "${YELLOW}[DRY]${RESET} $*"; }

run() {
  if $DRY_RUN; then dry "$*"; else "$@" >> "$LOG_FILE" 2>&1 || err "Falhou: $*  (veja $LOG_FILE)"; fi
}

# --- Banner ---
echo -e "${BOLD}"
echo "  ███████╗██╗   ██╗██████╗ ███████╗██████╗ ███╗   ███╗███████╗███╗   ███╗"
echo "  ██╔════╝██║   ██║██╔══██╗██╔════╝██╔══██╗████╗ ████║██╔════╝████╗ ████║"
echo "  ███████╗██║   ██║██████╔╝█████╗  ██████╔╝██╔████╔██║█████╗  ██╔████╔██║"
echo "  ╚════██║██║   ██║██╔═══╝ ██╔══╝  ██╔══██╗██║╚██╔╝██║██╔══╝  ██║╚██╔╝██║"
echo "  ███████║╚██████╔╝██║     ███████╗██║  ██║██║ ╚═╝ ██║███████╗██║ ╚═╝ ██║"
echo "  ╚══════╝ ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝╚═╝     ╚═╝"
echo -e "${RESET}"
echo -e "  ${BOLD}NOX-Supermem${RESET} — O upgrade de memória do seu agente OpenClaw"
echo -e "  $([ "$DRY_RUN" = true ] && echo "${YELLOW}MODO DRY-RUN — nenhuma alteração será feita${RESET}" || echo "Iniciando instalação...")"
echo ""

# =============================================================================
# ETAPA 1 — Detectar workspace
# =============================================================================
step "Etapa 1/9 — Detectar workspace OpenClaw"

detect_workspace() {
  if command -v openclaw &>/dev/null; then
    local ws
    ws=$(openclaw config get workspace 2>/dev/null || true)
    [[ -n "$ws" ]] && echo "$ws" && return
  fi
  [[ -n "${OPENCLAW_WORKSPACE:-}" ]] && echo "$OPENCLAW_WORKSPACE" && return
  local common_paths=(
    "$HOME/.openclaw/workspace"
    "/root/.openclaw/workspace"
    "/home/openclaw/.openclaw/workspace"
  )
  for p in "${common_paths[@]}"; do
    [[ -d "$p" ]] && echo "$p" && return
  done
  echo "$HOME/.openclaw/workspace"
}

WORKSPACE=$(detect_workspace)
NOX_MEM_DEST="$WORKSPACE/tools/nox-mem"
CONFIG_FILE="$NOX_MEM_DEST/config.json"

info "Workspace detectado: $WORKSPACE"
info "Destino de instalação: $NOX_MEM_DEST"

# =============================================================================
# ETAPA 2 — Verificar Node.js 20+
# =============================================================================
step "Etapa 2/9 — Verificar Node.js"

if ! command -v node &>/dev/null; then
  err "Node.js não encontrado. Instale Node.js 20+ antes de continuar."
fi

NODE_VERSION=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
if [[ -z "$NODE_VERSION" ]] || ! [[ "$NODE_VERSION" =~ ^[0-9]+$ ]]; then
  err "Não foi possível determinar a versão do Node.js. Verifique se node está instalado."
fi
if [[ "$NODE_VERSION" -lt 20 ]]; then
  err "Node.js $NODE_VERSION encontrado. Requer Node.js 20+. Atualize em: https://nodejs.org"
fi
log "Node.js v$(node --version | sed 's/v//') — OK"

# =============================================================================
# ETAPA 3 — Instalar inotify-tools
# =============================================================================
step "Etapa 3/9 — Instalar inotify-tools (file watcher)"

if command -v inotifywait &>/dev/null; then
  log "inotifywait já instalado"
else
  info "Instalando inotify-tools..."
  if command -v apt-get &>/dev/null; then
    run apt-get install -y inotify-tools
  elif command -v yum &>/dev/null; then
    run yum install -y inotify-tools
  elif command -v dnf &>/dev/null; then
    run dnf install -y inotify-tools
  else
    warn "Gerenciador de pacotes não reconhecido. Instale inotify-tools manualmente."
  fi
  log "inotify-tools instalado"
fi

# =============================================================================
# ETAPA 4 — Instalar Ollama + modelo
# =============================================================================
step "Etapa 4/9 — Instalar Ollama e modelo de IA"

if command -v ollama &>/dev/null; then
  log "Ollama já instalado ($(ollama --version 2>/dev/null || echo 'versão desconhecida'))"
else
  TOTAL_RAM_MB=$(free -m 2>/dev/null | awk '/^Mem:/{print $2}' || echo 0)
  if [[ "$TOTAL_RAM_MB" -lt 2048 ]]; then
    warn "RAM disponível: ${TOTAL_RAM_MB}MB. Ollama requer mínimo 2GB. O modelo pode travar em VPS com pouca memória."
  fi
  info "Instalando Ollama..."
  run bash -c 'curl -fsSL https://ollama.com/install.sh | sh'
  log "Ollama instalado"
fi

# Garantir que Ollama está rodando
if ! curl -s http://localhost:11434/api/tags &>/dev/null; then
  info "Iniciando Ollama..."
  if $DRY_RUN; then
    dry "ollama serve &"
  else
    ollama serve >> "$LOG_FILE" 2>&1 &
    # Aguardar Ollama ficar pronto (até 10 tentativas, 1s cada)
    for i in $(seq 1 10); do
      curl -s http://localhost:11434/api/tags &>/dev/null && break
      [[ "$i" -eq 10 ]] && err "Ollama não respondeu após 10 tentativas"
      sleep 1
    done
  fi
fi

# Bind Ollama apenas em localhost e bloquear porta via firewall
if $DRY_RUN; then
  dry "Configurar OLLAMA_HOST=127.0.0.1 no systemd override"
  dry "ufw deny 11434"
else
  if command -v systemctl &>/dev/null; then
    mkdir -p /etc/systemd/system/ollama.service.d
    cat > /etc/systemd/system/ollama.service.d/override.conf << 'OLLAMAEOF'
[Service]
Environment="OLLAMA_HOST=127.0.0.1"
OLLAMAEOF
    systemctl daemon-reload
    systemctl restart ollama 2>/dev/null || true
  fi
  if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw deny 11434 &>/dev/null && log "ufw: porta 11434 bloqueada" || warn "ufw: falha ao bloquear porta 11434"
  else
    warn "ufw não está ativo — recomendado bloquear a porta 11434 manualmente: ufw allow 11434 ... depois ufw deny 11434"
  fi
fi

OLLAMA_MODEL="${OLLAMA_MODEL:-llama3.2:3b}"
info "Baixando modelo $OLLAMA_MODEL (pode demorar na primeira vez)..."
if $DRY_RUN; then
  dry "ollama pull $OLLAMA_MODEL"
else
  ollama pull "$OLLAMA_MODEL" 2>&1 | tee -a "$LOG_FILE" | grep -E "pulling|success|error" || true
fi
log "Modelo $OLLAMA_MODEL disponível"

# =============================================================================
# ETAPA 5 — Copiar nox-mem para o workspace
# =============================================================================
step "Etapa 5/9 — Instalar nox-mem no workspace"

if $DRY_RUN; then
  dry "mkdir -p $NOX_MEM_DEST"
  dry "cp -r $SCRIPT_DIR/nox-mem/* $NOX_MEM_DEST/"
else
  mkdir -p "$NOX_MEM_DEST"
  cp -r "$SCRIPT_DIR/nox-mem/." "$NOX_MEM_DEST/"
fi
log "Arquivos copiados para $NOX_MEM_DEST"

# =============================================================================
# ETAPA 6 — Criar config.json
# =============================================================================
step "Etapa 6/9 — Criar configuração"

if [[ -f "$CONFIG_FILE" ]]; then
  warn "config.json já existe — mantendo configuração atual"
else
  if $DRY_RUN; then
    dry "Criar config.json em $CONFIG_FILE"
  else
    cat > "$CONFIG_FILE" << JSONEOF
{
  "workspace": "$WORKSPACE",
  "ollama": {
    "url": "http://localhost:11434",
    "model": "$OLLAMA_MODEL"
  },
  "notion": {
    "enabled": false,
    "token": "",
    "databaseId": "",
    "apiVersion": "2025-09-03"
  },
  "consolidation": {
    "maxFilesPerRun": 5,
    "timeoutMs": 120000,
    "retries": 3
  },
  "watcher": {
    "debounceMs": 3000,
    "excludeFiles": ["MEMORY.md", "SESSION-STATE.md"]
  }
}
JSONEOF
  fi
  chmod 600 "$CONFIG_FILE"
  log "config.json criado"
  log "Permissões do config.json: 600 (somente dono)"
fi

# =============================================================================
# ETAPA 7 — Build (npm install + tsc)
# =============================================================================
step "Etapa 7/9 — Build (npm install + compilar TypeScript)"

if $DRY_RUN; then
  dry "cd $NOX_MEM_DEST && npm install && npm run build"
else
  (
    cd "$NOX_MEM_DEST"
    info "Instalando dependências..."
    npm install --silent 2>&1 | tee -a "$LOG_FILE" | tail -1 || err "npm install falhou (veja $LOG_FILE)"
    info "Compilando TypeScript..."
    npm run build 2>&1 | tee -a "$LOG_FILE" | tail -3 || err "Build falhou (veja $LOG_FILE)"
  )
fi
log "Build concluído"

# =============================================================================
# ETAPA 8 — Symlink + systemd watcher
# =============================================================================
step "Etapa 8/9 — Configurar comando global e watcher"

# Symlink para /usr/local/bin/nox-mem
NOX_BIN="$NOX_MEM_DEST/dist/index.js"
if $DRY_RUN; then
  dry "ln -sf $NOX_BIN /usr/local/bin/nox-mem"
else
  chmod +x "$NOX_BIN"
  ln -sf "$NOX_BIN" /usr/local/bin/nox-mem 2>/dev/null || \
    warn "Não foi possível criar symlink em /usr/local/bin (tente com sudo)"
fi
log "Comando nox-mem disponível"

# Instalar watcher systemd
SERVICE_FILE="$NOX_MEM_DEST/nox-mem-watcher.service"
if [[ -f "$SERVICE_FILE" ]] && command -v systemctl &>/dev/null; then
  if $DRY_RUN; then
    dry "Instalar systemd service: nox-mem-watcher"
  else
    # Substituir placeholder pelo caminho real
    WATCH_SCRIPT="$NOX_MEM_DEST/nox-mem-watch.sh"
    sed "s|__NOX_MEM_PATH__|$NOX_MEM_DEST|g" "$SERVICE_FILE" \
      > /etc/systemd/system/nox-mem-watcher.service
    chmod +x "$WATCH_SCRIPT"
    systemctl daemon-reload
    systemctl enable nox-mem-watcher --quiet
    systemctl start nox-mem-watcher
  fi
  log "Watcher systemd ativo (monitora memory/ em tempo real)"
else
  warn "systemd não disponível — watcher não instalado (opcional)"
fi

# =============================================================================
# ETAPA 9 — Crons + reindex inicial
# =============================================================================
step "Etapa 9/9 — Crons automáticos + reindex inicial"

if $DRY_RUN; then
  dry "Adicionar cron: consolidate diário às 23h"
  dry "Adicionar cron: digest semanal domingo às 21h"
  dry "nox-mem reindex"
else
  # Consolidação diária às 23h
  CRON_CONSOLIDATE="0 23 * * * /usr/local/bin/nox-mem consolidate >> $WORKSPACE/logs/nox-mem.log 2>&1"
  # Digest semanal domingo às 21h
  CRON_DIGEST="0 21 * * 0 /usr/local/bin/nox-mem digest >> $WORKSPACE/logs/nox-mem.log 2>&1"

  mkdir -p "$WORKSPACE/logs"

  # Adicionar crons usando markers únicos (idempotente)
  CRON_MARKER_START="# NOX-SUPERMEM-CRON-START"
  CRON_MARKER_END="# NOX-SUPERMEM-CRON-END"
  (
    crontab -l 2>/dev/null | sed "/$CRON_MARKER_START/,/$CRON_MARKER_END/d"
    echo "$CRON_MARKER_START"
    echo "$CRON_CONSOLIDATE"
    echo "$CRON_DIGEST"
    echo "$CRON_MARKER_END"
  ) | crontab -

  # Reindex inicial
  info "Indexando memória existente..."
  "$NOX_BIN" reindex 2>&1 | tee -a "$LOG_FILE" | tail -3 || warn "Reindex falhou — rode 'nox-mem reindex' manualmente"
fi
log "Crons configurados e reindex concluído"

# =============================================================================
# Diagnóstico final
# =============================================================================
echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}${GREEN}  ✅ NOX-Supermem instalado com sucesso!${RESET}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "${BOLD}Comandos disponíveis:${RESET}"
echo "  nox-mem search \"palavra\"    — buscar na memória"
echo "  nox-mem primer              — recuperar contexto (use no SOUL.md)"
echo "  nox-mem stats               — estatísticas do índice"
echo "  nox-mem consolidate         — consolidar notas com IA"
echo "  nox-mem digest              — gerar resumo semanal"
echo "  nox-mem doctor              — verificar saúde do sistema"
echo "  nox-mem reindex             — reindexar toda a memória"
echo ""
echo -e "${BOLD}Crons configurados:${RESET}"
echo "  23:00 diário   — consolidate (extração IA automática)"
echo "  21:00 domingo  — digest (resumo semanal)"
echo ""
echo -e "${BOLD}Próximos passos:${RESET}"
echo "  1. Adicione ao SOUL.md do seu agente:"
echo "     'Antes de cada sessão: execute nox-mem primer'"
echo "  2. Consulte o GUIA-INSTALACAO.md para configurações avançadas"
echo ""
if $DRY_RUN; then
  echo -e "${YELLOW}Modo dry-run: nenhuma alteração foi feita.${RESET}"
  echo -e "${YELLOW}Execute sem --dry-run para instalar de verdade.${RESET}"
fi
echo -e "Log completo: ${BLUE}$LOG_FILE${RESET}"
echo ""
