# Story WSB-5.2: Rotinas Agendadas

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-5.2
**Priority:** Medium
**Status:** Ready for Review
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 5 — Radar + Empacotamento

## User Story

**Como** usuário,
**Quero** rotinas agendadas (re-index noturno, digest diário, radar semanal/mensal) com entrega opcional no Telegram,
**Para** que o cérebro se mantenha atualizado e me informe sem eu lembrar de rodar nada.

## Acceptance Criteria

- [x] AC1: `core/routines/registry.js` — rotinas em `.aios/routines.yaml`: `{name, task (brain-index|brain-digest|radar-scan|radar-report), schedule (daily@HH:MM|weekly@DOW HH:MM|monthly@D HH:MM), notify (telegram|none), enabled}`; defaults criados no primeiro uso (index diário 03:00 desabilitado por padrão, digest diário 18:00, radar semanal seg 09:00)
- [x] AC2: `core/routines/scheduler.js` — daemon leve (setInterval 60s, mesmo padrão do gateway): calcula próxima execução por rotina, executa a task mapeada (handlers determinísticos chamando os módulos reais), grava última execução em `.aios/routines-state.json` (sobrevive a restart — perdeu o horário → executa no próximo tick com catch-up 1x)
- [x] AC3: Entrega: `notify: telegram` → `notifyTelegram` (REUSE do gateway) com o resumo da execução; sem token/pareados → só log
- [x] AC4: `aios routines` CLI: `list` (tabela com próxima execução), `enable|disable <name>`, `run <name>` (execução manual imediata), `start [--daemon]|stop|status`
- [x] AC5: Zero dependências novas; testes com fake timers: cálculo de próxima execução (daily/weekly/monthly), catch-up pós-restart, execução dispara handler certo (mockado), notify gracioso, enable/disable persiste

## File List

- `.aios-core/core/routines/registry.js` (novo)
- `.aios-core/core/routines/scheduler.js` (novo)
- `.aios-core/core/routines/cli.js` (novo)
- `.aios-core/core/routines/index.js` (novo — barrel)
- `.aios-core/core/routines/__tests__/routines.test.js` (novo)

**Fora de escopo (lead):** wiring `aios routines` no bin/aios.js.

## Dev Agent Record

### Agent Model Used

Opus 4.8 (1M) — @dev (Dex)

### Implementation Notes

- **IDS**: SEARCH → nenhum módulo de scheduling/rotinas existente em `.aios-core/core`. Reuse de padrões reais: daemon pid+setInterval do `core/gateway/cli.js`, watcher `escalation-watcher.js`, `notifyTelegram` do `core/gateway/index.js` (AC3, sem reimplementação), `BrainIndexer`/`generateDigest` de `core/brain`. DECIDE → CREATE `core/routines/*` (novo domínio), REUSE dos módulos-alvo via require lazy.
- **`nextRunAt` puro e determinístico** (sem I/O): daily/weekly/monthly em horário local, sempre estritamente após `from`. Monthly faz clamp do dia para meses curtos (`monthly@31` → Fev 28/29). Testado com datas conhecidas + `from` injetado (não precisa de fake timers por ser puro; catch-up controlado via `lastRunAt` semeado e `now` injetável em `runDueRoutines`).
- **Catch-up 1x/tick**: `runDueRoutines` executa no máximo 1 vez por rotina por tick; após rodar, `lastRunAt=now` empurra o próximo slot para o futuro — vários slots perdidos nunca viram burst. `ref = lastRunAt || createdAt`, então rotina recém-criada não dispara na hora.
- **Graceful degradation total**: handlers via require lazy try/catch → módulo ausente (ex.: `core/radar` do agente paralelo) retorna `{ok:false, reason:'radar-module-unavailable'}` sem throw; radar tenta API programática (`runScan`/`runReport`) e cai para `radarCommand([sub])`. `notify:telegram` sem token → só log. Estado/log são best-effort (nunca quebram o scheduler).
- **Daemon**: `.aios/routines.pid` (conforme AC4, no cwd — diferente do gateway que usa `~/.aiox`), self-spawn detached idêntico ao gateway. Foreground usa `unref:false` para manter o loop vivo; `startScheduler` unrefs por padrão (testes/uso embutido não bloqueiam o exit).
- **[AUTO-DECISION]** API do radar ainda não definida (WSB-5.1 paralelo) → handler tenta `runScan/runReport` e depois `radarCommand`, degradando a `{ok:false}` (reason: contrato do radar desconhecido; mantém a task resiliente ao merge).
- Zero dependências novas: `fs`/`path`/`child_process` nativos + `js-yaml`/`chalk` já presentes.

### File List

- `.aios-core/core/routines/registry.js` (novo)
- `.aios-core/core/routines/scheduler.js` (novo)
- `.aios-core/core/routines/cli.js` (novo)
- `.aios-core/core/routines/index.js` (novo — barrel)
- `.aios-core/core/routines/__tests__/routines.test.js` (novo)
- `docs/stories/epics/epic-aios-workspace-brain/story-wsb-5.2-routines.md` (atualizado)

### Validation

- `npx jest .aios-core/core/routines --silent` → **24 passed, 1 suite**.
- `npx eslint .aios-core/core/routines/` → **0 problemas**.
- `routinesCommand(['list'])` em cwd tmp recém-inicializado renderiza os 3 defaults com próxima execução calculada.

### Change Log

| Data | Mudança |
|------|---------|
| 2026-07-19 | Implementação WSB-5.2: registry + scheduler + cli + barrel + testes. AC1-AC5 completos. |
