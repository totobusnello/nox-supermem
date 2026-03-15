# NOX-Supermem — Product Design Spec

> Kit digital que transforma a memória básica do OpenClaw em um sistema inteligente
> com busca, consolidação IA e contexto que nunca se perde.

**Autor:** Toto Busnello + Claude
**Data:** 2026-03-14
**Status:** Aprovado para implementação
**Mercado:** Brasil (PT-BR)
**Plataforma:** Hotmart

---

## 1. Proposta de Valor

### O Problema
O OpenClaw tem memória básica: arquivos Markdown sem busca, sem consolidação automática, e que perde contexto após compactação. Usuários reclamam que o agente "esquece" decisões, repete perguntas, e não consegue recuperar informações de sessões anteriores.

### A Solução
**Supermem** é o upgrade de memória para o OpenClaw. Transforma Markdown plano em um sistema com:
- **Busca inteligente** — encontra qualquer informação por palavra-chave em <1 segundo
- **Consolidação automática** — IA local extrai fatos das conversas diárias e organiza em arquivos curados
- **Contexto que nunca se perde** — recovery automático após compactação, sem perder thread
- **Diário visual** — sync automático com Notion para acompanhamento humano

### Tagline
> "Seu agente OpenClaw esquece tudo depois de 3 conversas? Supermem é o upgrade de memória que ele precisa."

### Posicionamento
- **Não é outro agente** — é um upgrade para o agente que você já tem
- **Não precisa de GPU** — roda em qualquer VPS com 4GB+ de RAM
- **Não precisa de API paga** — usa Ollama local (custo zero)
- **First-mover em PT-BR** — zero concorrentes no mercado brasileiro

---

## 2. Público-Alvo

### Primário: Usuários técnicos do OpenClaw (Tier A/B)
- Já têm OpenClaw rodando em VPS ou local
- Sabem usar terminal, SSH, Node.js
- Frustrados com a memória padrão
- Querem: plug-and-play, instalar em 30min, funcionar sozinho

### Secundário: Curiosos de IA / Iniciantes OpenClaw (Tier C)
- Ouviram falar do OpenClaw, querem montar um agente pessoal
- Conhecimento técnico básico (sabem usar terminal, mas precisam de guia)
- Querem: passo a passo completo, suporte quando travar
- Dispostos a pagar mais por segurança de ter ajuda

---

## 3. Tiers e Preços

| Tier | Nome | Preço | Para quem |
|---|---|---|---|
| **A** | Kit Técnico | **R$147** | Dev que só precisa do código |
| **B** | Kit Completo | **R$197** | Quer vídeo e perfis prontos |
| **C** | Kit + Suporte | **R$227** | Quer ajuda na instalação (1 semana) |
| — | Suporte adicional | **R$30/semana** | Renovação pós Tier C |

### Margem esperada
- Custo de produção: ~R$0 (já está construído)
- Custo de suporte Tier C: ~R$0 (chatbot AI + Nox responde emails)
- Hotmart fee: ~9.9% + R$1.00/venda
- **Margem líquida: ~90%**

---

## 4. Conteúdo do Produto

### Tier A — Kit Técnico (R$147)

```
NOX-Supermem/
├── README.md                        — boas-vindas, índice, requisitos
├── GUIA-INSTALACAO.pdf              — passo a passo visual (15 páginas)
│                                      Capa profissional, screenshots de cada etapa,
│                                      comandos com copy-paste, troubleshooting inline
├── install.sh                       — instalação automatizada
│                                      1 comando: curl | bash
│                                      Instala SQLite, Ollama, inotify-tools,
│                                      cria projeto nox-mem, compila, configura systemd
├── nox-mem/                         — código fonte completo
│   ├── src/
│   │   ├── index.ts                 — CLI (8 comandos)
│   │   ├── db.ts                    — SQLite + FTS5 + migrações
│   │   ├── ingest.ts                — chunking markdown + indexação
│   │   ├── search.ts                — busca FTS5 + boost + recência
│   │   ├── primer.ts                — recovery pós-compactação
│   │   ├── consolidate.ts           — extração IA via Ollama
│   │   ├── notion-sync.ts           — sync com Notion (opcional)
│   │   ├── digest.ts                — resumo semanal
│   │   ├── reindex.ts               — rebuild do índice
│   │   └── stats.ts                 — estatísticas
│   ├── prompts/
│   │   ├── consolidate.txt          — prompt de extração de fatos (PT-BR)
│   │   └── digest.txt               — prompt de resumo semanal (PT-BR)
│   ├── nox-mem-watch.sh             — file watcher com debounce
│   ├── nox-mem-watcher.service      — unit systemd pronto
│   ├── package.json
│   └── tsconfig.json
├── templates/                       — templates Markdown prontos para uso
│   ├── SOUL.md                      — personalidade do agente (customizável)
│   ├── MEMORY.md                    — índice de memória com ciclo explicado
│   ├── TOOLS.md                     — documentação de ferramentas
│   ├── HEARTBEAT.md                 — checklist proativo configurável
│   ├── IDENTITY.md                  — identidade do agente
│   └── SESSION-STATE.md             — estado de sessão (WAL protocol)
└── LICENSE.md                       — uso pessoal, não redistribuir
```

### Tier B — Kit Completo (R$197)

Tudo do Tier A, mais:

```
├── video/
│   └── ACESSO-VIDEO.md              — link privado (YouTube unlisted ou Vimeo)
│                                      Vídeo 30-60min: setup do zero ao funcionando
│                                      - Criar VPS na Hostinger
│                                      - Rodar install.sh
│                                      - Testar busca, primer, consolidação
│                                      - Configurar crons
│                                      - Mostrar resultado no Notion
├── perfis/
│   ├── assistente-pessoal/
│   │   ├── SOUL.md                  — agente de produtividade (agenda, tarefas, emails)
│   │   ├── HEARTBEAT.md             — checks de agenda e pendências
│   │   └── README.md                — como usar este perfil
│   ├── pesquisador/
│   │   ├── SOUL.md                  — agente de deep research
│   │   ├── HEARTBEAT.md             — checks de feeds e papers
│   │   └── README.md
│   └── financeiro/
│       ├── SOUL.md                  — agente de análise financeira
│       ├── HEARTBEAT.md             — checks de mercado e alertas
│       └── README.md
└── troubleshooting/
    └── FAQ.md                       — 20+ problemas comuns com solução
                                       "Ollama não inicia" → solução
                                       "FTS5 not found" → solução
                                       "Consolidação trava" → solução
                                       etc.
```

### Tier C — Kit + Suporte (R$227)

Tudo do Tier B, mais:

```
└── suporte/
    ├── ACESSO-SUPORTE.md            — instruções de acesso ao suporte
    │                                  - Link do chatbot AI (24/7)
    │                                  - Email de suporte (respondido pelo Nox)
    │                                  - Validade: 7 dias a partir da compra
    │                                  - Renovação: R$30/semana via Hotmart
    └── CHATBOT-INFO.md              — o que o chatbot sabe responder
```

---

## 5. Comunicação e Branding

### Nome
**NOX-Supermem** — "Supermem" é a estrela. Nox é o agente que usa.

### Identidade Visual
- **Cores:** Preto + roxo/violeta elétrico (remete a cérebro/IA/memória)
- **Ícone:** Cérebro com circuito ou chip de memória estilizado
- **Tom:** Direto, técnico mas acessível, sem enrolação

### Copy Principal (Landing Page Hotmart)

**Headline:**
> ⚡ Supermem — O Upgrade de Memória do seu Agente OpenClaw

**Subheadline:**
> Seu agente esquece decisões, repete perguntas e perde contexto? Supermem resolve. Busca inteligente, consolidação com IA local, e memória que nunca se perde.

**Bullet Points:**
- 🔍 **Busca em <1 segundo** — encontre qualquer decisão, lição ou conversa por palavra-chave
- 🧠 **Consolidação automática com IA** — Ollama local extrai fatos e organiza sem custo de API
- 🔄 **Recovery pós-compactação** — seu agente nunca mais pergunta "onde estávamos?"
- 📊 **Sync com Notion** — diário visual automático das decisões e aprendizados
- ⚡ **Instala em 30 minutos** — 1 comando, funciona sozinho 24/7
- 💰 **Custo zero de operação** — sem API paga, sem servidor extra, roda na sua VPS

**Prova Social (quando tiver):**
> "Meu agente processa 14 daily notes e 500+ chunks de memória. Nunca mais esqueceu nada." — Toto, criador do Supermem

### Copy para Instagram Ads

**Formato:** Reels de 30-60s

**Hook (primeiros 3 segundos):**
> "Seu agente OpenClaw esquece tudo que você fala?"

**Corpo:**
> "Eu resolvi isso com o Supermem — um sistema de memória que transforma Markdown em busca inteligente. Meu agente agora tem 500 chunks indexados, consolida aprendizados sozinho com IA local, e nunca mais perdeu contexto depois de compactação. O setup leva 30 minutos. Link na bio."

**CTA:**
> "Link na bio — Kit a partir de R$147"

### SEO / Google Keywords

- "openclaw memória"
- "openclaw esquece contexto"
- "como melhorar memória openclaw"
- "openclaw memory system"
- "agente ai memória persistente"
- "openclaw setup brasil"
- "openclaw dicas português"

---

## 6. Infraestrutura de Suporte

### Chatbot AI (Tier C)

**Plataforma:** Typebot (gratuito até 200 chats/mês) ou Chatbase ($19/mês se crescer)

**Base de conhecimento:**
- Upload: GUIA-INSTALACAO.pdf + FAQ.md + README.md + todos os .md do produto
- Prompt do chatbot: "Você é o assistente de suporte do NOX-Supermem. Responda perguntas sobre instalação e configuração do sistema de memória para OpenClaw. Se não souber, diga para enviar email para suporte@[dominio].com.br"

**Fluxo:**
```
Cliente trava na instalação
    → Acessa chatbot (link no ACESSO-SUPORTE.md)
    → Chatbot responde com base nos docs
    → Se não resolver → "Envie email para suporte@..."
    → Nox lê email via gog
    → Nox responde com base nos docs do produto
    → Se não resolver → escala pro Toto
```

### Email de Suporte

**Endereço:** suporte@generantis.com.br (ou domínio dedicado)
**Processamento:** Nox monitora via `gog` (cron email-check existente)
**SLA:** Resposta em até 24h (Nox responde na maioria dos casos em minutos)

### Renovação de Suporte

**Hotmart:** Criar produto separado "Suporte Supermem — Semana Adicional" a R$30
**Acesso:** Após pagamento, Hotmart envia email com link atualizado do chatbot (token renovado)

---

## 7. Distribuição e Marketing

### Canais

| Canal | Estratégia | Investimento |
|---|---|---|
| **Instagram** | Reels educativos sobre OpenClaw + memória. 2-3/semana. CTA pra Hotmart. | R$0-500/mês (ads opcionais) |
| **Google** | SEO com blog posts: "como melhorar memória OpenClaw", "openclaw setup português" | R$0 (orgânico) |
| **YouTube** | Vídeos tutorial de 5-10min mostrando o problema e a solução | R$0 |
| **Reddit/Twitter** | Posts em r/openclaw, r/AIAgents, Twitter com demos | R$0 |
| **Hotmart Marketplace** | Listagem orgânica no marketplace da Hotmart | R$0 (fee na venda) |

### Funil

```
Conteúdo educativo (Instagram/YouTube/Blog)
    → "Quer resolver? Link na bio"
    → Landing page Hotmart
    → Checkout (R$147 / R$197 / R$227)
    → Email com ZIP + acesso
    → (Tier C) 1 semana de chatbot + email Nox
    → Upsell: "Quer mais uma semana? R$30"
```

### Métricas de Sucesso

| Métrica | Meta (3 meses) |
|---|---|
| Vendas Tier A | 30/mês |
| Vendas Tier B | 15/mês |
| Vendas Tier C | 10/mês |
| Renovação suporte | 5/mês |
| **Receita mensal** | **~R$8.000/mês** |
| Taxa suporte escalado pra Toto | <10% |

---

## 8. Entregáveis para Lançamento

### O que precisa ser criado

| # | Entregável | Tipo | Prioridade |
|---|---|---|---|
| 1 | `install.sh` — script de instalação automatizada | Código | Alta |
| 2 | `GUIA-INSTALACAO.pdf` — passo a passo visual 15pg | Design + Copy | Alta |
| 3 | Templates genéricos (SOUL.md, MEMORY.md, etc.) | Conteúdo | Alta |
| 4 | `README.md` — boas-vindas e índice do kit | Copy | Alta |
| 5 | `LICENSE.md` — termos de uso | Legal | Alta |
| 6 | Landing page Hotmart | Copy + Design | Alta |
| 7 | 3 perfis de agente (assistente, pesquisador, financeiro) | Conteúdo | Média |
| 8 | `FAQ.md` — troubleshooting 20+ problemas | Conteúdo | Média |
| 9 | Vídeo walkthrough (30-60min) | Gravação | Média |
| 10 | Setup chatbot (Typebot/Chatbase) | Config | Média |
| 11 | Config email suporte no Nox | Config | Média |
| 12 | 3 Reels Instagram | Gravação/Edição | Baixa |
| 13 | 2 blog posts SEO | Copy | Baixa |
| 14 | Logo/ícone Supermem | Design | Baixa |

### O que já está pronto (reusar do projeto nox-mem)

- Todo o código `src/*.ts` — limpar credenciais, genericizar paths
- Prompts de consolidação e digest
- `nox-mem-watch.sh` e `nox-mem-watcher.service`
- `package.json` e `tsconfig.json`
- Spec técnico completo (referência interna)

---

## 9. Genericização do Código

O código atual tem paths hardcoded para `/root/.openclaw/workspace/`. Para o produto:

| Atual (hardcoded) | Produto (configurável) |
|---|---|
| `/root/.openclaw/workspace` | `$OPENCLAW_WORKSPACE` (detectado automaticamente) |
| Notion database ID fixo | Configurável via `config.json` ou removido |
| `llama3.2:3b` fixo | Configurável (qualquer modelo Ollama) |
| Token Notion hardcoded | Opcional, configurável |

O `install.sh` detecta o workspace automaticamente:
```bash
WORKSPACE="${OPENCLAW_WORKSPACE:-$(openclaw config get workspace 2>/dev/null || echo ~/.openclaw/workspace)}"
```

---

## 10. Não-objetivos

- Não vender código-fonte do Nox (time de agentes) — isso é proprietário
- Não dar suporte a plataformas fora do OpenClaw (Claude Code, etc.) — foco
- Não criar versão em inglês no lançamento — foco Brasil
- Não criar comunidade Discord/Telegram no lançamento — simplificar
- Não oferecer instalação remota — o produto é self-service

---

## 11. Riscos

| Risco | Mitigação |
|---|---|
| OpenClaw muda API de memória | Supermem é add-on externo, não depende da API interna |
| Poucos compradores | Custo zero de produção — breakeven com 1 venda |
| Suporte Tier C sobrecarrega | Chatbot resolve 80%+, Nox resolve 15%, Toto só 5% |
| Alguém redistribui o ZIP | License.md proíbe, e o valor está no suporte/atualização |
| Hotmart rejeita o produto | Produto digital legítimo, sem risco de rejeição |
