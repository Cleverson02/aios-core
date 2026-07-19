# Story WSB-4.1: Gateway Telegram (bot + pareamento + comandos + notificações)

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-4.1 (consolida 4.1/4.2/4.3 do épico)
**Priority:** Critical
**Status:** In Progress
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 4 — Gateway + UX + Economia

## User Story

**Como** owner longe do computador,
**Quero** comandar e receber retornos do Cortex pelo Telegram (status, brain, aprovações de escalação) com pareamento seguro,
**Para** que a autonomia da Fase 3 escale para o meu bolso.

## Princípios

- Gateway é **cliente do CLI** (Constitution Art. I) — zero decisão própria; comandos mapeiam para handlers existentes
- **Zero tokens de LLM**: /status, /ask (brain local), /approve são 100% determinísticos
- Long polling via fetch nativo — sem servidor público, sem dependências novas

## Acceptance Criteria

- [ ] AC1: `core/gateway/telegram-client.js` — cliente da Bot API via fetch nativo (getUpdates long polling, sendMessage com inline keyboard, answerCallbackQuery); token via `TELEGRAM_BOT_TOKEN` env ou credentials store (`~/.aiox/credentials.json`, chmod 600); sem token → indisponível gracioso
- [ ] AC2: Pareamento: `aios gateway pair` gera código de 6 dígitos (TTL 5min); usuário envia o código ao bot → chat-id entra na allowlist (`~/.aiox/gateway.json`); mensagens de não-pareados são rejeitadas e logadas
- [ ] AC3: Comandos: `/status` (builds+zonas via autonomy), `/ask <pergunta>` (brain search local com fontes — sem LLM), `/handoffs`, `/approve <id>` e `/reject <id>` com botões inline sobre escalações pendentes, `/report` (digest do dia)
- [ ] AC4: Canal de notificação: `notifyTelegram({title, body, buttons})` exportado + watcher de `.aios/autonomy/escalations/` (novos arquivos → notificação com botões approve/reject); decisão gravada em `.aios/autonomy/escalations/<id>.decision.json` para o heartbeat/orquestrador consumir
- [ ] AC5: `aios gateway start|stop|pair|status` (daemon via processo em foreground ou `--daemon` com pid file); nunca crasha por erro de rede (retry com backoff)
- [ ] AC6: Segurança: allowlist obrigatória, ações de escrita exigem confirmação (botão), tudo logado em `.aios/gateway/log.jsonl`; zero requests sem token (testado com fetch mockado)
- [ ] AC7: Testes com fetch mockado: pareamento, comando de não-pareado rejeitado, /status, /ask, approve→decision.json, watcher de escalações, backoff em erro de rede; ZERO rede real na suíte

## File List

- `.aios-core/core/gateway/telegram-client.js` (novo)
- `.aios-core/core/gateway/pairing.js` (novo)
- `.aios-core/core/gateway/commands.js` (novo)
- `.aios-core/core/gateway/escalation-watcher.js` (novo)
- `.aios-core/core/gateway/cli.js` (novo)
- `.aios-core/core/gateway/index.js` (novo — barrel)
- `.aios-core/core/gateway/__tests__/gateway.test.js` (novo)

**Fora de escopo (lead):** wiring `aios gateway` no bin/aios.js.
