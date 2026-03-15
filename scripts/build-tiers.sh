#!/usr/bin/env bash
# NOX-Supermem — Gerador de ZIPs por Tier
# Uso: bash scripts/build-tiers.sh [a|b|c|all]
#
# Estrutura de tiers:
#   Tier A (R$147): Código + install.sh + Guia + Templates
#   Tier B (R$197): Tier A + 3 Perfis de agente + FAQ
#   Tier C (R$227): Tier B + Suporte 7 dias

set -euo pipefail

BOLD='\033[1m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; RESET='\033[0m'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION=$(node -e "console.log(require('$ROOT/nox-mem/package.json').version)" 2>/dev/null || echo "1.0.0")
OUT="$ROOT/dist-tiers"

log()  { echo -e "${GREEN}[✓]${RESET} $*"; }
info() { echo -e "${BLUE}[→]${RESET} $*"; }

mkdir -p "$OUT"

# Gera checksums internos (README-checksums.txt) e externo (.sha256) do ZIP
seal_zip() {
  local dir="$1" zipfile="$2"
  # README-checksums.txt dentro do ZIP — hash de cada arquivo incluído
  (cd "$dir" && find . -type f ! -name '.DS_Store' -exec sha256sum {} + | sort) \
    > "$dir/README-checksums.txt"
  cd "$OUT" && zip -r "$zipfile" "$(basename "$dir")/" -x "*.DS_Store"
  rm -rf "$dir"
  # SHA256 do próprio ZIP
  (cd "$OUT" && sha256sum "$zipfile" > "$zipfile.sha256")
  log "SHA256 → $OUT/$zipfile.sha256"
}

# Conteúdo base (comum a todos os tiers)
copy_base() {
  local dir="$1"
  cp "$ROOT/README.md"            "$dir/"
  cp "$ROOT/LICENSE.md"           "$dir/"
  cp "$ROOT/GUIA-INSTALACAO.md"   "$dir/"
  cp "$ROOT/install.sh"           "$dir/" && chmod +x "$dir/install.sh"
  mkdir -p "$dir/nox-mem"
  rsync -a --exclude='node_modules' --exclude='dist' --exclude='*.db' \
    "$ROOT/nox-mem/" "$dir/nox-mem/"
  [[ -d "$ROOT/templates" ]] && cp -r "$ROOT/templates" "$dir/"
}

build_tier_a() {
  info "Gerando Tier A — Kit Técnico (R\$147)..."
  local dir="$OUT/nox-supermem-tier-a-v$VERSION"
  rm -rf "$dir" && mkdir -p "$dir"
  copy_base "$dir"
  local zipfile="nox-supermem-tier-a-v$VERSION.zip"
  seal_zip "$dir" "$zipfile"
  log "Tier A → $OUT/$zipfile"
}

build_tier_b() {
  info "Gerando Tier B — Kit Completo (R\$197)..."
  local dir="$OUT/nox-supermem-tier-b-v$VERSION"
  rm -rf "$dir" && mkdir -p "$dir"
  copy_base "$dir"
  # Adiciona: 3 perfis + FAQ
  [[ -d "$ROOT/perfis" ]]          && cp -r "$ROOT/perfis"          "$dir/"
  [[ -d "$ROOT/troubleshooting" ]] && cp -r "$ROOT/troubleshooting" "$dir/"
  local zipfile="nox-supermem-tier-b-v$VERSION.zip"
  seal_zip "$dir" "$zipfile"
  log "Tier B → $OUT/$zipfile"
}

build_tier_c() {
  info "Gerando Tier C — Kit + Suporte (R\$227)..."
  local dir="$OUT/nox-supermem-tier-c-v$VERSION"
  rm -rf "$dir" && mkdir -p "$dir"
  copy_base "$dir"
  # Adiciona: 3 perfis + FAQ + suporte
  [[ -d "$ROOT/perfis" ]]          && cp -r "$ROOT/perfis"          "$dir/"
  [[ -d "$ROOT/troubleshooting" ]] && cp -r "$ROOT/troubleshooting" "$dir/"
  [[ -d "$ROOT/suporte" ]]         && cp -r "$ROOT/suporte"         "$dir/"
  local zipfile="nox-supermem-tier-c-v$VERSION.zip"
  seal_zip "$dir" "$zipfile"
  log "Tier C → $OUT/$zipfile"
}

TARGET="${1:-all}"
echo -e "${BOLD}NOX-Supermem v$VERSION — Build de Tiers${RESET}"
echo -e "  A: código + guia + templates"
echo -e "  B: A + perfis + FAQ"
echo -e "  C: B + suporte 7 dias"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

case "$TARGET" in
  a|A) build_tier_a ;;
  b|B) build_tier_b ;;
  c|C) build_tier_c ;;
  all) build_tier_a; build_tier_b; build_tier_c ;;
  *) echo "Uso: $0 [a|b|c|all]"; exit 1 ;;
esac

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✅ ZIPs gerados em $OUT/${RESET}"
ls -lh "$OUT/"*.zip "$OUT/"*.sha256 2>/dev/null || true
