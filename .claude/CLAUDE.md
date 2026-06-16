# Nox Supermem — Claude Instructions

> Stack-specific hints. AO injeta agentRules adicionais em cada spawn.

## Stack

Successor experimental do `memoria-nox` — verificar README/specs.

## Specialists Sugeridos

- `python-pro`
- `ai-engineer`
- `data-engineer`
- `llm-architect`

Para invocar: `Use o agent <nome> pra ...` (ver `~/.claude/agents/`).

## Contexto / Restrições

- **Coordenar com `memoria-nox`** pra não duplicar effort.
- Verificar specs em `/specs/` antes de assumir arquitetura.
- Provável extensão: hybrid search + KG + embeddings.

## Quality Gates

- Tests cobrindo retrieval correctness.
- Benchmarks vs memoria-nox antes de declarar superior.

## Style

- PT-BR "você" (não "tu/vc").
- Terso, direto. Ship a coisa.
- Não inventar features fora do escopo do task.
