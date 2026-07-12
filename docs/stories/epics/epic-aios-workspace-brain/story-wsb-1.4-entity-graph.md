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

- [x] AC1: `core/brain/entities/entity-store.js` — CRUD persistido em `entities.json` no brainDir: `{id, name, type (client|product|person|project|brand|area|other), aliases[], description, sources[], relations[{type, target}], origin: 'auto'|'manual'}`
- [x] AC2: `entities/entity-extractor.js` — extração automática de: (a) raízes do workspace (área→entidade area, projeto→entidade project), (b) front-matter YAML `entities:` em markdown, (c) seção `## Entidades` em `_index.md` (formato `- Nome (tipo): descrição`)
- [x] AC3: `entities/entity-graph.js` — `buildGraph(brainDir, {roots, chunks})`: varre chunks.json detectando menções por nome/alias (case-insensitive, word-boundary) → popula `sources` e relações `mentioned-with` (co-ocorrência no mesmo arquivo); relações estruturais `belongs-to` (entidade→área de origem)
- [x] AC4: `entities/query.js` — `getEntity(nameOrAlias)`, `listEntities({type})`, `related(name, {depth=1})`, `whereIs(name)` → arquivos-fonte ordenados por nº de menções
- [x] AC5: Merge auto+manual: re-build preserva entidades/edições manuais (origin manual nunca sobrescrito; auto atualiza sources)
- [x] AC6: CLI handler `entities/cli-entities.js` — `entitiesCommand(args)`: `list [--type]`, `show <nome>`, `add <nome> --type X [--alias a,b] [--desc]`, `link <a> <b> --rel tipo`, `scan` (re-extrai+re-build) — wiring como `aios brain entities` pelo lead
- [x] AC7: Zero dependências novas (js-yaml p/ front-matter); degradação graciosa (sem chunks.json → grafo só estrutural das roots)
- [x] AC8: Testes com workspace fake: extração das 3 fontes, menções/co-ocorrência, merge manual+auto, queries

## File List

- `.aios-core/core/brain/entities/entity-store.js` (novo)
- `.aios-core/core/brain/entities/entity-extractor.js` (novo)
- `.aios-core/core/brain/entities/entity-graph.js` (novo)
- `.aios-core/core/brain/entities/query.js` (novo)
- `.aios-core/core/brain/entities/cli-entities.js` (novo)
- `.aios-core/core/brain/entities/index.js` (novo — barrel)
- `.aios-core/core/brain/__tests__/entities.test.js` (novo)

**Fora de escopo (integração pelo lead):** `brain/cli.js` (subcomando `entities`), `brain/index.js` (reexport).

## Dev Agent Record

### Agent Model Used

@dev (Dex) — Opus 4.8 (1M)

### Status

Ready for Review

### Completion Notes

- **entity-store.js** — `EntityStore` (load/save `entities.json`), `slugify` (stable id), `get` (id/name/alias case-insensitive), `upsert` (with `preserveManual`), `remove` (also drops dangling relations), `list({type})`, `link(a,b,relType)`. Relations are **directional and typed** — `link` writes a single edge (documented in the file header); the graph builder deliberately writes both directions for `mentioned-with`.
- **entity-extractor.js** — `extractEntities({roots, chunks})` yields un-aggregated candidates from (a) structural roots (`areas`→area, `projects`→project), (b) YAML front-matter `entities:` (string or object forms, via `js-yaml` in try/catch), (c) `## Entidades` section of `_index.md` (`- Nome (tipo): descrição`, tolerant regex, type default `other`). Each candidate carries `originRoot/originTier/originFile` so the builder can derive `belongs-to`.
- **entity-graph.js** — `buildGraph(brainDir, {roots, chunks, cwd})` aggregates candidates by slug, scans mentions (single **longest-first alternation regex** with explicit Latin-aware boundaries to avoid double-counting `Acme` inside `Cliente Acme` and to reject `Acmeville`; names <3 chars ignored), derives `belongs-to` (entity defined in an area root → that area) and `mentioned-with` (co-occurrence in the same file, both directions), then persists via `EntityStore.upsert({preserveManual:true})`. Reads `chunks.json` when `chunks` not injected; roots resolved via `WorkspaceManager` (try/catch) with cwd fallback. Returns `{entities, mentionsScanned (chunks scanned), durationMs}`.
- **query.js** — `getEntity`, `listEntities({type})`, `related(nameOrId, {depth=1})` (BFS over an **undirected** view of the relation graph, labelling each neighbour with the edge type + depth), `whereIs` (sources by mentions desc).
- **cli-entities.js** — `entitiesCommand(args, {brainDir})` with `list/show/add/link/scan`, chalk output, exit codes 0/1. `add` creates `origin:'manual'` entities; `scan` = `buildGraph`. Default brainDir mirrors the indexer (`~/.aiox/brain/<sha>`), computed locally to avoid coupling to `indexer.js`.
- **IDS decisions:** REUSE — `js-yaml`/`chalk` (existing deps), `chunks.json` contract, `WorkspaceManager` root contract, indexer's `parseArgs`/`defaultBrainDir` patterns (replicated, not imported, to respect file scope). CREATE — all `entities/*` modules (no prior entity-graph code existed).
- **[AUTO-DECISION]** `related()` direction → traverse edges bidirectionally (reason: stored edges are directional, but "what belongs to marketing" requires reverse reachability; documented in query.js header).
- **[AUTO-DECISION]** `mentionsScanned` semantics → number of chunks scanned for mentions (reason: unambiguous, useful progress metric; documented in JSDoc).
- **Out of scope, untouched (lead integrates):** `brain/cli.js`, `brain/index.js`, `brain/indexer.js`, `bin/aios.js`. Suggested wiring: `brain/cli.js` add `case 'entities': return require('./entities').entitiesCommand(rest, { brainDir: indexer.brainDir });` and re-export from `brain/index.js`.

### Validations

- `npx jest .aios-core/core/brain --silent` → **51 passed / 51** (15 new in `entities.test.js`; existing indexer/lexical/semantic suites unaffected).
- `npx eslint .aios-core/core/brain/entities` → **clean** (exit 0).
- Live fixture demo (`show "Cliente Acme"`): sources `clientes/acme-brief.md (5)`, `README.md (2)`, `_index.md (1)`; relations `belongs-to → marketing`, `mentioned-with → {marketing, Ana Diretora, Plataforma X}`. Word-boundary confirmed: `Acmeville` not counted (README = 2).

### File List

- `.aios-core/core/brain/entities/entity-store.js` (novo)
- `.aios-core/core/brain/entities/entity-extractor.js` (novo)
- `.aios-core/core/brain/entities/entity-graph.js` (novo)
- `.aios-core/core/brain/entities/query.js` (novo)
- `.aios-core/core/brain/entities/cli-entities.js` (novo)
- `.aios-core/core/brain/entities/index.js` (novo — barrel)
- `.aios-core/core/brain/__tests__/entities.test.js` (novo)
- `docs/stories/epics/epic-aios-workspace-brain/story-wsb-1.4-entity-graph.md` (atualizado)

### Change Log

| Data | Versão | Descrição | Autor |
|------|--------|-----------|-------|
| 2026-07-12 | 1.0.0 | Grafo de entidades: store, extractor (3 fontes), graph (menções + belongs-to/mentioned-with), queries, CLI, testes | @dev (Dex) |
