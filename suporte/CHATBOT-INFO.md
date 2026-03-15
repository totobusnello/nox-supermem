# O que o Chatbot Sabe Responder

## ✅ Dentro do escopo

- Instalação do NOX-Supermem (todas as etapas do install.sh)
- Instalação do OpenClaw e Node.js
- Configuração do Ollama e modelos
- Todos os comandos do nox-mem (search, primer, consolidate, etc.)
- Problemas do FAQ (20+ cenários)
- Interpretação de erros comuns
- Configuração do config.json
- Crons e watcher systemd

## ❌ Fora do escopo

- Suporte ao OpenClaw em si (funcionalidades além do SuperMem)
- Configuração de outros plugins do OpenClaw
- Problemas específicos de VPS (firewall, DNS, etc.)
- Desenvolvimento de código personalizado
- Integração com Notion (não incluso neste produto)

## Quando escalar para email

Se o chatbot não resolver em 2-3 tentativas, envie email com:
- Output de `nox-mem doctor`
- Log de `/tmp/nox-supermem-install.log`
- Print do erro
