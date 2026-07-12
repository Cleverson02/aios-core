# Story WSB-1.2: Brain Indexer (índice léxico com metadados de origem)

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-1.2
**Priority:** Critical
**Status:** Ready for Review
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 1 — Workspace + Brain MVP
**Depends On:** WSB-1.1 (contrato WorkspaceManager; consumo com degradação graciosa)

## User Story

**Como** cérebro central do AIOX,
**Quero** um indexer incremental que varre as raízes do workspace e constrói um índice léxico onde cada trecho carrega sua origem (área, tier, arquivo),
**Para** responder "onde está / o que sabemos sobre X" com fonte citada e busca escopada por área.

## Acceptance Criteria

- [x] AC1: `core/brain/indexer.js` exporta `BrainIndexer` com `index({incremental})`, `search(query, {limit, tier, area})` → `[{score, file, area, tier, heading, snippet}]` e `stats()`
- [x] AC2: Chunking por heading markdown (e por blocos para código); cada chunk com metadados `{root, tier, area, file, heading, mtime}`
- [x] AC3: Incremental por mtime — re-index sem mudanças termina em <5s em workspace típico
- [x] AC4: Denylist de segurança (node_modules, .git, .env*, chaves/segredos, binários) e limite de tamanho de arquivo
- [x] AC5: Índice persistido localmente (default `~/.aiox/brain/<hash-do-workspace>/`, override via option) — nunca dentro de pastas versionadas
- [x] AC6: Consome WorkspaceManager via try/catch (roots explícitos como fallback para testes; sem workspace.yaml → indexa cwd como projects)
- [x] AC7: CLI handler para `aios brain index|ask|status` (wiring no bin/aios.js feito pelo lead)
- [x] AC8: Zero dependências novas (fast-glob/js-yaml existentes); testes com diretórios temporários

## File List

- `.aios-core/core/brain/indexer.js` (novo)
- `.aios-core/core/brain/chunker.js` (novo)
- `.aios-core/core/brain/lexical-search.js` (novo)
- `.aios-core/core/brain/cli.js` (novo)
- `.aios-core/core/brain/index.js` (novo — barrel)
- `.aios-core/core/brain/__tests__/indexer.test.js` (novo)
- `.aios-core/core/brain/__tests__/lexical-search.test.js` (novo)

## Dev Agent Record

### Agent Model Used

Opus 4.8 (1M) — @dev (Dex)

### Debug Log References

- `npx jest .aios-core/core/brain --silent` → 2 suites, 23 tests, all passing.
- `npx eslint .aios-core/core/brain` → 0 errors (warnings auto-fixed).
- `npx tsc --noEmit` → no errors in `core/brain` (repo `checkJs: false`).

### Completion Notes List

- **Módulos entregues** (todos CommonJS + JSDoc, degradação graciosa total, zero deps novas):
  - `chunker.js` — `chunkFile(filePath, content)` com 3 estratégias: markdown por heading (#..####, split adicional por parágrafo acima de ~1500 chars), código por blocos de ~60 linhas (heading = nome do arquivo + primeira linha significativa), texto plano por parágrafo.
  - `lexical-search.js` — índice invertido serializável, `tokenize` (lowercase, mantém acentos latinos, stopwords PT+EN embutidas), `buildIndex`, `searchIndex` com scoring TF simples + boost multiplicativo (heading x2, nome do arquivo x1.5) e score normalizado 0-1.
  - `indexer.js` — `BrainIndexer` com `index({incremental})`, `search`, `stats`. Persistência em `~/.aiox/brain/<sha256 curto>/` (index.json + chunks.json + manifest.json), override via `brainDir`. Incremental por mtime (pula inalterados, remove deletados). Denylist: node_modules/.git/dist/build/coverage/.aios/.aiox/.synapse + `.env*`, `*.pem`, `*key*`, `*secret*`, `*.min.*`, binários (fora da allowlist), arquivos >1MB, JSON >50KB. Cada chunk carrega `{root, tier, area, file, heading, mtime}`.
  - `cli.js` — `brainCommand(args)` para `index [--full]`, `ask <query> [--area X] [--tier Y]`, `status`; output com chalk e fonte citada (area/file#heading + score).
  - `index.js` — barrel exportando `BrainIndexer`, `brainCommand`, `chunkFile`, `buildIndex`, `searchIndex`, `tokenize`.
- **Consumo do WorkspaceManager (AC6):** via `require('../workspace')` em try/catch. [AUTO-DECISION] `options.roots` explícitos têm **precedência** sobre o WorkspaceManager (reason: o módulo `../workspace` foi criado em paralelo e seu `load()` não lança sem `workspace.yaml` — retorna o cwd como root único —, o que tornaria os testes não-determinísticos; roots explícitos são um override de DI. O caminho de produção via `cli.js` não passa roots, portanto consome o WorkspaceManager normalmente). Fallbacks: WorkspaceManager → roots explícitos → root único `{basename(cwd), cwd, projects}`.
- **Escopo respeitado:** nada tocado em `.aios-core/core/workspace/` nem em `bin/aios.js` (wiring do CLI é do lead).
- **Demonstração real (repo aios-core, single-root degradado):** index completo = 831 arquivos, 22.852 chunks, 27.068 termos em ~2.1s; re-index incremental em ~2s (< 5s, AC3). `search('quality gates')` retorna topo `tests/integration/quality-gate-pipeline.test.js` (score 1.0), seguido dos guias `docs/.../quality-gates.md` — todos com fonte citada.

### Change Log

| Data | Versão | Descrição | Autor |
|------|--------|-----------|-------|
| 2026-07-12 | 1.0.0 | Implementação completa do Brain Indexer (chunker, lexical-search, indexer, cli, barrel, testes). Todos os 8 AC atendidos; 23 testes passando. | @dev (Dex) |
