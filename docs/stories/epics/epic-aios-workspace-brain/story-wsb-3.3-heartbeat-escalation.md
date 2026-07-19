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

- [x] AC1: `core/autonomy/heartbeat.js` — `Heartbeat({intervalSubtasks=3, cwd})` com `attach(buildLoop)` escutando os eventos REAIS do `autonomous-build-loop` (verificar nomes no código); a cada N subtasks: checkpoint (`BuildStateManager` REUSE) + avaliação de zona (ContextBudgetManager via try/catch — pode não existir; injetável por DI)
- [x] AC2: Detecção de travamento: mesma subtask falha 2× → `escalate()` com contexto (subtask, erros, tentativa)
- [x] AC3: `core/autonomy/escalation.js` — `escalate({reason, context, cwd})`: consulta `SurfaceChecker`/`bob-surface-criteria.yaml` (REUSE) quando aplicável; roteia para `notification-manager` (quality-gates) se disponível; SEMPRE grava `.aios/autonomy/escalations/<ts>-<slug>.md` com contexto acionável
- [x] AC4: Sem canal de notificação → grava arquivo e retorna `{notified:false}` graciosamente; heartbeat nunca derruba o build (try/catch total)
- [x] AC5: Zero dependências novas; testes: EventEmitter fake como build loop, intervalo N, travamento 2×, surface-criteria dispara, canal ausente gracioso, checkpoint chamado

## File List

- `.aios-core/core/autonomy/heartbeat.js` (novo)
- `.aios-core/core/autonomy/escalation.js` (novo)
- `.aios-core/core/autonomy/__tests__/heartbeat.test.js` (novo)

**Fora de escopo (lead):** barrel, `cli.js` (`aios run long`).

## Dev Agent Record

**Agent:** @dev (Dex) — Builder
**Model:** claude-opus-4-8[1m]
**Status:** Ready for Review

### Eventos REAIS do build loop consumidos

Confirmados em `.aios-core/core/execution/autonomous-build-loop.js` (enum `BuildEvent`):

| Evento | Payload real | Uso no Heartbeat |
|--------|-------------|------------------|
| `build_started` | `{ storyId, startTime, config, resuming }` | Captura `storyId` |
| `subtask_completed` | `{ subtaskId, iteration, duration, filesModified }` | Incrementa contador; pulse a cada N |
| `iteration_completed` | `{ subtaskId, iteration, success, error }` | **Sinal de falha por tentativa** (`success:false`) → detecção de travamento |
| `subtask_failed` | `{ subtaskId, attempts, error }` | Terminal (após maxIterations). NÃO usado p/ travamento (re-emitido como `subtask_terminal_failure`) |

Decisão: contamos falhas via `iteration_completed` (`success===false`) porque é o evento genuíno **por tentativa**; `subtask_failed` só dispara após esgotar `maxIterations`, tarde demais para o "2× na mesma subtask".

### Estratégia de checkpoint (colisão evitada — documentada)

O build loop já persiste checkpoint via `BuildStateManager.completeSubtask()` a cada subtask concluída. Para evitar entradas duplicadas/colisão em `completedSubtasks`, o Heartbeat:
1. SEMPRE grava seu próprio marcador em `.aios/autonomy/heartbeats.json` (`{timestamp, storyId, subtasks, subtaskId}`).
2. Só chama `BuildStateManager.saveCheckpoint()` quando o `state` carregado NÃO contém o `subtaskId` (i.e. execução standalone sem o checkpoint do loop). REUSE de `BuildStateManager` (Story 8.4).

### IDS (Search → Decide → Log)

| Arquivo | Decisão | Justificativa |
|---------|---------|---------------|
| `heartbeat.js` | ADAPT/REPLACE | Existia um `HeartbeatMonitor` (API `recordSubtask`) diferente da spec; reescrito para `Heartbeat extends EventEmitter` com `attach/detach/getStats`. Mantidos exports back-compat (`HeartbeatMonitor: Heartbeat`, `DEFAULT_INTERVAL`, `DEFAULT_STUCK_THRESHOLD`) p/ o barrel/`cli.js` do lead não quebrarem. |
| `escalation.js` | CREATE | Não existia. |
| `__tests__/heartbeat.test.js` | CREATE | Não existia (dir `__tests__` novo). |
| `BuildStateManager` (8.4) | REUSE | Checkpoint colisão-safe. |
| `SurfaceChecker` + `bob-surface-criteria.yaml` (11.4) | REUSE (consume) | `createSurfaceChecker`/`shouldSurface`; `attempts` → `errors_in_task` dispara C004. |
| `NotificationManager` (3.5) | REUSE (consume) | `sendBlockingNotification({stoppedAt, reason, issues, fixFirst})`. |
| `ContextBudgetManager` (WSB-3.1) | REUSE (consume, DI) | `evaluate({percentUsed})` p/ avaliação de zona. |

### Notas de conclusão

- Zero dependências novas; CommonJS + JSDoc.
- **AC4 (nunca derruba o build):** todos os handlers de evento são `try/catch` total; escalate rejeitado/lançado é engolido; `_writeMarker`/checkpoint/zone falham silenciosamente.
- **Avaliação de zona:** só ocorre quando o payload traz `percentUsed`/`contextPercent` (paylods reais do loop não trazem → pulado, documentado). `budgetManager` injetável por DI; default lazy `require('./context-budget-manager')` (null se ausente).
- **Compat lead:** `cli.js` usa apenas `HeartbeatMonitor` (re-export) + `DEFAULT_INTERVAL`/`DEFAULT_STUCK_THRESHOLD` (constantes) — sem `.recordSubtask()`. Barrel + cli carregam sem erro (verificado). **Ação p/ o lead:** ao ligar o `aios run long`, instanciar `new Heartbeat({intervalSubtasks, cwd, storyId})` e `heartbeat.attach(buildLoop)`; a API mudou de `recordSubtask()` para orientada a eventos.
- Testes: **19 passando** (`npx jest .aios-core/core/autonomy/__tests__/heartbeat.test.js --silent`). ESLint limpo nos 3 arquivos.

### File List

- `.aios-core/core/autonomy/heartbeat.js` (reescrito)
- `.aios-core/core/autonomy/escalation.js` (novo)
- `.aios-core/core/autonomy/__tests__/heartbeat.test.js` (novo)

### Change Log

| Data | Mudança |
|------|---------|
| 2026-07-19 | Implementação WSB-3.3: `Heartbeat` (EventEmitter, attach/detach/getStats), `escalate()` com surface-check + notificação + registro em arquivo, 19 testes. |
