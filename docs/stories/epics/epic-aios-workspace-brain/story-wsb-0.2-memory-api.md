# Story WSB-0.2: Memory API Unificada (memory-query + session-memory)

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-0.2
**Priority:** Critical (destrava SYN-10 e o Brain da Fase 1)
**Status:** In Progress
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 0 — Consolidação

## User Story

**Como** subsistemas `execution/` e `synapse/`,
**Quero** os módulos `memory-query.js` e `session-memory.js` reimplementados em `.aios-core/core/memory/`,
**Para** que o enriquecimento de contexto de subagentes e a futura camada L8 do SYNAPSE parem de cair no fallback `null` e passem a consultar memória real.

## Contexto

Os módulos foram removidos como órfãos na Story MIS-2, mas os consumidores permaneceram:

- `execution/context-injector.js` espera `MemoryQuery#query(query, {limit}) → [{type, content|summary, score|relevance}]` e `SessionMemory#getDecisions({limit}) → [{decision|content, reason, timestamp}]`
- `execution/subagent-dispatcher.js` espera `MemoryQuery#getContextForAgent(agentId, taskDescription) → {relevantMemory: [], suggestedPatterns: []}`

## Acceptance Criteria

- [x] AC1: `core/memory/memory-query.js` exporta `MemoryQuery` com `query()` e `getContextForAgent()` nos contratos acima
- [x] AC2: `core/memory/session-memory.js` exporta `SessionMemory` com `getDecisions()`, `recordDecision()`, `getSessionSummary()`
- [x] AC3: Fontes de dados locais: gotchas (`.aios/gotchas.json`), decision logs (`.ai/`), session-state (`.aios/session-state.json`), store próprio (`.aios/session-memory.json`)
- [x] AC4: `context-injector` e `subagent-dispatcher` carregam os módulos sem cair no fallback null (verificado por teste de integração)
- [x] AC5: Zero dependências novas; degradação graciosa se stores não existirem
- [x] AC6: Testes unitários em `core/memory/__tests__/` cobrindo os contratos

## File List

- `.aios-core/core/memory/memory-query.js` (novo)
- `.aios-core/core/memory/session-memory.js` (novo)
- `.aios-core/core/memory/index.js` (novo — barrel)
- `.aios-core/core/memory/__tests__/memory-query.test.js` (novo)
- `.aios-core/core/memory/__tests__/session-memory.test.js` (novo)
- `.aios-core/core/memory/gotchas-memory.js` (modificado — dual-export para compatibilizar `new GotchasMemory()` dos consumidores `execution/` com o `{ GotchasMemory }` já usado por `build-orchestrator`/barrel; backward-compatible)
