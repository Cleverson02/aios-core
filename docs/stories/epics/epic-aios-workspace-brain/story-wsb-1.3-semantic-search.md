# Story WSB-1.3: Busca Semântica Local (provider plugável)

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-1.3
**Priority:** High
**Status:** In Progress
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 1 — Workspace + Brain MVP
**Depends On:** WSB-1.2 (consome chunks.json persistido pelo BrainIndexer)

## User Story

**Como** cérebro central,
**Quero** uma camada de busca semântica local com provider de vetorização plugável sobre o índice léxico,
**Para** encontrar conteúdo por conceito ("gestão de contexto" acha "gerenciamento de janela") e não apenas por termo exato — sem nenhum documento sair da máquina por padrão.

## Decisão de arquitetura (ajuste consciente vs. épico)

O épico citava "SQLite vetorial (ex.: sqlite-vec)" — isso exigiria dependência nativa nova. Decisão (alinhada às decisões #3 embeddings local-first e zero-deps do MVP): **interface `VectorProvider` plugável** com:
1. `HashingVectorProvider` (default, zero deps) — vetores densos por hashing de n-gramas de caracteres; captura similaridade fuzzy/morfológica PT/EN
2. `ApiEmbeddingProvider` (opt-in explícito via env) — desabilitado por padrão
3. Provider neural local (transformers.js) fica como extensão futura opcional documentada

Store vetorial em `vectors.json` no brainDir (Float32 serializado base64). sqlite-vec vira otimização futura se o volume exigir.

## Acceptance Criteria

- [ ] AC1: `core/brain/semantic/vector-provider.js` com interface (`name`, `dim`, `embed(texts) → float[][]`) + `HashingVectorProvider` (n-gramas 3-5, dim 512, normalizado L2)
- [ ] AC2: `ApiEmbeddingProvider` opt-in: só ativa com `AIOX_EMBEDDINGS_PROVIDER` + chave via env; sem env → nunca usado; nenhum request sem opt-in (testado)
- [ ] AC3: `core/brain/semantic/semantic-store.js` — `buildVectors(brainDir, {provider})` lê chunks.json e persiste vectors.json incremental (por id de chunk; re-embed só de chunks novos/alterados via mtime); `loadVectors(brainDir)`
- [ ] AC4: `core/brain/semantic/hybrid-search.js` — `semanticSearch(brainDir, query, {limit, tier, area, provider})` → cosine top-K; `hybridSearch(...)` combina score léxico + semântico (0.5/0.5 configurável) reusando `searchIndex` existente
- [ ] AC5: Resultado no mesmo formato do search léxico `[{score, file, area, tier, heading, snippet}]` + campo `matchType: 'lexical'|'semantic'|'hybrid'`
- [ ] AC6: Zero dependências novas; degradação graciosa (vectors.json ausente → hybridSearch cai para léxico puro com warning)
- [ ] AC7: Testes: fuzzy match que o léxico não acha (ex.: singular/plural/radical), opt-in da API nunca dispara sem env, incremental re-embed, fallback

## File List

- `.aios-core/core/brain/semantic/vector-provider.js` (novo)
- `.aios-core/core/brain/semantic/semantic-store.js` (novo)
- `.aios-core/core/brain/semantic/hybrid-search.js` (novo)
- `.aios-core/core/brain/semantic/index.js` (novo — barrel)
- `.aios-core/core/brain/__tests__/semantic.test.js` (novo)

**Fora de escopo (integração pelo lead):** `brain/cli.js` (`ask --semantic|--hybrid`), `brain/indexer.js` (hook pós-index), `brain/index.js` (reexport).
