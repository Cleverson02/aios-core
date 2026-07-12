# Story WSB-0.1: Entrypoint Único de Orquestração (consolidação sobre o Bob)

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-0.1
**Priority:** High
**Status:** In Progress (incremento 1: facade + deprecação)
**Type:** Refactoring
**Lead:** @dev (Dex) + @architect (Aria)
**Repository:** aios-core
**Wave:** Fase 0 — Consolidação

## User Story

**Como** módulos novos do AIOX Cortex (Router, Autonomy, Gateway),
**Quero** um único ponto de entrada de orquestração consolidado sobre o BobOrchestrator,
**Para** não acoplar a nenhuma das 3 gerações históricas (WorkflowOrchestrator, MasterOrchestrator/ADE, BobOrchestrator).

## Estratégia (incremental, sem breaking change)

**Incremento 1 (esta story):** facade `orchestration/entrypoint.js` + `@deprecated` nos entrypoints históricos, sem alterar comportamento.
**Incremento 2 (futuro):** migrar consumidores internos para o entrypoint; remover caminhos duplicados em major release.

## Acceptance Criteria

- [x] AC1: `core/orchestration/entrypoint.js` exporta `getOrchestrator(options)` retornando a instância consolidada (Bob) e `ORCHESTRATOR_GENERATIONS` documentando as 3 gerações
- [x] AC2: JSDoc `@deprecated` em `master-orchestrator.js` e `workflow-orchestrator.js` apontando para o entrypoint (sem mudança de comportamento)
- [x] AC3: `orchestration/index.js` exporta o novo entrypoint
- [x] AC4: Testes existentes de orchestration continuam passando; teste novo cobre o facade
- [x] AC5: Decisão registrada (ADR) em `.ai/` ou docs: Bob é a geração-alvo

## File List

- `.aios-core/core/orchestration/entrypoint.js` (novo)
- `.aios-core/core/orchestration/index.js` (modificado — export)
- `.aios-core/core/orchestration/master-orchestrator.js` (modificado — @deprecated JSDoc)
- `.aios-core/core/orchestration/workflow-orchestrator.js` (modificado — @deprecated JSDoc)
- `.aios-core/core/orchestration/__tests__/entrypoint.test.js` (novo)
- `docs/architecture/adr-wsb-001-bob-orchestrator-consolidation.md` (novo — ADR)

## Dev Agent Record

**Agent Model Used:** Opus 4.8 (claude-opus-4-8[1m])

### Completion Notes

Incremento 1 (facade + deprecação) implementado sem alteração de comportamento:

- `entrypoint.js` expõe `getOrchestrator(options)` (retorna `BobOrchestrator` via require lazy; `generation: 'workflow'|'master'` emite `process.emitWarning` de deprecação e retorna a geração legada) e `ORCHESTRATOR_GENERATIONS` (congelado, 3 gerações com `name`/`module`/`status`/`since`).
- `@deprecated` JSDoc adicionado às classes `MasterOrchestrator` e `WorkflowOrchestrator` (comentário apenas — nenhuma mudança de código/comportamento).
- Barrel `index.js` reexporta `getOrchestrator` e `ORCHESTRATOR_GENERATIONS` (aditivo).
- ADR-WSB-001 registra Bob como geração-alvo.

**Testes:** `entrypoint.test.js` — 12/12 passando (facade retorna Bob, warnings de deprecação para master/workflow, catálogo congelado com 3 entradas). Suíte pré-existente de orchestration: 15 suites / 517 testes — todos passando, nada quebrado. Barrel carrega e exporta os novos símbolos.

**Lint:** `npx eslint` retornou exit 0 (0 errors) — os arquivos em `.aios-core/` são cobertos pelo ignore pattern do ESLint do projeto, comportamento pré-existente e não introduzido por esta story.

### Change Log

| Data | Mudança | Autor |
|------|---------|-------|
| 2026-07-12 | Incremento 1: facade `entrypoint.js`, `@deprecated` nos entrypoints históricos, export no barrel, ADR-WSB-001, teste do facade | Dex (@dev) |
