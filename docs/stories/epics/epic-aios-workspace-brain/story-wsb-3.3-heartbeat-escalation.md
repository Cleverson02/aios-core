# Story WSB-3.3: Heartbeat + Escalação por Surface-Criteria

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-3.3
**Priority:** High
**Status:** In Progress
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 3 — Autonomy Engine

## User Story

**Como** operador de uma sessão autônoma longa,
**Quero** um heartbeat que faz checkpoint e autoavaliação a cada N subtasks, detecta travamento (2 falhas na mesma subtask) e escala por surface-criteria,
**Para** confiar que o sistema para e me chama quando deve — e nunca roda cegamente.

## Acceptance Criteria

- [ ] AC1: `core/autonomy/heartbeat.js` — `Heartbeat({intervalSubtasks=3, cwd})` com `attach(buildLoop)` escutando os eventos REAIS do `autonomous-build-loop` (verificar nomes no código); a cada N subtasks: checkpoint (`BuildStateManager` REUSE) + avaliação de zona (ContextBudgetManager via try/catch — pode não existir; injetável por DI)
- [ ] AC2: Detecção de travamento: mesma subtask falha 2× → `escalate()` com contexto (subtask, erros, tentativa)
- [ ] AC3: `core/autonomy/escalation.js` — `escalate({reason, context, cwd})`: consulta `SurfaceChecker`/`bob-surface-criteria.yaml` (REUSE) quando aplicável; roteia para `notification-manager` (quality-gates) se disponível; SEMPRE grava `.aios/autonomy/escalations/<ts>-<slug>.md` com contexto acionável
- [ ] AC4: Sem canal de notificação → grava arquivo e retorna `{notified:false}` graciosamente; heartbeat nunca derruba o build (try/catch total)
- [ ] AC5: Zero dependências novas; testes: EventEmitter fake como build loop, intervalo N, travamento 2×, surface-criteria dispara, canal ausente gracioso, checkpoint chamado

## File List

- `.aios-core/core/autonomy/heartbeat.js` (novo)
- `.aios-core/core/autonomy/escalation.js` (novo)
- `.aios-core/core/autonomy/__tests__/heartbeat.test.js` (novo)

**Fora de escopo (lead):** barrel, `cli.js` (`aios run long`).
