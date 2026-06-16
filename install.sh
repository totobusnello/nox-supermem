#!/usr/bin/env bash
# =============================================================================
# NOX-Supermem — Standalone Installer
# =============================================================================
# Installs the nox-mem engine from this directory (tarball or git clone).
# Does NOT require OpenClaw. Works on any Linux VPS with Node 20+.
#
# Usage:
#   bash install.sh [--dry-run]
#
# What this does:
#   1. Checks Node.js >= 20 and build-essential
#   2. Builds nox-mem (npm ci + tsc) inside this repo
#   3. Installs nox-mem globally (npm install -g .)
#   4. Writes a .env template if none exists
#   5. Optional: installs systemd watcher and daily crons
#
# What this does NOT do:
#   - Does NOT install OpenClaw
#   - Does NOT install Ollama (nox-mem uses Gemini by default)
#   - Does NOT publish to npm (install is local/tarball only)
# =============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

LOG_FILE="/tmp/nox-supermem-install.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NOX_MEM_DIR="$SCRIPT_DIR/nox-mem"

log()  { echo -e "${GREEN}[OK]${RESET} $*" | tee -a "$LOG_FILE"; }
info() { echo -e "${BLUE}[->]${RESET} $*" | tee -a "$LOG_FILE"; }
warn() { echo -e "${YELLOW}[!]${RESET} $*" | tee -a "$LOG_FILE"; }
err()  { echo -e "${RED}[ERR]${RESET} $*" | tee -a "$LOG_FILE"; exit 1; }
step() { echo -e "\n${BOLD}${BLUE}=== $* ===${RESET}" | tee -a "$LOG_FILE"; }
dry()  { echo -e "${YELLOW}[DRY]${RESET} $*"; }

run() {
  if $DRY_RUN; then dry "$*"; else "$@" >> "$LOG_FILE" 2>&1 || err "Failed: $*  (see $LOG_FILE)"; fi
}

# Banner
echo -e "${BOLD}"
echo "  NOX-Supermem — Standalone Engine Installer"
echo "  nox-mem v$(node -e "const p=require('$NOX_MEM_DIR/package.json'); console.log(p.version)" 2>/dev/null || echo '?')"
echo -e "${RESET}"
echo -e "  $([ "$DRY_RUN" = true ] && echo "${YELLOW}DRY-RUN MODE — no changes will be made${RESET}" || echo "Starting installation...")"
echo ""

# =============================================================================
# STEP 1 — Node.js >= 20
# =============================================================================
step "Step 1/5 — Check Node.js"

if ! command -v node &>/dev/null; then
  err "Node.js not found. Install Node.js 20+ first: https://nodejs.org"
fi

NODE_VERSION=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
if ! [[ "$NODE_VERSION" =~ ^[0-9]+$ ]] || [[ "$NODE_VERSION" -lt 20 ]]; then
  err "Node.js $NODE_VERSION found but >= 20 required. See: https://nodejs.org"
fi
log "Node.js $(node --version) — OK"

# =============================================================================
# STEP 2 — System build deps
# =============================================================================
step "Step 2/5 — System build dependencies"

MISSING_PKGS=()
command -v gcc &>/dev/null  || MISSING_PKGS+=(build-essential)
command -v python3 &>/dev/null || MISSING_PKGS+=(python3)

if [[ ${#MISSING_PKGS[@]} -gt 0 ]]; then
  info "Installing: ${MISSING_PKGS[*]}"
  if command -v apt-get &>/dev/null; then
    run apt-get install -y "${MISSING_PKGS[@]}"
  elif command -v yum &>/dev/null; then
    run yum install -y "${MISSING_PKGS[@]}"
  elif command -v dnf &>/dev/null; then
    run dnf install -y "${MISSING_PKGS[@]}"
  else
    warn "Unknown package manager. Install manually: ${MISSING_PKGS[*]}"
  fi
fi

# inotify-tools (optional, only needed for the file watcher)
if ! command -v inotifywait &>/dev/null; then
  info "Installing inotify-tools (optional, for file watcher)..."
  if command -v apt-get &>/dev/null; then
    run apt-get install -y inotify-tools
  else
    warn "inotify-tools not found — file watcher will be disabled. Install manually if needed."
  fi
fi
log "System deps — OK"

# =============================================================================
# STEP 3 — Build nox-mem
# =============================================================================
step "Step 3/5 — Build nox-mem (npm ci + tsc)"

if [[ ! -d "$NOX_MEM_DIR" ]]; then
  err "nox-mem directory not found at $NOX_MEM_DIR. Run this script from the repo root."
fi

if $DRY_RUN; then
  dry "cd $NOX_MEM_DIR && npm ci && npm run build"
else
  (
    cd "$NOX_MEM_DIR"
    info "Installing npm dependencies..."
    npm ci 2>&1 | tee -a "$LOG_FILE" | tail -3
    info "Compiling TypeScript..."
    npm run build 2>&1 | tee -a "$LOG_FILE" | tail -5
  )
fi
log "Build complete"

# =============================================================================
# STEP 4 — Global install
# =============================================================================
step "Step 4/5 — Install globally (npm install -g)"

if $DRY_RUN; then
  dry "cd $NOX_MEM_DIR && npm install -g ."
else
  (
    cd "$NOX_MEM_DIR"
    npm install -g . 2>&1 | tee -a "$LOG_FILE" | tail -3
  )
fi

# Verify
if ! $DRY_RUN; then
  if ! command -v nox-mem &>/dev/null; then
    warn "nox-mem not found in PATH after global install. Check npm prefix: $(npm prefix -g)/bin"
    warn "You may need to add it to PATH: export PATH=\"\$(npm prefix -g)/bin:\$PATH\""
  else
    log "nox-mem $(nox-mem --version 2>/dev/null | head -1 || echo 'installed') — OK"
  fi
fi

# =============================================================================
# STEP 5 — .env template
# =============================================================================
step "Step 5/5 — Environment configuration"

ENV_DEST="$NOX_MEM_DIR/.env"
ENV_EXAMPLE="$NOX_MEM_DIR/.env.example"

if [[ -f "$ENV_DEST" ]]; then
  warn ".env already exists at $ENV_DEST — not overwriting"
else
  if $DRY_RUN; then
    dry "Copy .env.example -> .env (fill in GEMINI_API_KEY, NOX_DB_PATH, NOX_MEM_DIR, NOX_API_TOKEN)"
  else
    if [[ -f "$ENV_EXAMPLE" ]]; then
      cp "$ENV_EXAMPLE" "$ENV_DEST"
      chmod 600 "$ENV_DEST"
      log ".env created at $ENV_DEST (mode 600)"
      warn "ACTION REQUIRED: Edit $ENV_DEST and set at minimum:"
      warn "  GEMINI_API_KEY=  (from https://aistudio.google.com/apikey)"
      warn "  NOX_DB_PATH=     (e.g. /root/nox-mem.db)"
      warn "  NOX_MEM_DIR=     (directory with your .md memory files)"
      warn "  NOX_API_TOKEN=   (generate: openssl rand -hex 32)"
    else
      warn ".env.example not found — create $ENV_DEST manually. See nox-mem/README.md."
    fi
  fi
fi

# Optional: systemd watcher
if command -v systemctl &>/dev/null && [[ -f "$NOX_MEM_DIR/nox-mem-watcher.service" ]]; then
  info "Installing systemd file watcher (optional)..."
  if $DRY_RUN; then
    dry "Install and enable nox-mem-watcher.service"
  else
    WATCH_SCRIPT="$NOX_MEM_DIR/nox-mem-watch.sh"
    sed "s|__NOX_MEM_PATH__|$NOX_MEM_DIR|g" "$NOX_MEM_DIR/nox-mem-watcher.service" \
      > /etc/systemd/system/nox-mem-watcher.service
    [[ -f "$WATCH_SCRIPT" ]] && chmod +x "$WATCH_SCRIPT"
    systemctl daemon-reload
    systemctl enable nox-mem-watcher --quiet
    systemctl start nox-mem-watcher
    log "File watcher active (systemd: nox-mem-watcher)"
  fi
else
  info "systemd watcher: skipped (systemctl not available or service file not found)"
fi

# Optional: cron jobs
if command -v crontab &>/dev/null; then
  info "Installing optional cron jobs..."
  LOG_DIR="${NOX_LOG_DIR:-/var/log/nox-mem}"
  CRON_CONSOLIDATE="0 23 * * * nox-mem consolidate >> $LOG_DIR/nox-mem.log 2>&1"
  CRON_VECTORIZE="0 */4 * * * nox-mem vectorize >> $LOG_DIR/nox-mem.log 2>&1"
  MARKER_START="# NOX-SUPERMEM-CRON-START"
  MARKER_END="# NOX-SUPERMEM-CRON-END"
  if $DRY_RUN; then
    dry "Install crons: consolidate 23:00 daily, vectorize every 4h"
  else
    mkdir -p "$LOG_DIR"
    (
      crontab -l 2>/dev/null | sed "/$MARKER_START/,/$MARKER_END/d"
      echo "$MARKER_START"
      echo "$CRON_CONSOLIDATE"
      echo "$CRON_VECTORIZE"
      echo "$MARKER_END"
    ) | crontab -
    log "Crons installed (consolidate daily 23:00, vectorize every 4h)"
  fi
fi

# =============================================================================
# Done
# =============================================================================
echo ""
echo -e "${BOLD}${GREEN}=== Installation complete ===${RESET}"
echo ""
echo -e "${BOLD}Next steps:${RESET}"
echo "  1. Edit $ENV_DEST (set GEMINI_API_KEY, NOX_DB_PATH, NOX_MEM_DIR, NOX_API_TOKEN)"
echo "  2. Source the env:  set -a; source $ENV_DEST; set +a"
echo "  3. Run first index: nox-mem reindex"
echo "  4. Start API:       nox-mem serve"
echo "  5. Health check:    curl http://127.0.0.1:18802/api/health | jq .vectorCoverage"
echo ""
echo -e "${BOLD}Key commands:${RESET}"
echo "  nox-mem search \"query\"  — hybrid search"
echo "  nox-mem stats           — chunk/vector/KG counts"
echo "  nox-mem vectorize       — embed pending chunks"
echo "  nox-mem kg-build        — extract knowledge graph"
echo "  nox-mem --help          — full command list"
echo ""
if $DRY_RUN; then
  echo -e "${YELLOW}DRY-RUN: no changes were made. Re-run without --dry-run to install.${RESET}"
fi
echo "Install log: $LOG_FILE"
echo ""
