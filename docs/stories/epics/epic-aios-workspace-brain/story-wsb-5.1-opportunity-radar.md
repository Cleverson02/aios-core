# Story WSB-5.1: Radar de Oportunidades

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-5.1
**Priority:** High
**Status:** Ready for Review
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

- [x] AC1: `core/radar/collectors.js` — coleta determinística das fontes reais: entities.json (menções vs relações project), digests (docs/digests), gotchas (.aios/gotchas.json), stats do brain por área, telemetria de atividade; toda fonte ausente → ignorada
- [x] AC2: `core/radar/heuristics.js` — regras determinísticas geram `findings`: `{type: automation|underused-asset|latent-demand|process-gap, title, evidence[], area, effort (1-5), impact (1-5), score}` ordenados por impact/effort
- [x] AC3: `core/radar/synthesizer.js` — opcional `--with-llm`: para os top-N findings gera brief (contexto → oportunidade → próximo passo) via ai-provider factory + LlmRouter (cost-first); sem provider disponível → pula com aviso, findings determinísticos permanecem (zero LLM por padrão)
- [x] AC4: `aios radar` CLI: `scan` (roda coleta+heurísticas, grava `.aios/radar/scan-<date>.json`), `report [--top 5]` (imprime ranqueado com evidências), `brief <finding-id> [--with-llm]` (formato project-brief pronto para virar PRD)
- [x] AC5: Zero dependências novas; testes com fixtures (workspace fake com entidades/digests/gotchas): cada heurística dispara no caso certo, ranking, fontes ausentes, brief determinístico sem LLM, synthesizer com provider mockado

## File List

- `.aios-core/core/radar/collectors.js` (novo)
- `.aios-core/core/radar/heuristics.js` (novo)
- `.aios-core/core/radar/synthesizer.js` (novo)
- `.aios-core/core/radar/cli.js` (novo)
- `.aios-core/core/radar/index.js` (novo — barrel)
- `.aios-core/core/radar/__tests__/radar.test.js` (novo)

**Fora de escopo (lead):** wiring `aios radar` no bin/aios.js.

## Dev Agent Record

### Agent Model Used

Opus 4.8 (claude-opus-4-8) — @dev (Dex)

### Status

Ready for Review

### Completion Notes

- **Escopo estrito respeitado:** criados apenas `.aios-core/core/radar/*` + atualização desta story. `core/routines/`, `README`/`install-manifest`/`health-check` e `bin/aios.js` NÃO foram tocados. Todos os módulos externos (brain, gotchas, telemetry, router, providers, ai-provider factory) são consumidos via `require` lazy dentro de try/catch — zero acoplamento rígido.
- **Princípio de economia honrado:** por padrão, ZERO LLM. `collectors` + `heuristics` são 100% determinísticos. O `synthesizer` só executa com `--with-llm` E provider disponível — checa `providers.getAvailability()` (cache network-free) ANTES de qualquer chamada; nenhum provider → `{skipped:true, reason}` e os findings determinísticos permanecem intactos.
- **Fontes reais mapeadas (lidas antes de codar):** entity-store/query (soma de `sources[].mentions`, relations tipadas), digest.js (front-matter + seção `## Decisões` — parse leve conforme spec), gotchas.json (lido DIRETO, schema-tolerant: a listGotchas do GotchasMemory quebraria com o schema legado do repo que não tem `source.lastSeen`), indexer manifest (contagem por área + detecção de `_index.md` via chunks.json), telemetry aggregate + getActiveAgents.
- **Mapeamento de provider descoberto:** matrix usa ids `anthropic|openai|google|xai`; a factory usa `claude|codex|gemini|grok`. O synthesizer traduz via `PROVIDER_TO_FACTORY` (ex.: `xai → grok`). A disponibilidade é checada nos ids da matrix (consistente com `route().provider`).
- **Tabela effort/impact curada e documentada no código** (`RULES`): latent-demand 5/2=2.5 (maior score), automation 4/2=2.0, underused-asset 3/3=1.0, process-gap 3/3=1.0. `score = impact/effort`, ordenação desc com desempate por impacto e título. `id` = slug estável do título → `brief <id>` resolve o mesmo finding entre execuções.
- **Resultado real rodando no próprio aios-core:** `scan` encontrou digests:1, gotchas:4, atividade:sim; porém 0 oportunidades — os 4 gotchas legados têm `occurrences` ausente (default 1, < 3), há só 1 digest (decisão repetida exige ≥2) e não há brain index/entities. O radar reporta isso com honestidade e aponta `aios brain index` / `aios brain entities scan` para destravar sinal. Nenhum falso-positivo inventado (Constitution Art. IV — No Invention).
- **Qualidade:** 29 testes passando (`npx jest .aios-core/core/radar`), ZERO LLM/rede real na suíte (availability/router/factory injetados). ESLint 0 erros/0 warnings. Zero dependências novas (fs/path nativos + chalk/js-yaml já existentes). CommonJS + JSDoc.

### IDS Log (Search → Decide → Log)

- **slug de id:** entity-store expõe `slugify`. DECISÃO: CREATE util local `slug()` em heuristics.js (3 linhas, dependency-free) em vez de acoplar o radar ao módulo brain só para um id. Justificado: mantém heuristics puro/isolado.
- **coleta de gotchas:** existe `GotchasMemory.listGotchas()`. DECISÃO: ADAPT → ler `.aios/gotchas.json` direto. `listGotchas` ordena por `a.source.lastSeen` e o schema legado do repo não tem `source` → lançaria. Ler raw é crash-proof e sem efeito colateral (sem re-serialização).
- **entidades / brain stats / telemetria / router / factory / availability:** REUSE via require lazy — `EntityStore`, `BrainIndexer` (defaultBrainDir + manifest), `telemetry.aggregate/getActiveAgents`, `LlmRouter`, `ai-provider-factory.getProvider`, `providers.getAvailability`. Nenhum reescrito.
- **stats por área:** `BrainIndexer.stats()` agrega por ROOT, não por área. DECISÃO: ADAPT → ler `manifest.json` direto para contar arquivos por `area` e `chunks.json` para detectar `_index.md`. Documentado no código.
- **parse de digest:** REUSE do formato de `digest.js` (front-matter YAML + `## Decisões`); parser próprio leve (não importa digest.js para evitar puxar git/child_process).

### File List

- `.aios-core/core/radar/collectors.js` (novo)
- `.aios-core/core/radar/heuristics.js` (novo)
- `.aios-core/core/radar/synthesizer.js` (novo)
- `.aios-core/core/radar/cli.js` (novo)
- `.aios-core/core/radar/index.js` (novo — barrel)
- `.aios-core/core/radar/__tests__/radar.test.js` (novo — 29 testes)
- `docs/stories/epics/epic-aios-workspace-brain/story-wsb-5.1-opportunity-radar.md` (atualizado — Dev Agent Record)

### Change Log

| Data | Versão | Descrição | Autor |
|------|--------|-----------|-------|
| 2026-07-19 | 1.0.0 | Radar de Oportunidades: collectors + heuristics determinísticas + synthesizer LLM opcional (cost-first, availability-gated) + CLI scan/report/brief + 29 testes. Zero deps novas. | @dev (Dex) |
