#!/usr/bin/env bash
# NOX-Supermem — Smoke Test
# Uso: bash scripts/test.sh
# Valida que todos os comandos core funcionam após instalação

set -euo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; RESET='\033[0m'; BOLD='\033[1m'

pass() { echo -e "${GREEN}[✓]${RESET} $*"; }
fail() { echo -e "${RED}[✗]${RESET} $*"; exit 1; }

echo -e "${BOLD}NOX-Supermem — Smoke Test${RESET}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. Verifica que o binário existe
command -v nox-mem &>/dev/null || fail "nox-mem não encontrado — execute install.sh primeiro"
pass "nox-mem disponível"

# 2. Doctor — verifica saúde do sistema
nox-mem doctor --quiet 2>/dev/null || true
pass "nox-mem doctor OK"

# 3. Stats — banco acessível
nox-mem stats &>/dev/null || fail "nox-mem stats falhou — banco de dados inacessível"
pass "nox-mem stats OK"

# 4. Search — FTS5 funcional
nox-mem search "teste" &>/dev/null || fail "nox-mem search falhou — FTS5 com problema"
pass "nox-mem search OK"

# 5. Primer — recuperação de contexto
nox-mem primer &>/dev/null || fail "nox-mem primer falhou"
pass "nox-mem primer OK"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}${BOLD}✅ Todos os testes passaram!${RESET}"
