# Story WSB-5.2: Rotinas Agendadas

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-5.2
**Priority:** Medium
**Status:** In Progress
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 5 — Radar + Empacotamento

## User Story

**Como** usuário,
**Quero** rotinas agendadas (re-index noturno, digest diário, radar semanal/mensal) com entrega opcional no Telegram,
**Para** que o cérebro se mantenha atualizado e me informe sem eu lembrar de rodar nada.

## Acceptance Criteria

- [ ] AC1: `core/routines/registry.js` — rotinas em `.aios/routines.yaml`: `{name, task (brain-index|brain-digest|radar-scan|radar-report), schedule (daily@HH:MM|weekly@DOW HH:MM|monthly@D HH:MM), notify (telegram|none), enabled}`; defaults criados no primeiro uso (index diário 03:00 desabilitado por padrão, digest diário 18:00, radar semanal seg 09:00)
- [ ] AC2: `core/routines/scheduler.js` — daemon leve (setInterval 60s, mesmo padrão do gateway): calcula próxima execução por rotina, executa a task mapeada (handlers determinísticos chamando os módulos reais), grava última execução em `.aios/routines-state.json` (sobrevive a restart — perdeu o horário → executa no próximo tick com catch-up 1x)
- [ ] AC3: Entrega: `notify: telegram` → `notifyTelegram` (REUSE do gateway) com o resumo da execução; sem token/pareados → só log
- [ ] AC4: `aios routines` CLI: `list` (tabela com próxima execução), `enable|disable <name>`, `run <name>` (execução manual imediata), `start [--daemon]|stop|status`
- [ ] AC5: Zero dependências novas; testes com fake timers: cálculo de próxima execução (daily/weekly/monthly), catch-up pós-restart, execução dispara handler certo (mockado), notify gracioso, enable/disable persiste

## File List

- `.aios-core/core/routines/registry.js` (novo)
- `.aios-core/core/routines/scheduler.js` (novo)
- `.aios-core/core/routines/cli.js` (novo)
- `.aios-core/core/routines/index.js` (novo — barrel)
- `.aios-core/core/routines/__tests__/routines.test.js` (novo)

**Fora de escopo (lead):** wiring `aios routines` no bin/aios.js.
