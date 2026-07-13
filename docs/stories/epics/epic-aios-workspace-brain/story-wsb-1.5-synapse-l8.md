# Story WSB-1.5: SYNAPSE L8 — Workspace Knowledge (completa SYN-10)

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-1.5
**Priority:** Critical (é o que torna o cérebro AUTOMÁTICO)
**Status:** Ready for Review
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 1 — Workspace + Brain MVP
**Depends On:** WSB-1.2 (índice), WSB-1.4 (entities.json)

## User Story

**Como** agente respondendo a qualquer prompt,
**Quero** que a camada L8 do SYNAPSE injete automaticamente hints do cérebro (entidades citadas, áreas relevantes, onde estão os documentos) dentro do orçamento de tokens,
**Para** trabalhar já sabendo o contexto da empresa sem ninguém precisar rodar `aios brain ask` manualmente.

## Restrição de performance (design driver)

O pipeline SYNAPSE tem hard limit de 100ms total / 15ms por camada, e o hook roda como processo novo a cada prompt (sem cache em memória). Ler chunks.json/vectors.json (dezenas de MB) é inviável. Solução: **hot-index.json compacto** (cap ~200KB) gerado no `brain index`, carregável em <10ms. A busca completa continua no `aios brain ask`; a L8 injeta *hints e ponteiros*.

## Acceptance Criteria

- [x] AC1: `core/brain/hot-index.js` — `buildHotIndex(brainDir, {roots})` gera hot-index.json: entidades (id, name, type, aliases, description, topSource), mapa de roots/áreas (name, tier, path), resumo dos `_index.md` (primeiras linhas); cap de 200KB com trims documentados; `loadHotIndex(brainDir)` rápido
- [x] AC2: `core/synapse/layers/l8-workspace-knowledge.js` — LayerProcessor (layer 8, name 'workspace-knowledge', timeout 15ms): match do prompt contra nomes/aliases de entidades e nomes de áreas (word-boundary, case-insensitive); emite rules com hints ("Entidade X (tipo): descrição — fonte: caminho") e ponteiros de área
- [x] AC3: Respeita orçamento: usa o token budget do context-tracker conforme bracket; em bracket apertado (vermelho) a L8 não injeta ou injeta mínimo — verificar `getActiveLayers`/`getTokenBudget` reais e documentar a integração
- [x] AC4: Registro no engine: entrada em `LAYER_MODULES` (`layer: 8`) com carregamento gracioso; sem hot-index.json → camada retorna null silenciosamente (zero impacto)
- [x] AC5: brainDir resolvido pelo mesmo hash de workspace do indexer (helper compartilhado ou duplicado documentado — sem acoplamento pesado synapse→brain)
- [x] AC6: Performance comprovada em teste: processo completo da L8 (load + match + emit) < 15ms com hot-index de fixture realista
- [x] AC7: Testes no padrão do repo (tests/synapse/): match de entidade, ponteiro de área, budget respeitado, ausência de hot-index, timeout

## File List

- `.aios-core/core/brain/hot-index.js` (novo)
- `.aios-core/core/synapse/layers/l8-workspace-knowledge.js` (novo)
- `.aios-core/core/synapse/engine.js` (modificado — entrada L8 em LAYER_MODULES)
- `.aios-core/core/synapse/context/context-tracker.js` (modificado — layer 8 nos brackets FRESH/MODERATE)
- `.aios-core/core/synapse/output/formatter.js` (modificado — seção WORKSPACE para renderizar as rules da L8; ver Dev Notes / Deviation)
- `tests/synapse/l8-workspace-knowledge.test.js` (novo)
- `.aios-core/core/brain/__tests__/hot-index.test.js` (novo)
- `tests/synapse/context-tracker.test.js` (modificado — asserts de layers dos brackets incluem L8)
- `tests/synapse/formatter.test.js` (modificado — SECTION_ORDER inclui WORKSPACE)
- `tests/synapse/engine.test.js` (modificado — L8 mockada como MODULE_NOT_FOUND, padrão L4-L7)

**Fora de escopo (lead):** hook do `brain index` chamando buildHotIndex (cli.js).

---

## Dev Agent Record

**Agent Model Used:** Opus 4.8 (1M) — Dex (Builder)

### IDS Protocol (Search → Decide → Log)

| Alvo | Decisão | Justificativa |
|------|---------|---------------|
| Leitura de entities.json | **REUSE** `EntityStore` (WSB-1.4) | Já normaliza/degrada corrupção; `list()` dá o shape pronto. Lazy-required só no build path. |
| Resolução de roots + workspace name | **ADAPT** do `BrainIndexer.resolveRoots` | Mesmo padrão (roots explícitos → WorkspaceManager try/catch → fallback cwd), reescrito local no hot-index (sem require do indexer). |
| Hash do brainDir | **ADAPT/duplicate** de `BrainIndexer.defaultBrainDir` | Espelho documentado em `hot-index.defaultBrainDir` e em `l8` (`workspaceBrainDir`) para evitar carregar `brain/indexer.js` (fast-glob+chunker+lexical) no hook por-prompt. Teste de paridade cobre o espelho. |
| Descoberta de `_index.md` | **REUSE** `fast-glob` (dep existente) | Mesmo motor/ignore-list do indexer; lazy-required. |
| Camada L8 | **ADAPT** de `L6KeywordProcessor` | Mesmo contrato `extends LayerProcessor`, `process()` síncrono, retorno `{rules, metadata}|null`. |
| Renderização das rules | **ADAPT** `formatter.js` | Nova seção WORKSPACE (aditiva). Ver Deviation abaixo. |

### Integração de bracket / budget (AC3) — heurística real

O engine **não** injeta bracket/tokenBudget no `context` das camadas; a filtragem por bracket
é feita em `SynapseEngine.process` via `activeLayers.includes(layer.layer)`, cuja lista vem de
`context-tracker.getActiveLayers(bracket)` → `LAYER_CONFIGS`. Portanto a integração de orçamento
da L8 é feita **upstream, no context-tracker**:

- **FRESH** `[0,1,2,7,8]` e **MODERATE** `[0..8]` → L8 ativa (brackets folgados / verde-amarelo).
- **DEPLETED** e **CRITICAL** `[0..7]` → L8 **não** entra (brackets apertados / laranja-vermelho):
  contexto escasso, foco em reforço + handoff.

Camadas de defesa adicionais (respeitam AC3 mesmo sob pressão):
1. `L8.process()` tem um gate defensivo opcional: se um caller passar `context.bracket` DEPLETED/CRITICAL, retorna `null` (o engine atual não passa — é belt-and-suspenders + testável no nível da camada).
2. `formatter.enforceTokenBudget` inclui `WORKSPACE` cedo na `TRUNCATION_ORDER` (logo após SUMMARY), então sob budget apertado os hints do cérebro são o primeiro conteúdo "real" cortado — CONSTITUTION/AGENT permanecem protegidos.
3. A própria L8 limita a saída a ≤5 entidades e ≤3 áreas.

### DEVIATION do File List original (flag p/ QA)

O File List da story não previa `formatter.js`, mas a renderização da L8 exige mudança nele:
o `formatter` mapeia name→seção via `LAYER_TO_SECTION` + fallback por número de camada **0-7**;
um resultado de `layer: 8` era **silenciosamente descartado** (nunca chegava ao prompt), tornando
a feature um no-op. Mudança **mínima e aditiva** feita:

- `SECTION_ORDER`: `+ 'WORKSPACE'` (antes de DEVMODE, SUMMARY continua último).
- `LAYER_TO_SECTION`: `'workspace-knowledge' → 'WORKSPACE'`.
- Fallback por número de camada: `+ else if (layerNum === 8) → 'WORKSPACE'` (a L8 emite `source: 'hot-index'`, então o roteamento efetivo é pelo número da camada).
- `formatWorkspace()` novo + entrada em `SECTION_FORMATTERS`.
- `TRUNCATION_ORDER`: `WORKSPACE` logo após `SUMMARY`.

A mudança é segura: a seção só aparece quando há resultado da L8; nenhuma saída existente muda.
`[AUTO-DECISION]` formatter fora do File List → alterado mesmo assim (reason: sem isso os hints da L8 nunca chegam ao modelo; `formatter.js` não está na lista de PROIBIDO; a própria missão antecipa ajustes em testes de engine/formatter).

### Ajustes em testes existentes (contagem de camadas)

- `tests/synapse/context-tracker.test.js`: asserts de `getActiveLayers('FRESH'/'MODERATE')` agora incluem `8` (3 asserts).
- `tests/synapse/formatter.test.js`: `expected` de `SECTION_ORDER` inclui `'WORKSPACE'`.
- `tests/synapse/engine.test.js`: L8 mockada como `MODULE_NOT_FOUND` (mesmo padrão de L4-L7), preservando o teste de carregamento isolado L0-L3.

### Resultados de teste

- `tests/synapse/l8-workspace-knowledge.test.js`: **novo**, todos verdes (constructor, match entidade/alias/área, no-match→null, hot-index ausente→null, `_safeProcess` nunca lança, gate de bracket, cap 5/3, performance <15ms).
- `.aios-core/core/brain/__tests__/hot-index.test.js`: **novo**, todos verdes (build entidades+áreas, trunc 200, ausência de entities.json, cap 200KB→`trimmed:true`, load <10ms, paridade de hash).
- **Suíte synapse completa:** `npx jest tests/synapse --silent` → **18 suites, 440 testes, 0 falhas**.
- **Suíte brain completa:** `npx jest .aios-core/core/brain --silent` → **6 suites, 71 testes, 0 falhas**.
- `eslint` nos arquivos tocados: 0 erros (1 warning pré-existente em `context-tracker.test.js:414`, fora das minhas edições).
- `tsc --noEmit`: passa (exit 0).

### Medição real da L8

Engine end-to-end (`prompt_count: 0` → bracket FRESH), prompt `"atualiza a campanha do Cliente Acme"`,
hot-index de fixture: **L8 `process()` = 1ms** (pipeline total 2ms). Teste de performance com ~100
entidades também <15ms.

### Exemplo real do XML emitido

Prompt: `atualiza a campanha do Cliente Acme` (buildHotIndex → `{entities:1, areas:1, bytes:545, trimmed:false}`):

```xml
<synapse-rules>

[CONTEXT BRACKET]
CONTEXT BRACKET: [FRESH] (100.0% remaining)

[WORKSPACE KNOWLEDGE] (1 entities, 0 areas)
  Entidade: Cliente Acme (client) — Principal cliente da agência, contrato anual de marketing. | fonte: areas/marketing/_index.md

[LOADED DOMAINS SUMMARY]
  LOADED DOMAINS:
    [HOT-INDEX] active layer (1 rules)

</synapse-rules>
```

(A área "marketing" não casou porque o prompt não contém a palavra "marketing" — comportamento
correto de word-boundary; um prompt como "rever a área de marketing" emite também o ponteiro de área.)

### Change Log

| Data | Mudança |
|------|---------|
| 2026-07-13 | Implementação WSB-1.5: `hot-index.js` (build/load, cap 200KB), camada L8, registro no engine + context-tracker, seção WORKSPACE no formatter, testes novos + ajustes mínimos em testes existentes. Status → Ready for Review. |
