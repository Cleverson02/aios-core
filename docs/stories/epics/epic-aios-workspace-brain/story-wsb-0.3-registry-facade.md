# Story WSB-0.3: Registry Facade (busca unificada nos 3 registries)

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-0.3
**Priority:** High
**Status:** In Progress
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 0 — Consolidação

## User Story

**Como** agentes e o futuro Brain,
**Quero** uma fachada única sobre os 3 registries existentes (service-registry, entity-registry/IDS, workflow-registry/WIS),
**Para** buscar qualquer artefato do framework por uma única API sem conhecer três formatos distintos.

## Contexto

Três registries coexistem sem integração:

1. `core/registry/registry-loader.js` — service-registry.json (workers): `getById`, `getByCategory`, `getByTag`, `search`
2. `core/ids/registry-loader.js` — entity-registry.yaml (474 entidades): `queryByKeywords`, `queryByType`, `queryByPath`, `queryByPurpose`
3. `workflow-intelligence/registry/workflow-registry.js` — workflow patterns: `matchWorkflow`, `getNextSteps`

## Acceptance Criteria

- [x] AC1: `core/registry/registry-facade.js` exporta `RegistryFacade` com `search(query, {sources, limit})` unificado retornando `{source, id, type, title, score, ref}`
- [x] AC2: Métodos de conveniência: `getService(id)`, `getEntity(id)`, `getWorkflow(id)`
- [x] AC3: Carregamento lazy + degradação graciosa (registry ausente → fonte ignorada, sem throw)
- [x] AC4: Nenhum consumidor existente é alterado (aditivo, non-breaking)
- [x] AC5: Testes unitários cobrindo busca unificada e degradação

## File List

- `.aios-core/core/registry/registry-facade.js` (novo)
- `.aios-core/core/registry/__tests__/registry-facade.test.js` (novo)
