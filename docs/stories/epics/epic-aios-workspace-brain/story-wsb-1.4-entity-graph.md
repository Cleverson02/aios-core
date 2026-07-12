# Story WSB-1.4: Grafo de Entidades do Negócio

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-1.4
**Priority:** High
**Status:** In Progress
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 1 — Workspace + Brain MVP
**Depends On:** WSB-1.1 (roots/tiers), WSB-1.2 (chunks.json)

## User Story

**Como** cérebro central,
**Quero** um grafo de entidades do negócio (clientes, produtos, pessoas, projetos, marcas, áreas) extraídas do workspace + curadas manualmente,
**Para** responder "o que sabemos sobre o cliente X" ligando documentos entre áreas e alimentar decisões de projeto com contexto relacional.

## Acceptance Criteria

- [ ] AC1: `core/brain/entities/entity-store.js` — CRUD persistido em `entities.json` no brainDir: `{id, name, type (client|product|person|project|brand|area|other), aliases[], description, sources[], relations[{type, target}], origin: 'auto'|'manual'}`
- [ ] AC2: `entities/entity-extractor.js` — extração automática de: (a) raízes do workspace (área→entidade area, projeto→entidade project), (b) front-matter YAML `entities:` em markdown, (c) seção `## Entidades` em `_index.md` (formato `- Nome (tipo): descrição`)
- [ ] AC3: `entities/entity-graph.js` — `buildGraph(brainDir, {roots, chunks})`: varre chunks.json detectando menções por nome/alias (case-insensitive, word-boundary) → popula `sources` e relações `mentioned-with` (co-ocorrência no mesmo arquivo); relações estruturais `belongs-to` (entidade→área de origem)
- [ ] AC4: `entities/query.js` — `getEntity(nameOrAlias)`, `listEntities({type})`, `related(name, {depth=1})`, `whereIs(name)` → arquivos-fonte ordenados por nº de menções
- [ ] AC5: Merge auto+manual: re-build preserva entidades/edições manuais (origin manual nunca sobrescrito; auto atualiza sources)
- [ ] AC6: CLI handler `entities/cli-entities.js` — `entitiesCommand(args)`: `list [--type]`, `show <nome>`, `add <nome> --type X [--alias a,b] [--desc]`, `link <a> <b> --rel tipo`, `scan` (re-extrai+re-build) — wiring como `aios brain entities` pelo lead
- [ ] AC7: Zero dependências novas (js-yaml p/ front-matter); degradação graciosa (sem chunks.json → grafo só estrutural das roots)
- [ ] AC8: Testes com workspace fake: extração das 3 fontes, menções/co-ocorrência, merge manual+auto, queries

## File List

- `.aios-core/core/brain/entities/entity-store.js` (novo)
- `.aios-core/core/brain/entities/entity-extractor.js` (novo)
- `.aios-core/core/brain/entities/entity-graph.js` (novo)
- `.aios-core/core/brain/entities/query.js` (novo)
- `.aios-core/core/brain/entities/cli-entities.js` (novo)
- `.aios-core/core/brain/entities/index.js` (novo — barrel)
- `.aios-core/core/brain/__tests__/entities.test.js` (novo)

**Fora de escopo (integração pelo lead):** `brain/cli.js` (subcomando `entities`), `brain/index.js` (reexport).
