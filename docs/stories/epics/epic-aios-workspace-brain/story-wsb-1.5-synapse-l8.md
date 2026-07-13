# Story WSB-1.5: SYNAPSE L8 — Workspace Knowledge (completa SYN-10)

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-1.5
**Priority:** Critical (é o que torna o cérebro AUTOMÁTICO)
**Status:** In Progress
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

- [ ] AC1: `core/brain/hot-index.js` — `buildHotIndex(brainDir, {roots})` gera hot-index.json: entidades (id, name, type, aliases, description, topSource), mapa de roots/áreas (name, tier, path), resumo dos `_index.md` (primeiras linhas); cap de 200KB com trims documentados; `loadHotIndex(brainDir)` rápido
- [ ] AC2: `core/synapse/layers/l8-workspace-knowledge.js` — LayerProcessor (layer 8, name 'workspace-knowledge', timeout 15ms): match do prompt contra nomes/aliases de entidades e nomes de áreas (word-boundary, case-insensitive); emite rules com hints ("Entidade X (tipo): descrição — fonte: caminho") e ponteiros de área
- [ ] AC3: Respeita orçamento: usa o token budget do context-tracker conforme bracket; em bracket apertado (vermelho) a L8 não injeta ou injeta mínimo — verificar `getActiveLayers`/`getTokenBudget` reais e documentar a integração
- [ ] AC4: Registro no engine: entrada em `LAYER_MODULES` (`layer: 8`) com carregamento gracioso; sem hot-index.json → camada retorna null silenciosamente (zero impacto)
- [ ] AC5: brainDir resolvido pelo mesmo hash de workspace do indexer (helper compartilhado ou duplicado documentado — sem acoplamento pesado synapse→brain)
- [ ] AC6: Performance comprovada em teste: processo completo da L8 (load + match + emit) < 15ms com hot-index de fixture realista
- [ ] AC7: Testes no padrão do repo (tests/synapse/): match de entidade, ponteiro de área, budget respeitado, ausência de hot-index, timeout

## File List

- `.aios-core/core/brain/hot-index.js` (novo)
- `.aios-core/core/synapse/layers/l8-workspace-knowledge.js` (novo)
- `.aios-core/core/synapse/engine.js` (modificado — entrada L8 em LAYER_MODULES)
- `.aios-core/core/synapse/context/context-tracker.js` (modificado SE necessário para incluir layer 8 nos brackets — documentar)
- `tests/synapse/l8-workspace-knowledge.test.js` (novo)
- `.aios-core/core/brain/__tests__/hot-index.test.js` (novo)

**Fora de escopo (lead):** hook do `brain index` chamando buildHotIndex (cli.js).
