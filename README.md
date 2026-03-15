# ⚡ NOX-Supermem — O Upgrade de Memória do seu Agente OpenClaw

> Seu agente OpenClaw esquece decisões, repete perguntas e perde contexto após cada sessão?
> **Supermem resolve.** Busca inteligente, consolidação com IA local, e memória que nunca se perde.

---

## O que você recebe

- 🔍 **Busca em <1 segundo** — encontre qualquer decisão, lição ou conversa por palavra-chave
- 🧠 **Consolidação automática com IA** — Ollama local extrai fatos e organiza sem custo de API
- 🔄 **Recovery pós-compactação** — seu agente nunca mais pergunta "onde estávamos?"
- 📊 **Digest semanal automático** — resumo da semana gerado toda domingo às 21h
- ⚡ **Instala em 30 minutos** — 1 comando, funciona sozinho 24/7
- 💰 **Custo zero de operação** — sem API paga, sem servidor extra, roda na sua VPS

---

## Requisitos

- VPS Linux com 4GB+ de RAM (Ubuntu 20.04+ recomendado)
- Node.js 20+
- OpenClaw instalado e configurado
- Conexão com a internet (só para baixar o Ollama na primeira vez)

---

## Instalação rápida

```bash
bash install.sh
```

Modo preview (sem instalar nada):
```bash
bash install.sh --dry-run
```

---

## Comandos disponíveis

| Comando | O que faz |
|---|---|
| `nox-mem search "palavra"` | Busca na memória indexada |
| `nox-mem primer` | Contexto de recovery pós-compactação |
| `nox-mem stats` | Estatísticas do índice |
| `nox-mem consolidate` | Extrai fatos das notas diárias com IA |
| `nox-mem digest` | Resumo semanal via Ollama |
| `nox-mem reindex` | Reindexa toda a memória |
| `nox-mem doctor` | Diagnóstico completo do sistema |

---

## Tiers

| Tier | O que inclui | Preço |
|---|---|---|
| **A — Kit Técnico** | Código + install.sh + Guia completo + Templates | R$147 |
| **B — Kit Completo** | Tudo do A + 3 Perfis de agente + FAQ (20+ problemas) | R$197 |
| **C — Kit + Suporte** | Tudo do B + Suporte por 7 dias (chatbot + email) | R$227 |

---

## O que está incluído

```
NOX-Supermem/
├── install.sh              — instalação em 1 comando
├── GUIA-INSTALACAO.md      — passo a passo completo (→ PDF)
├── README.md               — este arquivo
├── LICENSE.md              — termos de uso
├── nox-mem/                — código fonte completo
│   ├── src/                — 12 módulos TypeScript
│   └── prompts/            — prompts PT-BR para Ollama
├── templates/              — arquivos base para seu agente (Tier A)
│   ├── SOUL.md
│   ├── MEMORY.md
│   ├── HEARTBEAT.md
│   ├── IDENTITY.md
│   ├── TOOLS.md
│   └── SESSION-STATE.md
├── perfis/                 — 3 perfis prontos (Tier B)
│   ├── assistente-pessoal/
│   ├── pesquisador/
│   └── financeiro/
└── troubleshooting/        — FAQ com 20+ problemas resolvidos (Tier B)
```

---

## Verificar instalação

```bash
nox-mem doctor
```

---

## Suporte

- **Tier A/B:** consulte `troubleshooting/FAQ.md`
- **Tier C:** acesse o chatbot em `suporte/ACESSO-SUPORTE.md`

---

*Criado por Toto Busnello | Licença: uso pessoal, até 3 instalações*
