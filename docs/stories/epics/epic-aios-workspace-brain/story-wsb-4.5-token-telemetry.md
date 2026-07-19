# Story WSB-4.5: Telemetria de Tokens e Custos (ledger determinístico)

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-4.5
**Priority:** Critical (base do dashboard e da promessa "não ser bebedor de tokens")
**Status:** In Progress
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 4 — Gateway + UX + Economia

## User Story

**Como** usuário/empresa,
**Quero** telemetria completa e local de tokens e custos — por provider, modelo, agente, projeto, story e dia, incluindo tokens cacheados,
**Para** ver exatamente quanto cada coisa consome e provar que o Cortex não gasta mais que o AIOS.

## Princípios

- **100% determinístico e local** — o ledger é código puro, zero LLM, zero rede
- Preços vêm da capability-matrix (nova seção `pricing` editável pelo usuário)
- Cache contabilizado separadamente (input cacheado custa ~10% do normal — a base da WSB-4.6)

## Acceptance Criteria

- [ ] AC1: `capability-matrix.yaml` ganha seção `pricing` por modelo: `{input_per_mtok, output_per_mtok, cached_input_per_mtok, cache_write_per_mtok}` (valores default documentados como editáveis; schema atualizado)
- [ ] AC2: `core/telemetry/ledger.js` — `recordUsage({provider, model, inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, agent, storyId, project, source})` → append JSONL em `.aios/telemetry/usage.jsonl` com custo calculado dos preços da matrix (modelo sem pricing → custo null, tokens registrados mesmo assim)
- [ ] AC3: Instrumentação nos pontos reais: `AIProvider.executeWithRetry` (base — captura usage do AIResponse quando o provider retorna) e `GrokProvider` (API retorna usage real); providers CLI sem usage → estimativa por chars/4 marcada `estimated:true`
- [ ] AC4: `core/telemetry/report.js` — `aggregate({groupBy: provider|model|agent|storyId|project|day, since})` → totais de tokens (input/output/cached), custo, nº de chamadas, % estimado; leitura streaming do JSONL (não carrega tudo em memória)
- [ ] AC5: Atividade de agentes: `recordAgentActivity({agent, action, storyId, project})` → `.aios/telemetry/activity.jsonl` (quem está fazendo o quê — alimenta o dashboard); helper `getActiveAgents()` (últimos 15min)
- [ ] AC6: `aios costs` CLI: `summary [--since 7d] [--by provider|agent|story]` (tabela com totais e custo), `today`, `export --json`
- [ ] AC7: Zero dependências novas; testes: cálculo de custo com/sem cache, modelo sem pricing, agregações por cada groupBy, streaming em arquivo grande sintético, estimativa marcada, activity

## File List

- `.aios-core/core/telemetry/ledger.js` (novo)
- `.aios-core/core/telemetry/report.js` (novo)
- `.aios-core/core/telemetry/cli.js` (novo)
- `.aios-core/core/telemetry/index.js` (novo — barrel)
- `.aios-core/core/router/capability-matrix.yaml` (modificado — pricing)
- `.aios-core/core/router/capability-matrix-schema.json` (modificado)
- `.aios-core/infrastructure/integrations/ai-providers/ai-provider.js` (modificado — hook de usage mínimo)
- `.aios-core/core/telemetry/__tests__/telemetry.test.js` (novo)

**Fora de escopo (lead):** wiring `aios costs` no bin/aios.js.
