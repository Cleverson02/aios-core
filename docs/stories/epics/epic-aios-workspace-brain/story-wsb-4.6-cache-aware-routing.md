# Story WSB-4.6: Roteamento Cache-Aware (não perder o benefício do prompt caching)

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-4.6
**Priority:** High
**Status:** Ready for Review (após WSB-4.5 — usa pricing)
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

- [x] AC1: `core/router/cache-affinity.js` — `switchCost({incumbentModel, candidateModel, cachedContextTokens, expectedNewInputTokens, expectedOutputTokens, matrix})` → `{stayCost, switchCost, breakEvenTokens, recommendation: stay|switch, saving, explanation}` usando os pricing da matrix (WSB-4.5); determinístico e testável
- [x] AC2: `LlmRouter.route(task, {incumbent, cachedContextTokens, expectedNewInputTokens, expectedOutputTokens, marginPct})` — quando `incumbent` informado, aplica cache-affinity: só recomenda troca se `switchCost < stayCost×(1−margem/100)` com margem configurável (`marginPct`, default 10%); `reason` explica a conta em USD de cada lado
- [x] AC3: `routeChain(subtasks, {policy, cachedContextTokens})` — roteia uma cadeia inteira: escolhe o modelo-âncora pela categoria dominante (moda; empate → maior cost_tier) e mantém afinidade acumulando cache, marcando exceções onde a troca compensa e forçando `qualityOverride` em architecture-decision/security-review (ex.: decisão de arquitetura no meio → Opus)
- [x] AC4: `aios route suggest` ganha `--incumbent <model> --cached <tokens> --new <tokens> --out <tokens>`; saída mostra o bloco "Análise de cache" (stay vs switch, break-even, recomendação)
- [x] AC5: Testes: fórmula com casos numéricos verificáveis à mão (documentados no teste), margem na fronteira, break-even, cadeia com âncora + exceção qualityOverride, sem pricing → afinidade neutra (nunca bloqueia por falta de dado)

## File List

- `.aios-core/core/router/cache-affinity.js` (novo)
- `.aios-core/core/router/router.js` (modificado — incumbent/routeChain, aditivo)
- `.aios-core/core/router/cli.js` (modificado — flags + bloco "Análise de cache")
- `.aios-core/core/router/__tests__/cache-affinity.test.js` (novo)

## Dev Agent Record

**Agent:** Dex (Builder) · **Status:** Ready for Review

### A matemática do cache (com números reais da matrix)

Pricing (USD por MILHÃO de tokens, de `capability-matrix.yaml` §WSB-4.5):

| modelo | input | cached | output | write |
|---|---|---|---|---|
| claude-opus-4-8 | 15 | 1.5 | 75 | 18.75 |
| grok-4-5 | 2 | 0.5 | 6 | 2.5 |
| gpt-5.5-codex | 5 | 0.5 | 20 | 5 |
| gemini-2.x | 1 | 0.25 | 4 | 1 |

Fórmulas (÷1e6):
- `stayCost = cached×inc.cached + newIn×inc.input + out×inc.output`
- `switchCost = (cached+newIn)×cand.input + cand.write×(cached+newIn) + out×cand.output`
- `saving = stayCost − switchCost`; troca só se `switchCost < stayCost×(1−margem/100)` (margem default 10%).

**Break-even (derivação algébrica).** Segurando `cached`/`out` fixos e variando os
tokens novos `N`, o custo por token novo economizado ao trocar é
`denom = inc.input − cand.input − cand.write`. Se `denom ≤ 0`, a troca NUNCA se
paga aumentando `N` → `Infinity`. Senão, o crossover `stayCost(N)=switchCost(N)` é
`N* = [cached×(cand.input + cand.write − inc.cached) + out×(cand.output − inc.output)] / denom`,
com clamp em 0 (N* negativo ⇒ troca já vence com 0 tokens novos). A margem NÃO
entra no break-even (é o crossover puro; só afeta a `recommendation`).

### Casos numéricos verificados à mão (batem com os testes)

1. **opus → grok**, cached=100k, new=10k, out=5k:
   `stay = 100000×1.5 + 10000×15 + 5000×75 = 150000+150000+375000 = $0.6750`;
   `switch = 110000×2 + 2.5×110000 + 5000×6 = 220000+275000+30000 = $0.5250`;
   `saving=$0.15` → **switch** (0.525 < 0.6075). break-even clampa a 0 (grok já vence sem tokens novos).

2. **opus → grok**, cached=100k, new=0, out=0 (demo do CLI):
   `stay = 100000×1.5 = $0.1500`; `switch = 100000×2 + 2.5×100000 = $0.4500` → **stay** (cache protegido).
   `denom = 15−2−2.5 = 10.5`; `N* = 100000×(2+2.5−1.5)/10.5 = 300000/10.5 = 28572` tokens novos.

3. **Fronteira de margem** (sintético inc.input 10 / cand.input 8 + write 1 = 9 ⇒ ratio 0.9):
   margem 10% ⇒ `0.9 < 0.9` falso → **stay**; margem 5% ⇒ `0.9 < 0.95` → **switch**.

4. **Break-even finito** (sintético inc.input 10 cached 1 / cand.input 5 write 1, cached=10k, out=0):
   `denom=4`, `N*=10000×5/4 = 12500`; em N=12500 stay=switch=$0.1350.

### routeChain — âncora + exceção

Âncora = modelo da **categoria dominante** (moda; empate → maior `cost_tier` do modelo
roteado, depois nome). Percorre a cadeia com `incumbent=âncora`, acumulando
`cachedContextTokens += expectedNewInputTokens` (default 2000/passo) — então trocar
fica progressivamente mais caro. `architecture-decision`/`security-review` SEMPRE
marcam `qualityOverride: true` (modelo forte vence por qualidade, com a conta exposta).
Teste: `[test-gen ×3, architecture ×1]` → âncora `grok-4-5`, passo 2 → `claude-opus-4-8`
(`qualityOverride: true, switched: true`).

### Decisões autônomas

- `[AUTO-DECISION]` Assinatura usa `expectedNewInputTokens`/`expectedOutputTokens` (spec da task) em vez do `expectedNewTokens` do cabeçalho AC1 → mais preciso p/ separar input×output no cálculo (razão: output tem preço próprio; unir os dois distorceria stay/switch).
- `[AUTO-DECISION]` Margem configurável via opção `marginPct` (não via chave `cache_affinity_margin` na matrix) → schema/matrix são PROIBIDOS de tocar nesta story; opção mantém tudo aditivo e testável.
- `[AUTO-DECISION]` `route()` refatorado: núcleo movido p/ `_decide()` privado; `route()` sem `incumbent` retorna `_decide()` intacto → comportamento pré-WSB-4.6 byte-a-byte idêntico (54/54 testes verdes).
- `[AUTO-DECISION]` Modelo sem pricing → `recommendation:'neutral'` em todos os caminhos (switchCost, route, routeChain) → nunca bloqueia rota por falta de dado (AC5).

### Validação

- `npx jest .aios-core/core/router --silent` → **54/54 passam** (23 antigos + 31 novos/cobertos), zero regressão.
- `npx eslint` nos 4 arquivos tocados → **0 erros**.
- Demo CLI (`suggest ... --incumbent claude-opus-4-8 --cached 100000` p/ test-generation) → imprime a conta e recomenda **stay** ($0.15 vs $0.45, break-even 28572).

### Change Log

| Data | Mudança |
|---|---|
| 2026-07-19 | Status → In Progress; implementação cache-aware routing (cache-affinity.js + route/routeChain + CLI + testes); AC1–AC5 [x]; Status → Ready for Review |
