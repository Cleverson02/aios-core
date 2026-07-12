# Story WSB-1.2: Brain Indexer (índice léxico com metadados de origem)

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-1.2
**Priority:** Critical
**Status:** In Progress
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

- [ ] AC1: `core/brain/indexer.js` exporta `BrainIndexer` com `index({incremental})`, `search(query, {limit, tier, area})` → `[{score, file, area, tier, heading, snippet}]` e `stats()`
- [ ] AC2: Chunking por heading markdown (e por blocos para código); cada chunk com metadados `{root, tier, area, file, heading, mtime}`
- [ ] AC3: Incremental por mtime — re-index sem mudanças termina em <5s em workspace típico
- [ ] AC4: Denylist de segurança (node_modules, .git, .env*, chaves/segredos, binários) e limite de tamanho de arquivo
- [ ] AC5: Índice persistido localmente (default `~/.aiox/brain/<hash-do-workspace>/`, override via option) — nunca dentro de pastas versionadas
- [ ] AC6: Consome WorkspaceManager via try/catch (roots explícitos como fallback para testes; sem workspace.yaml → indexa cwd como projects)
- [ ] AC7: CLI handler para `aios brain index|ask|status` (wiring no bin/aios.js feito pelo lead)
- [ ] AC8: Zero dependências novas (fast-glob/js-yaml existentes); testes com diretórios temporários

## File List

- `.aios-core/core/brain/indexer.js` (novo)
- `.aios-core/core/brain/chunker.js` (novo)
- `.aios-core/core/brain/lexical-search.js` (novo)
- `.aios-core/core/brain/cli.js` (novo)
- `.aios-core/core/brain/index.js` (novo — barrel)
- `.aios-core/core/brain/__tests__/indexer.test.js` (novo)
- `.aios-core/core/brain/__tests__/lexical-search.test.js` (novo)
