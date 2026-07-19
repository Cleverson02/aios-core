# Story WSB-4.8: Modo Guiado — "qual o próximo passo?" sem curso nem tokens

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-4.8
**Priority:** Critical (facilidade de uso ≥ AIOS)
**Status:** Draft
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 4 — Gateway + UX + Economia

## User Story

**Como** usuário que NÃO conhece a metodologia AIOS,
**Quero** que o sistema me diga a cada momento qual é o próximo agente/comando da sequência (com o porquê em 1 frase),
**Para** não queimar tokens nem quebrar a cabeça descobrindo a ordem @po → @dev → @qa → @devops.

## Insight de reuso

O `workflow-intelligence` JÁ tem `getSuggestions(context)` (registry de workflows + confidence scorer + `*next`). O gap é de EXPOSIÇÃO: não existe comando de primeira classe nem detecção automática de estado do projeto. Esta story é 80% wiring determinístico, 0% LLM.

## Acceptance Criteria

- [ ] AC1: `core/guide/project-state.js` — detecção determinística do estado: tem PRD? arquitetura? stories (status de cada)? builds ativos? git sujo? → `{stage: ideation|planning|architecture|development|review|done, evidence[]}`
- [ ] AC2: `core/guide/next-step.js` — combina project-state + WIS `getSuggestions` (REUSE) + status das stories → `{nextAgent, nextCommand, why (1 frase), alternatives[]}`; tabela de sequência da metodologia embutida como fallback quando o WIS não tem confiança
- [ ] AC3: `aios next` CLI: mostra o próximo passo com o comando pronto para copiar (ex.: "@sm *create-story — a story WSB-X foi aprovada, falta detalhar a próxima"); `aios next --explain` mostra o mapa completo do fluxo com onde você está
- [ ] AC4: Onboarding: `aios setup` (WSB-4.4) termina mostrando `aios next`; `aios workspace init` sugere o próximo passo; README de 10 linhas `docs/guides/primeiros-passos-cortex.md` (PT) com o ciclo básico
- [ ] AC5: Zero LLM, zero dependências novas; testes: cada stage detectado com fixtures, próximo passo por stage, fallback sem WIS, sugestão pós-setup

## File List

- `.aios-core/core/guide/project-state.js` (novo)
- `.aios-core/core/guide/next-step.js` (novo)
- `.aios-core/core/guide/cli.js` (novo)
- `.aios-core/core/guide/index.js` (novo — barrel)
- `docs/guides/primeiros-passos-cortex.md` (novo)
- `.aios-core/core/guide/__tests__/guide.test.js` (novo)

**Fora de escopo (lead):** wiring `aios next` no bin/aios.js.
