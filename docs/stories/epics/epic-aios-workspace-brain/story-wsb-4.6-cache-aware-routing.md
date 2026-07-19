# Story WSB-4.6: Roteamento Cache-Aware (não perder o benefício do prompt caching)

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-4.6
**Priority:** High
**Status:** Draft (após WSB-4.5 — usa pricing)
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 4 — Gateway + UX + Economia

## User Story

**Como** roteador de LLM,
**Quero** calcular o custo REAL de trocar de modelo no meio de uma cadeia — incluindo a perda do cache de prompt (input cacheado custa ~10% do normal),
**Para** que o roteamento nunca "economize" trocando para um modelo mais barato e na prática pague mais por quebrar o cache.

## O problema (matemática do cache)

Numa cadeia de subtasks da mesma story, o contexto acumulado fica cacheado no provider incumbente. Trocar de modelo re-paga TODO esse contexto a preço cheio (+ cache write). A troca só vale quando:
`(custo_incumbente − custo_candidato) sobre os tokens NOVOS > contexto_cacheado × (input_price − cached_price) + cache_write`

## Acceptance Criteria

- [ ] AC1: `core/router/cache-affinity.js` — `switchCost({incumbentModel, candidateModel, cachedContextTokens, expectedNewTokens, matrix})` → `{stayCost, switchCost, breakEvenTokens, recommendation: stay|switch, saving}` usando os pricing da matrix (WSB-4.5); determinístico e testável
- [ ] AC2: `LlmRouter.route(task, {incumbent, cachedContextTokens, expectedNewTokens})` — quando `incumbent` informado, aplica cache-affinity: só recomenda troca se `switchCost < stayCost` com margem configurável (`cache_affinity_margin`, default 10%); `reason` explica a conta em linguagem humana
- [ ] AC3: `routeChain(subtasks, {policy})` — roteia uma cadeia inteira: escolhe o modelo-âncora pela categoria dominante e mantém afinidade, marcando exceções onde a troca compensa mesmo com perda de cache (ex.: decisão de arquitetura no meio → Opus)
- [ ] AC4: `aios route suggest` ganha `--incumbent <model> --cached <tokens>`; saída mostra a conta (stay vs switch)
- [ ] AC5: Testes: fórmula com casos numéricos verificáveis à mão (documentados no teste), margem, cadeia com âncora + exceção, sem pricing → afinidade neutra (nunca bloqueia por falta de dado)

## File List

- `.aios-core/core/router/cache-affinity.js` (novo)
- `.aios-core/core/router/router.js` (modificado — incumbent/routeChain)
- `.aios-core/core/router/cli.js` (modificado — flags)
- `.aios-core/core/router/__tests__/cache-affinity.test.js` (novo)
