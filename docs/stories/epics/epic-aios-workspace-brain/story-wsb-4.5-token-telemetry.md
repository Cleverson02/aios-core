# Story WSB-4.5: Telemetria de Tokens e Custos (ledger determinístico)

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-4.5
**Priority:** Critical (base do dashboard e da promessa "não ser bebedor de tokens")
**Status:** Ready for Review
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

- [x] AC1: `capability-matrix.yaml` ganha seção `pricing` por modelo: `{input_per_mtok, output_per_mtok, cached_input_per_mtok, cache_write_per_mtok}` (valores default documentados como editáveis; schema atualizado)
- [x] AC2: `core/telemetry/ledger.js` — `recordUsage({provider, model, inputTokens, outputTokens, cachedInputTokens, cacheWriteTokens, agent, storyId, project, source})` → append JSONL em `.aios/telemetry/usage.jsonl` com custo calculado dos preços da matrix (modelo sem pricing → custo null, tokens registrados mesmo assim)
- [x] AC3: Instrumentação nos pontos reais: `AIProvider.executeWithRetry` (base — captura usage do AIResponse quando o provider retorna) e `GrokProvider` (API retorna usage real); providers CLI sem usage → estimativa por chars/4 marcada `estimated:true`
- [x] AC4: `core/telemetry/report.js` — `aggregate({groupBy: provider|model|agent|storyId|project|day, since})` → totais de tokens (input/output/cached), custo, nº de chamadas, % estimado; leitura streaming do JSONL (não carrega tudo em memória)
- [x] AC5: Atividade de agentes: `recordAgentActivity({agent, action, storyId, project})` → `.aios/telemetry/activity.jsonl` (quem está fazendo o quê — alimenta o dashboard); helper `getActiveAgents()` (últimos 15min)
- [x] AC6: `aios costs` CLI: `summary [--since 7d] [--by provider|agent|story]` (tabela com totais e custo), `today`, `export --json`
- [x] AC7: Zero dependências novas; testes: cálculo de custo com/sem cache, modelo sem pricing, agregações por cada groupBy, streaming em arquivo grande sintético, estimativa marcada, activity

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

## Dev Agent Record

### Agent Model Used

Dex (Builder) — @dev — Opus 4.8 (1M)

### Debug Log References

- `npx jest .aios-core/core/telemetry --silent` → 24 passed
- `npx jest ai-provider --silent` → 39 passed (4 suites, regression intact)
- `npx jest .aios-core/core/router --silent` → 37 passed (matrix + pricing still validates)
- `npx eslint` nos arquivos tocados → 0 errors, 0 warnings

### Completion Notes List

- **AC1 (pricing):** `pricing` per-model adicionado à `capability-matrix.yaml` (grok-4-5, claude-opus-4-8, gpt-5.5-codex, gemini-2.x) em USD/Mtok, com comentário YAML documentando os defaults como editáveis ("ajuste aos preços vigentes do seu contrato"). Schema ganhou `definitions/pricing` (opcional por modelo; `input/output/cached_input` obrigatórios ≥0, `cache_write` opcional; `additionalProperties:false`). `matrix-loader.loadMatrix` continua validando — `pricing` viaja dentro de `models[id]`, então o shallow-merge de override de projeto o preserva sem alterar o loader.
- **AC2 (ledger):** `recordUsage(entry,{cwd})` calcula `costUsd` via `computeCost` = (in·in_rate + out·out_rate + cached·cached_rate + cacheWrite·write_rate)/1e6; pricing via `loadMatrix` lazy try/catch (matriz quebrada/modelo sem pricing → `costUsd:null`, tokens sempre gravados). Append síncrono (`appendFileSync`) em `.aios/telemetry/usage.jsonl`, 1 linha JSON com `ts` ISO. `estimateTokens(text)=Math.ceil(chars/4)` exportado.
- **AC3 (hook):** `AIProvider.executeWithRetry` chama `_recordTelemetry(prompt,response,options)` após sucesso — `require('../../../core/telemetry')` lazy dentro de try/catch TOTAL (telemetria nunca quebra execução, comprovado por teste com `recordUsage` mockado lançando erro). Normaliza usage em ambos os formatos (OpenAI `prompt_tokens/completion_tokens/prompt_tokens_details.cached_tokens` e camelCase); sem usage → estimativa por chars com `estimated:true`; `source:'ai-provider'`. GrokProvider já expõe `metadata.usage` real da API, consumido sem alterações no arquivo dele.
- **AC4 (report):** `aggregate({cwd,groupBy,since,now})` faz parse streaming via `readline` sobre `createReadStream` (não carrega tudo em memória), tolera linha corrompida (skip). `since` aceita `Nd/Nh/Nm`/ISO. Retorna `{groups:[{key,calls,inputTokens,outputTokens,cachedInputTokens,costUsd,estimatedPct}],totals}` ordenado por custo. `getActiveAgents({cwd,windowMs=15min,now})` sobre `activity.jsonl`.
- **AC5 (activity):** `recordAgentActivity({agent,action,storyId,project},{cwd})` → append em `.aios/telemetry/activity.jsonl` com `ts` ISO.
- **AC6 (CLI):** `costsCommand(args,{cwd,log,now})` — `summary [--since] [--by]`, `today` (24h/provider), `export --json`. Tabela chalk com custo USD (`$0.0000`), `CACHE%` (cached/(input+cached)) e `EST%`. Sem dados → mensagem amigável com instrução.
- **AC7 (testes):** 24 testes cobrindo custo com/sem cache (números conferidos à mão), modelo sem pricing → null, cada groupBy, `since`, streaming 5k linhas + 1 corrompida, estimativa marcada, activity + janela de `getActiveAgents`, e o hook do ai-provider (usage real normalizado + telemetria quebrada não afeta execução). Zero deps novas (chalk/js-yaml/ajv já presentes).

**[AUTO-DECISION]** Nomes das chaves de pricing → seguidos exatamente do AC1 (`input_per_mtok` etc.) no arquivo/schema; internamente o ledger normaliza para tokens camelCase (reason: AC1 é o contrato público editável pelo usuário, camelCase é convenção JS interna).

**[AUTO-DECISION]** `aggregate`/`getActiveAgents` assíncronos retornando Promise → necessário pelo streaming `readline` (reason: AC4 exige leitura streaming, não em memória).

### File List

- `.aios-core/core/telemetry/ledger.js` (novo)
- `.aios-core/core/telemetry/report.js` (novo)
- `.aios-core/core/telemetry/cli.js` (novo)
- `.aios-core/core/telemetry/index.js` (novo — barrel)
- `.aios-core/core/telemetry/__tests__/telemetry.test.js` (novo)
- `.aios-core/core/router/capability-matrix.yaml` (modificado — bloco `pricing` por modelo)
- `.aios-core/core/router/capability-matrix-schema.json` (modificado — `definitions/pricing`)
- `.aios-core/infrastructure/integrations/ai-providers/ai-provider.js` (modificado — hook `_recordTelemetry`)

### Change Log

| Data | Versão | Descrição | Autor |
|------|--------|-----------|-------|
| 2026-07-19 | 1.0 | Telemetria determinística de tokens/custos: pricing na matrix, ledger JSONL, report streaming, activity, `aios costs` CLI + 24 testes. Regressão de providers (39) e router (37) intacta. | Dex (@dev) |

**Status:** Ready for Review
