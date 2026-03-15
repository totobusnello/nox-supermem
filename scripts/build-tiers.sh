#!/usr/bin/env bash
# NOX-Supermem — Gerador de ZIPs por Tier
# Uso: bash scripts/build-tiers.sh [a|b|c|all]
# Gera os arquivos de entrega para cada tier do Hotmart

set -euo pipefail

BOLD='\033[1m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; RESET='\033[0m'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION=$(node -e "console.log(require('$ROOT/nox-mem/package.json').version)" 2>/dev/null || echo "1.0.0")
OUT="$ROOT/dist-tiers"

log()  { echo -e "${GREEN}[✓]${RESET} $*"; }
info() { echo -e "${BLUE}[→]${RESET} $*"; }

mkdir -p "$OUT"

build_tier_a() {
  info "Gerando Tier A (Kit Técnico — R\$147)..."
  local dir="$OUT/nox-supermem-tier-a-v$VERSION"
  rm -rf "$dir" && mkdir -p "$dir"

  # Conteúdo Tier A
  cp "$ROOT/README.md"            "$dir/"
  cp "$ROOT/LICENSE.md"           "$dir/" 2>/dev/null || true
  cp "$ROOT/GUIA-INSTALACAO.md"   "$dir/" 2>/dev/null || true
  cp "$ROOT/install.sh"           "$dir/"
  chmod +x "$dir/install.sh"

  # nox-mem (sem node_modules e dist — install.sh faz o build)
  mkdir -p "$dir/nox-mem"
  rsync -a --exclude='node_modules' --exclude='dist' --exclude='*.db' \
    "$ROOT/nox-mem/" "$dir/nox-mem/"

  # Templates
  [[ -d "$ROOT/templates" ]] && cp -r "$ROOT/templates" "$dir/"

  # Empacotar
  cd "$OUT"
  zip -r "nox-supermem-tier-a-v$VERSION.zip" "nox-supermem-tier-a-v$VERSION/" -x "*.DS_Store"
  rm -rf "$dir"
  log "Tier A → $OUT/nox-supermem-tier-a-v$VERSION.zip"
}

build_tier_b() {
  info "Gerando Tier B (Kit Completo — R\$197)..."
  local dir="$OUT/nox-supermem-tier-b-v$VERSION"
  rm -rf "$dir" && mkdir -p "$dir"

  # Tier B = Tier A + video + perfis + troubleshooting
  cp "$ROOT/README.md"            "$dir/"
  cp "$ROOT/LICENSE.md"           "$dir/" 2>/dev/null || true
  cp "$ROOT/GUIA-INSTALACAO.md"   "$dir/" 2>/dev/null || true
  cp "$ROOT/install.sh"           "$dir/"
  chmod +x "$dir/install.sh"

  mkdir -p "$dir/nox-mem"
  rsync -a --exclude='node_modules' --exclude='dist' --exclude='*.db' \
    "$ROOT/nox-mem/" "$dir/nox-mem/"

  [[ -d "$ROOT/templates" ]]       && cp -r "$ROOT/templates"       "$dir/"
  [[ -d "$ROOT/video" ]]           && cp -r "$ROOT/video"           "$dir/"
  [[ -d "$ROOT/perfis" ]]          && cp -r "$ROOT/perfis"          "$dir/"
  [[ -d "$ROOT/troubleshooting" ]] && cp -r "$ROOT/troubleshooting" "$dir/"

  cd "$OUT"
  zip -r "nox-supermem-tier-b-v$VERSION.zip" "nox-supermem-tier-b-v$VERSION/" -x "*.DS_Store"
  rm -rf "$dir"
  log "Tier B → $OUT/nox-supermem-tier-b-v$VERSION.zip"
}

build_tier_c() {
  info "Gerando Tier C (Kit + Suporte — R\$227)..."
  local dir="$OUT/nox-supermem-tier-c-v$VERSION"
  rm -rf "$dir" && mkdir -p "$dir"

  # Tier C = Tier B + suporte
  cp "$ROOT/README.md"            "$dir/"
  cp "$ROOT/LICENSE.md"           "$dir/" 2>/dev/null || true
  cp "$ROOT/GUIA-INSTALACAO.md"   "$dir/" 2>/dev/null || true
  cp "$ROOT/install.sh"           "$dir/"
  chmod +x "$dir/install.sh"

  mkdir -p "$dir/nox-mem"
  rsync -a --exclude='node_modules' --exclude='dist' --exclude='*.db' \
    "$ROOT/nox-mem/" "$dir/nox-mem/"

  [[ -d "$ROOT/templates" ]]       && cp -r "$ROOT/templates"       "$dir/"
  [[ -d "$ROOT/video" ]]           && cp -r "$ROOT/video"           "$dir/"
  [[ -d "$ROOT/perfis" ]]          && cp -r "$ROOT/perfis"          "$dir/"
  [[ -d "$ROOT/troubleshooting" ]] && cp -r "$ROOT/troubleshooting" "$dir/"
  [[ -d "$ROOT/suporte" ]]         && cp -r "$ROOT/suporte"         "$dir/"

  cd "$OUT"
  zip -r "nox-supermem-tier-c-v$VERSION.zip" "nox-supermem-tier-c-v$VERSION/" -x "*.DS_Store"
  rm -rf "$dir"
  log "Tier C → $OUT/nox-supermem-tier-c-v$VERSION.zip"
}

# --- Executar ---
TARGET="${1:-all}"
echo -e "${BOLD}NOX-Supermem v$VERSION — Build de Tiers${RESET}"
echo "Destino: $OUT"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

case "$TARGET" in
  a|A) build_tier_a ;;
  b|B) build_tier_b ;;
  c|C) build_tier_c ;;
  all) build_tier_a; build_tier_b; build_tier_c ;;
  *) echo "Uso: $0 [a|b|c|all]"; exit 1 ;;
esac

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✅ ZIPs gerados em: $OUT/${RESET}"
ls -lh "$OUT/"*.zip 2>/dev/null || true
