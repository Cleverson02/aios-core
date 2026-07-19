# Story WSB-4.1: Gateway Telegram (bot + pareamento + comandos + notificações)

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-4.1 (consolida 4.1/4.2/4.3 do épico)
**Priority:** Critical
**Status:** Ready for Review
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

- [x] AC1: `core/gateway/telegram-client.js` — cliente da Bot API via fetch nativo (getUpdates long polling, sendMessage com inline keyboard, answerCallbackQuery); token via `TELEGRAM_BOT_TOKEN` env ou credentials store (`~/.aiox/credentials.json`, chmod 600); sem token → indisponível gracioso
- [x] AC2: Pareamento: `aios gateway pair` gera código de 6 dígitos (TTL 5min); usuário envia o código ao bot → chat-id entra na allowlist (`~/.aiox/gateway.json`); mensagens de não-pareados são rejeitadas e logadas
- [x] AC3: Comandos: `/status` (builds+zonas via autonomy), `/ask <pergunta>` (brain search local com fontes — sem LLM), `/handoffs`, `/approve <id>` e `/reject <id>` com botões inline sobre escalações pendentes, `/report` (digest do dia)
- [x] AC4: Canal de notificação: `notifyTelegram({title, body, buttons})` exportado + watcher de `.aios/autonomy/escalations/` (novos arquivos → notificação com botões approve/reject); decisão gravada em `.aios/autonomy/escalations/<id>.decision.json` para o heartbeat/orquestrador consumir
- [x] AC5: `aios gateway start|stop|pair|status` (daemon via processo em foreground ou `--daemon` com pid file); nunca crasha por erro de rede (retry com backoff)
- [x] AC6: Segurança: allowlist obrigatória, ações de escrita exigem confirmação (botão), tudo logado em `.aios/gateway/log.jsonl`; zero requests sem token (testado com fetch mockado)
- [x] AC7: Testes com fetch mockado: pareamento, comando de não-pareado rejeitado, /status, /ask, approve→decision.json, watcher de escalações, backoff em erro de rede; ZERO rede real na suíte

## File List

- `.aios-core/core/gateway/telegram-client.js` (novo)
- `.aios-core/core/gateway/pairing.js` (novo)
- `.aios-core/core/gateway/commands.js` (novo)
- `.aios-core/core/gateway/escalation-watcher.js` (novo)
- `.aios-core/core/gateway/cli.js` (novo)
- `.aios-core/core/gateway/index.js` (novo — barrel)
- `.aios-core/core/gateway/__tests__/gateway.test.js` (novo)

**Fora de escopo (lead):** wiring `aios gateway` no bin/aios.js.

---

## Dev Agent Record

### Agent Model Used

Dex (Builder) — @dev — Opus 4.8 (1M context)

### IDS Decisions (search-first → reuse/adapt/create)

| Alvo | Decisão | Justificativa |
|------|---------|---------------|
| Status de builds/zonas (`/status`) | REUSE | `BuildStateManager.formatAllBuilds(cwd)` + leitura de `.aios/autonomy/zone-log.json` — mesmas fontes do `autonomy/cli.js`. ANSI stripado para o Telegram. |
| Busca local (`/ask`) | REUSE | `BrainIndexer.search(query, {limit:3})` — busca léxica, zero LLM, com fonte (file/heading/area). |
| Digest (`/report`) | REUSE | `generateDigest({cwd, dryRun:true})` — sumário do dia sem gravar nada. |
| Formato de escalação/decisão | ADAPT | Consome os `.md` de `.aios/autonomy/escalations/` (convenção de `autonomy/escalation.js`) e grava `<id>.decision.json` no mesmo diretório para o heartbeat/orquestrador consumir. |
| Watcher de arquivos | CREATE | `setInterval + readdir + mtime` (sem chokidar/fs.watch) — cadência humana, diretório minúsculo, princípio zero-deps. Justificativa documentada no cabeçalho do módulo. |
| Cliente HTTP | CREATE | `fetch` nativo + `AbortController` + backoff — zero deps novas. |

### Completion Notes

- **Zero deps novas, CommonJS + JSDoc**, degradação graciosa em todos os caminhos; o token nunca é logado (nem em URL nem em erro).
- **Gateway = cliente do CLI (Art. I):** todos os comandos mapeiam para handlers/módulos existentes; nenhum token de LLM é gasto (`/status`, `/ask`, `/approve`, `/report` são 100% determinísticos).
- **AC6 — zero requests sem token:** `_request` lança antes de qualquer `fetch` quando `!isAvailable()`; coberto por teste que verifica `fetch` não chamado.
- **Backoff:** rede/abort/5xx → `1s→2s→4s→…→30s` (máx 5 retries); HTTP 4xx nunca reprocessa. Testado via `sleep` injetado (sequência `[1000,2000,4000]`).
- **Segurança:** allowlist obrigatória; ações de escrita (approve/reject) confirmadas por botão inline; tudo em `.aios/gateway/log.jsonl` (apenas a primeira palavra do comando é logada — privacidade).
- **Isolamento de testes:** `global.fetch` sempre mockado (default reject 'unexpected real fetch'); `HOME` fake + `os.homedir()` espionado → nenhuma escrita em `~/.aiox` real (verificado). 22 testes, 0 rede real.
- **Daemon:** `--daemon` re-spawna cópia detached de si mesmo (`node cli.js start`) com pid em `~/.aiox/gateway.pid`; `require.main === module` guarda a auto-execução.
- **Gotcha registrada:** `os.homedir()` não observa `process.env.HOME` mutado em runtime (jest) — módulos passaram a usar `homeDir || process.env.HOME || os.homedir()`; consumidores externos (BrainIndexer) exigem `jest.spyOn(os,'homedir')` para isolamento.

### File List

- `.aios-core/core/gateway/telegram-client.js` (novo)
- `.aios-core/core/gateway/pairing.js` (novo)
- `.aios-core/core/gateway/commands.js` (novo)
- `.aios-core/core/gateway/escalation-watcher.js` (novo)
- `.aios-core/core/gateway/cli.js` (novo)
- `.aios-core/core/gateway/index.js` (novo — barrel + `notifyTelegram`)
- `.aios-core/core/gateway/__tests__/gateway.test.js` (novo — 22 testes)
- `docs/stories/epics/epic-aios-workspace-brain/story-wsb-4.1-telegram-gateway.md` (atualizado — ACs + Dev Agent Record)

### Validation

- `npx jest .aios-core/core/gateway --silent` → **22 passed, 0 failed**; zero rede real; sem poluição de `~/.aiox`.
- `npx eslint .aios-core/core/gateway` → **0 errors, 0 warnings**.

### Change Log

| Data | Versão | Descrição | Autor |
|------|--------|-----------|-------|
| 2026-07-19 | 1.0.0 | Implementação WSB-4.1 — gateway Telegram (client + pareamento + comandos determinísticos + watcher de escalação + notificações). 22 testes. | Dex (@dev) |
