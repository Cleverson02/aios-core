# Story WSB-1.3: Busca Semântica Local (provider plugável)

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-1.3
**Priority:** High
**Status:** Ready for Review
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

- [x] AC1: `core/brain/semantic/vector-provider.js` com interface (`name`, `dim`, `embed(texts) → float[][]`) + `HashingVectorProvider` (n-gramas 3-5, dim 512, normalizado L2)
- [x] AC2: `ApiEmbeddingProvider` opt-in: só ativa com `AIOX_EMBEDDINGS_PROVIDER` + chave via env; sem env → nunca usado; nenhum request sem opt-in (testado)
- [x] AC3: `core/brain/semantic/semantic-store.js` — `buildVectors(brainDir, {provider})` lê chunks.json e persiste vectors.json incremental (por id de chunk; re-embed só de chunks novos/alterados via mtime); `loadVectors(brainDir)`
- [x] AC4: `core/brain/semantic/hybrid-search.js` — `semanticSearch(brainDir, query, {limit, tier, area, provider})` → cosine top-K; `hybridSearch(...)` combina score léxico + semântico (0.5/0.5 configurável) reusando `searchIndex` existente
- [x] AC5: Resultado no mesmo formato do search léxico `[{score, file, area, tier, heading, snippet}]` + campo `matchType: 'lexical'|'semantic'|'hybrid'`
- [x] AC6: Zero dependências novas; degradação graciosa (vectors.json ausente → hybridSearch cai para léxico puro com warning)
- [x] AC7: Testes: fuzzy match que o léxico não acha (ex.: singular/plural/radical), opt-in da API nunca dispara sem env, incremental re-embed, fallback

## File List

- `.aios-core/core/brain/semantic/vector-provider.js` (novo)
- `.aios-core/core/brain/semantic/semantic-store.js` (novo)
- `.aios-core/core/brain/semantic/hybrid-search.js` (novo)
- `.aios-core/core/brain/semantic/index.js` (novo — barrel)
- `.aios-core/core/brain/__tests__/semantic.test.js` (novo)

**Fora de escopo (integração pelo lead):** `brain/cli.js` (`ask --semantic|--hybrid`), `brain/indexer.js` (hook pós-index), `brain/index.js` (reexport).

## Dev Agent Record

### Agent Model Used
Dex (Builder) — claude-opus-4-8[1m]

### Implementation Notes

- **VectorProvider (AC1/AC2):** `HashingVectorProvider` (default, zero-dep) usa n-gramas de caracteres 3-5 sobre texto lowercase sem pontuação (com marcadores de borda `#token#` para capturar prefixo/sufixo — é o que casa singular/plural e radicais), projetados por *signed feature hashing* clássico (Weinberger 2009) em `dim=512` com dois hashes FNV-1a independentes (bucket + sinal) e normalização L2. Totalmente determinístico. `ApiEmbeddingProvider.create()` retorna `null` a menos que `AIOX_EMBEDDINGS_PROVIDER` **e** a chave (`OPENAI_API_KEY`/`VOYAGE_API_KEY`) existam; a factory nunca faz request. `resolveProvider()`: explícito > API (opt-in) > Hashing.
- **Store (AC3):** `buildVectors(brainDir, {provider})` lê `chunks.json`, embeda `heading + '\n' + text` truncado a 2000 chars em batches de 64, persiste `vectors.json` (Float32 → base64). Incremental por `mtime` **e** identidade do provider (mudança de provider invalida cache); remove ids sumidos. `loadVectors` decodifica para `Float32Array` (bytes copiados p/ ArrayBuffer exato, sem aliasing de pool).
- **Search (AC4/AC5):** `semanticSearch` = cosine (dot de vetores L2) top-K com filtro tier/area; `hybridSearch` une léxico (reusa `searchIndex` real sobre `index.json`) + semântico, score `0.5*lex + 0.5*sem` (pesos configuráveis, lado ausente = 0), `matchType: 'hybrid'`. Formato idêntico ao léxico + `matchType`.
- **Degradação graciosa (AC6):** `[AUTO-DECISION]` assinatura array preservada. Sem `vectors.json`, `hybridSearch` cai para léxico puro (`matchType: 'lexical'`) com `console.warn` único (guard por processo). Para consumidores que precisam do aviso programaticamente, exportei `hybridSearchWithMeta` → `{results, degraded, warnings}`. Decisão documentada no header de `hybrid-search.js`.
- **IDS:** SEARCH → nenhum código vetorial/semântico prévio no `brain/` (só léxico). DECIDE → CREATE camada semântica; REUSE `searchIndex` (lexical-search) e `BrainIndexer` (fixtures de teste); estilo CommonJS + JSDoc do `brain/` existente.

### Medição real (repo aios-core)
- Indexação: 833 arquivos → **22.868 chunks** em 2.096 ms.
- `buildVectors` 1ª passada: 22.868 embeddings em **1.898 ms** (HashingVectorProvider, dim 512); `vectors.json` = 60,7 MB.
- `buildVectors` 2ª passada (incremental): embedded=0, **reused=22.868**, removed=0 em 576 ms.
- Query conceitual `"gestao de contexto e janela deslizante"`:
  - `semanticSearch` top-1: `docs/pt/guides/user-guide.md :: 4. Mantenha o Contexto` (0.5581) — acha por conceito sem match de termo exato ("gestao"/"gerenciamento").
  - `hybridSearch` top-1: `docs/pt/platforms/roo-code.md :: Arquivos de Contexto de Modo` (0.7719, matchType hybrid).

### Testes
`npx jest .aios-core/core/brain --silent` → **36 passed** (23 pré-existentes intactos + 13 novos). `npx eslint .aios-core/core/brain/semantic` → 0 erros, 0 warnings. Cobertos: fuzzy match que o léxico erra (léxico retorna `[]`, semântico acha), determinismo do Hashing, incremental (reused>0), remoção de chunks deletados, `ApiEmbeddingProvider.create()` → null sem env (fetch mockado nunca chamado), fallback léxico sem `vectors.json`, filtros area/tier, invalidação de cache por troca de provider.

### File List
- `.aios-core/core/brain/semantic/vector-provider.js` (novo)
- `.aios-core/core/brain/semantic/semantic-store.js` (novo)
- `.aios-core/core/brain/semantic/hybrid-search.js` (novo)
- `.aios-core/core/brain/semantic/index.js` (novo — barrel)
- `.aios-core/core/brain/__tests__/semantic.test.js` (novo)
- `docs/stories/epics/epic-aios-workspace-brain/story-wsb-1.3-semantic-search.md` (atualizado)

### Change Log
| Data | Versão | Descrição | Autor |
|------|--------|-----------|-------|
| 2026-07-12 | 1.0.0 | Camada de busca semântica local (HashingVectorProvider + vector store incremental + hybrid search) | @dev (Dex) |
