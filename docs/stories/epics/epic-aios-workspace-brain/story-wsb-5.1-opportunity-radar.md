# Story WSB-5.1: Radar de Oportunidades

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-5.1
**Priority:** High
**Status:** In Progress
**Type:** Feature
**Lead:** @dev (Dex) + @analyst (Alex)
**Repository:** aios-core
**Wave:** Fase 5 — Radar + Empacotamento

## User Story

**Como** owner/gestor,
**Quero** um radar que analisa o que o cérebro sabe da empresa (entidades, digests, gotchas, atividade por área) e aponta oportunidades ranqueadas por esforço × impacto,
**Para** que o Cortex também oriente ONDE investir — não só execute o que mando.

## Princípio de economia

Duas camadas: (1) **achados determinísticos** (zero LLM): gotchas recorrentes = oportunidade de automação; áreas com muito conteúdo e pouca atividade = ativo subaproveitado; entidades muito mencionadas sem projeto associado = demanda latente; digests com decisões repetidas = processo a padronizar. (2) **Síntese LLM opcional** (só com provider disponível e flag explícita `--with-llm`): transforma os achados em briefs; roteada pelo LlmRouter com policy cost-first.

## Acceptance Criteria

- [ ] AC1: `core/radar/collectors.js` — coleta determinística das fontes reais: entities.json (menções vs relações project), digests (docs/digests), gotchas (.aios/gotchas.json), stats do brain por área, telemetria de atividade; toda fonte ausente → ignorada
- [ ] AC2: `core/radar/heuristics.js` — regras determinísticas geram `findings`: `{type: automation|underused-asset|latent-demand|process-gap, title, evidence[], area, effort (1-5), impact (1-5), score}` ordenados por impact/effort
- [ ] AC3: `core/radar/synthesizer.js` — opcional `--with-llm`: para os top-N findings gera brief (contexto → oportunidade → próximo passo) via ai-provider factory + LlmRouter (cost-first); sem provider disponível → pula com aviso, findings determinísticos permanecem (zero LLM por padrão)
- [ ] AC4: `aios radar` CLI: `scan` (roda coleta+heurísticas, grava `.aios/radar/scan-<date>.json`), `report [--top 5]` (imprime ranqueado com evidências), `brief <finding-id> [--with-llm]` (formato project-brief pronto para virar PRD)
- [ ] AC5: Zero dependências novas; testes com fixtures (workspace fake com entidades/digests/gotchas): cada heurística dispara no caso certo, ranking, fontes ausentes, brief determinístico sem LLM, synthesizer com provider mockado

## File List

- `.aios-core/core/radar/collectors.js` (novo)
- `.aios-core/core/radar/heuristics.js` (novo)
- `.aios-core/core/radar/synthesizer.js` (novo)
- `.aios-core/core/radar/cli.js` (novo)
- `.aios-core/core/radar/index.js` (novo — barrel)
- `.aios-core/core/radar/__tests__/radar.test.js` (novo)

**Fora de escopo (lead):** wiring `aios radar` no bin/aios.js.
