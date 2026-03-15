# NOX-Supermem — Creative Brief

**Data:** 2026-03-15
**Para:** Agentes de design e comunicação
**Produto:** NOX-Supermem (kit digital, Hotmart)
**Mercado:** Brasil, PT-BR
**Tiers:** A (R$147) / B (R$197) / C (R$227)

---

## 1. COPY — LANDING PAGE HOTMART

### Headline principal
> ⚡ Seu agente OpenClaw esquece tudo depois de 3 conversas?

### Subheadline
> **Supermem é o upgrade de memória que ele precisa.**
> Busca inteligente, IA local que consolida seus dados, e contexto que nunca se perde — instala em 30 minutos, funciona sozinho 24/7.

---

### 6 Bullet Points de Benefícios

- 🔍 **Busca em menos de 1 segundo** — encontre qualquer decisão, lição ou conversa por palavra-chave. Nunca mais "eu sei que discutimos isso mas não lembro onde"
- 🧠 **IA local consolida sua memória automaticamente** — Ollama roda na sua VPS às 23h e extrai fatos das conversas do dia. Sem custo de API, sem enviar dados para fora
- 🔄 **Recovery pós-compactação** — quando o agente perde o contexto, um comando (`nox-mem primer`) traz tudo de volta em 500 tokens. Acabou o "onde estávamos?"
- 📊 **Digest semanal automático** — toda domingo às 21h, a IA resume a semana: decisões, aprendizados, projetos, pendências. Você acorda segunda com o contexto completo
- ⚡ **1 comando instala tudo** — `bash install.sh` configura Node, Ollama, banco de dados, crons e watcher. Sem configuração manual linha a linha
- 💰 **Custo zero de operação** — sem assinatura de API, sem servidor extra. Roda na VPS que você já tem. Depois de instalar: R$0/mês para sempre

---

### Para quem é

**É para você se:**
- Usa OpenClaw e o agente "esquece" decisões entre sessões
- Já perdeu tempo repetindo contexto que o agente deveria saber
- Quer um agente que melhora com o tempo, não recomeça do zero
- Tem VPS Linux (ou sabe criar uma) e não tem medo de terminal

**Não é para você se:**
- Nunca usou OpenClaw
- Não tem VPS (sem servidor, não roda — mas o guia explica como criar uma)
- Quer algo sem qualquer configuração técnica

---

### O que você recebe (por tier)

#### ⚡ Tier A — Kit Técnico — R$147
> Para o dev que quer só o código e vai se virar.

- Código fonte completo (12 módulos TypeScript)
- `install.sh` — instalação em 1 comando com `--dry-run`
- Guia de instalação completo (15 seções — do zero ao funcionando)
- 6 templates prontos para o agente (SOUL, MEMORY, HEARTBEAT, IDENTITY, TOOLS, SESSION-STATE)
- Licença de uso pessoal (até 3 instalações)

#### 🧠 Tier B — Kit Completo — R$197
> Para quem quer começar rápido com perfis prontos.

Tudo do Tier A, mais:
- **3 perfis de agente prontos** — Assistente Pessoal, Pesquisador, Analista Financeiro (SOUL + HEARTBEAT + README cada)
- **FAQ com 20+ problemas resolvidos** — os erros mais comuns com solução passo a passo

#### 🛡️ Tier C — Kit + Suporte — R$227
> Para quem quer garantia de que vai funcionar.

Tudo do Tier B, mais:
- **Chatbot de suporte 24/7** — base de conhecimento com todo o produto
- **Email de suporte por 7 dias** — respondido por humano (Nox) em até 24h
- **Renovação disponível** — R$30/semana se precisar de mais tempo

---

### 3 Objeções + Resposta

**"Parece complicado demais para instalar."**
> `bash install.sh` — é literalmente um comando. O script faz tudo: instala Ollama, baixa o modelo de IA, compila o código, cria os crons e ativa o watcher. Se travar, o Tier C tem suporte direto.

**"Não sei se o OpenClaw funciona para mim."**
> O Supermem não substitui o OpenClaw — ele turboalimenta o que você já tem. Se você usa OpenClaw e sente que ele "esquece" coisas, o Supermem resolve exatamente isso.

**"R$147 para um kit digital parece caro."**
> Calcule quanto tempo você perde repetindo contexto para o agente toda semana. 2 horas/mês × R$50/hora = R$100/mês desperdiçado. O Supermem paga em 6 semanas e funciona para sempre sem mensalidade.

---

### CTAs

**Principal:**
> 🧠 Quero o Supermem agora — [Tier B por R$197]

**Secundário:**
> ⚡ Só o kit técnico — [Tier A por R$147]

**Terciário (ancoragem):**
> 🛡️ Com suporte garantido — [Tier C por R$227]

---

### Prova Social (placeholder)

> *"[DEPOIMENTO — solicitar ao primeiro comprador]*
> Meu agente processa 14 daily notes e 500+ chunks de memória. Nunca mais esqueceu nada."*
> — **[Nome], [Cargo/Cidade]**

---

## 2. EMAILS PÓS-COMPRA

### Tier A — Kit Técnico (R$147)

**Assunto:** ⚡ Seu NOX-Supermem chegou — kit técnico pronto para instalar

---

Olá!

Seu **NOX-Supermem Kit Técnico** está pronto para download.

**📦 Acesse seu kit:**
[LINK DE DOWNLOAD - HOTMART]

**O que tem dentro:**
- `install.sh` — rode isso primeiro
- `nox-mem/` — código fonte completo
- `templates/` — 6 arquivos para o seu agente
- `GUIA-INSTALACAO.md` — 15 seções do zero ao funcionando

**Próximos passos:**
1. Baixe e descompacte o ZIP
2. Acesse sua VPS via SSH
3. Suba os arquivos e rode: `bash install.sh --dry-run` (preview)
4. Se tudo parecer certo: `bash install.sh`
5. Verifique: `nox-mem doctor`

**Dúvidas?** Consulte `troubleshooting/FAQ.md` — 20+ problemas resolvidos.

Boa instalação!
*Equipe NOX-Supermem*

---

### Tier B — Kit Completo (R$197)

**Assunto:** 🧠 NOX-Supermem completo — kit + perfis + FAQ

---

Olá!

Seu **NOX-Supermem Kit Completo** está pronto.

**📦 Acesse seu kit:**
[LINK DE DOWNLOAD - HOTMART]

**O que tem dentro:**
- Tudo do Kit Técnico (código + guia + templates)
- `perfis/assistente-pessoal/` — agente de produtividade pronto
- `perfis/pesquisador/` — agente de research pronto
- `perfis/financeiro/` — agente financeiro pronto
- `troubleshooting/FAQ.md` — 20+ problemas com solução

**Próximos passos:**
1. Instale o core: `bash install.sh`
2. Escolha um perfil em `perfis/` que combine com seu uso
3. Copie o SOUL.md e HEARTBEAT.md do perfil para o seu agente
4. Personalize substituindo os placeholders `[seu nome aqui]`

**Dica:** comece com o perfil mais parecido com seu uso atual e ajuste depois. Leva 10 minutos.

Qualquer dúvida está no FAQ.

*Equipe NOX-Supermem*

---

### Tier C — Kit + Suporte (R$227)

**Assunto:** 🛡️ NOX-Supermem + Suporte ativo — 7 dias a partir de agora

---

Olá!

Seu **NOX-Supermem com Suporte** está ativo.

**📦 Acesse seu kit:**
[LINK DE DOWNLOAD - HOTMART]

**🤖 Suporte disponível agora:**
- Chatbot 24/7: [LINK DO CHATBOT] — responde dúvidas de instalação na hora
- Email: suporte@[dominio].com.br — respondido em até 24h
- **Validade:** 7 dias a partir desta compra

**Próximos passos:**
1. Baixe e comece pela `GUIA-INSTALACAO.md` — está tudo lá
2. Se travar em qualquer etapa: abra o chatbot com o erro que apareceu
3. Se o chatbot não resolver: mande email com output de `nox-mem doctor`

**Renovar suporte:** se precisar de mais tempo após os 7 dias, renove por R$30/semana no Hotmart.

Estamos aqui para garantir que funcione.

*Equipe NOX-Supermem*

---

## 3. BRAND BRIEF

### Nome
**NOX-Supermem** — "Supermem" é a estrela do produto. "NOX" é o agente que usa.

### Tagline
> "Memória que não esquece."

### Cores

| Papel | Cor | Hex |
|---|---|---|
| **Primária** | Preto profundo | `#0A0A0F` |
| **Acento principal** | Roxo elétrico | `#7C3AED` |
| **Acento secundário** | Violeta claro | `#A78BFA` |
| **Texto principal** | Branco puro | `#FFFFFF` |
| **Texto secundário** | Cinza claro | `#9CA3AF` |
| **Sucesso/OK** | Verde neon | `#10B981` |
| **Alerta** | Âmbar | `#F59E0B` |

**Gradiente principal:** `linear-gradient(135deg, #7C3AED 0%, #4F46E5 100%)`

### Tom de Voz
**3 adjetivos:** Direto. Técnico. Confiável.

- **Direto:** sem rodeios, vai ao ponto, zero fluff
- **Técnico:** sabe do que fala, usa termos corretos, não subestima o leitor
- **Confiável:** promete o que entrega, não exagera, transparente sobre limitações

**O que NÃO é:** corporativo, genérico, hype de IA

### O que o Logo deve transmitir
- Memória + tecnologia + velocidade
- Sensação de "upgrade", de algo que potencializa o que já existe
- Não deve parecer outro "assistente de IA genérico"
- Deve ter personalidade técnica — para devs e early adopters

### Referências Visuais (descrição)
1. **Chip de memória estilizado** com circuitos formando um cérebro — síntese de hardware + cognição
2. **Raio elétrico (⚡) integrado ao texto** — velocidade, energia, o "upgrade"
3. **Fundo escuro com partículas/grade** — remete a interface de terminal, espaço, dados
4. **Tipografia monospace** para elementos técnicos (comandos, versão) — identidade de dev tool

### Não fazer
- Robôs genéricos ou assistentes humanizados
- Azul corporativo (saturado no mercado de IA)
- Ilustrações infantis ou "fofinhas"
- Gradiente arco-íris colorido

---

## 4. ESPECIFICAÇÕES DO PDF (GUIA-INSTALACAO)

> O `GUIA-INSTALACAO.md` será convertido em PDF para entrega. Estas são as specs para o designer.

### Formato
- **Tamanho:** A4 (210×297mm) ou Letter
- **Orientação:** Retrato
- **Margens:** 25mm todas as bordas
- **Colunas:** 1 coluna (guia sequencial)

### Paleta do PDF
- **Fundo:** `#FFFFFF` (branco — imprimível)
- **Texto:** `#111827` (quase preto)
- **Destaques:** `#7C3AED` (roxo — headings principais)
- **Caixas de comando:** `#F3F4F6` (cinza claro) com borda `#E5E7EB`
- **Caixas de alerta/dica:** `#FEF3C7` fundo + `#92400E` texto
- **Caixas de sucesso:** `#D1FAE5` fundo + `#065F46` texto

### Hierarquia Tipográfica
| Elemento | Fonte | Tamanho | Peso |
|---|---|---|---|
| Título do documento | Sans-serif (Inter/Poppins) | 28pt | Bold |
| Seção (H1) | Sans-serif | 20pt | Bold, roxo |
| Subseção (H2) | Sans-serif | 15pt | SemiBold |
| Corpo | Sans-serif | 11pt | Regular |
| Comandos/código | Monospace (JetBrains Mono/Fira Code) | 10pt | Regular |
| Legenda | Sans-serif | 9pt | Regular, cinza |

### Estrutura Página a Página

**Capa (p.1)**
- Logo NOX-Supermem centralizado
- Título: "Guia de Instalação"
- Subtítulo: "Do zero ao agente com memória inteligente em 30 minutos"
- Versão + data
- Fundo escuro (`#0A0A0F`) com acento roxo

**Índice (p.2)**
- Lista das 15 seções com número de página
- Divisão visual: Parte 1 (OpenClaw) e Parte 2 (SuperMem)

**Visão Geral (p.3)**
- Diagrama visual do fluxo completo (ASCII art estilizado ou ícones simples)
- Caixa "Se você já tem OpenClaw → pule para Seção 6"

**Parte 1 — Seções 1-5 (pp.4-8)**
- Uma seção por página quando possível
- Cada seção: ícone de número + título + corpo + bloco de comandos + "output esperado"
- Caixa de alerta para pré-requisitos

**Parte 2 — Seções 6-15 (pp.9-18)**
- Seção 6 (install.sh): página inteira — é o passo mais importante
- Caixa destacada: "O que acontece automaticamente" (lista numerada)
- Screenshot placeholder por seção (marcado com [SCREENSHOT])
- Caixas verdes para "output esperado ✅"
- Caixas amarelas para "se aparecer este erro → solução"

**Contracapa (última página)**
- Comandos rápidos de referência (tabela)
- Links de suporte por tier
- Logo + tagline

### Elementos Recorrentes

**Bloco de comando** (toda vez que houver código a executar):
```
┌─────────────────────────────────┐
│ $ bash install.sh               │
└─────────────────────────────────┘
```
Fundo cinza claro, fonte monospace, ícone de terminal (›_)

**Caixa de Output Esperado:**
Borda verde esquerda + fundo verde muito claro + texto `✅ Output esperado:`

**Caixa de Alerta:**
Borda amarela esquerda + fundo amarelo muito claro + ícone ⚠️

**Caixa de Dica:**
Borda roxa esquerda + fundo lilás muito claro + ícone 💡

**Separador de parte:**
Página inteira com fundo roxo escuro, texto branco: "PARTE 2 — SUPERMEM: O UPGRADE DE MEMÓRIA"
