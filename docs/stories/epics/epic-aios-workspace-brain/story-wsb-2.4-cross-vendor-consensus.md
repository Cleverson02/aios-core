# Story WSB-2.4: Consenso Cross-Vendor

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-2.4
**Priority:** High
**Status:** Ready for Review (inicia após WSB-2.2)
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 2 — LLM Router
**Depends On:** WSB-2.2 (providers codex/grok na factory)

## User Story

**Como** operador tomando decisões críticas,
**Quero** os modos RACE/CONSENSUS/BEST_OF do parallel-executor estendidos para lista arbitrária de providers (resolvida via factory) com preset "critical-review" (Opus + Codex + Grok votam),
**Para** que decisões de arquitetura e reviews críticos tenham rede de segurança multi-fornecedor com votos registrados em decision log.

## Acceptance Criteria

- [x] AC1: `parallel-executor.js` aceita N providers (lista por nome via factory) mantendo compat com a API atual de 2 providers
- [x] AC2: CONSENSUS com N: maioria simples decide; empate → BEST_OF como desempate; votos individuais preservados no resultado
- [x] AC3: Preset `critical-review` = [claude, codex, grok] (configurável); providers indisponíveis são pulados com warning (mínimo 2 para consenso)
- [x] AC4: Votos registrados em decision log (`.ai/`) no formato ADR existente
- [x] AC5: Testes com providers mockados: 3-way consenso, empate, provider indisponível, compat 2-provider preservada

## File List (previsto)

- `.aios-core/core/execution/parallel-executor.js` (modificado)
- Testes no padrão existente

## Dev Agent Record

**Agent Model Used:** Opus 4.8 (dev / Dex)

### Implementation Notes

- New N-provider entrypoint `executeWithProviders(providersOrPreset, prompt, options)` added to `ParallelExecutor`. The classic 2-provider `execute(claudeFn, geminiFn, options)` is untouched — regression test `backward compatibility (2-provider execute)` plus all pre-existing cases confirm compat (AC1).
- Providers resolved by name via `ai-provider-factory.getProvider()` (factory NOT modified — codex/grok already registered by WSB-2.2). Availability probed in parallel with `checkAvailability()`; unavailable / unknown providers are pushed to `skipped: [{name, reason}]` with a warning and execution proceeds with the rest (AC3).
- Minimum-availability gate: CONSENSUS requires ≥2 available providers; below that a structured error `{ success:false, code:'INSUFFICIENT_PROVIDERS', available, skipped }` is returned (no throw) (AC3).
- CONSENSUS N-way: responses are grouped by the EXISTING consensus criterion (`_calculateSimilarity` ≥ `consensusSimilarity`, the same Jaccard heuristic used by the 2-provider path — extended, not reinvented). Largest group = simple majority winner; the winner within the group is the highest-scored member (`_scoreOutput`). Ties (including all-distinct 1-1-1) fall back to BEST_OF scoring (`tiebreak: 'best-of'`). Result carries `votes: [{provider, response, group}]`, `groups`, `winner`, `skipped` (AC2).
- RACE (first success in provider order) and BEST_OF (highest `_scoreOutput`) generalized to N.
- Preset `CONSENSUS_PRESETS = { 'critical-review': ['claude','codex','grok'] }` exported; passing a preset name (string) resolves it. Project override via `.aios/consensus-presets.yaml` (matching key replaces built-in; merged in `_loadPresets`, js-yaml already a dep) (AC3).
- Decision log (AC4): on CONSENSUS completion, `_writeConsensusDecisionLog` writes `.ai/decision-log-consensus-{id}.md` in the existing ADR markdown style (header/`## Votes` table with per-provider group/`## Winner`/`## Skipped Providers`/ADR footer), modeled on `.aios-core/development/scripts/decision-log-generator.js` (that story-oriented generator cannot model per-provider votes, so a dedicated writer was added in-file — [AUTO-DECISION]). Skipped when `options.decisionLog === false`; honors `options.cwd` for the target root.

### Key Decisions (IDS)

- REUSE `ai-provider-factory.getProvider` + `checkAvailability` for provider resolution (no factory changes).
- REUSE `_calculateSimilarity` / `consensusSimilarity` for N-way grouping and `_scoreOutput` for BEST_OF + tiebreak — extends the real existing criterion rather than inventing a new one.
- ADAPT the ADR markdown format from `decision-log-generator.js` into an in-file consensus writer (votes/groups/winner/skipped not representable by the existing story generator).
- Lazy `require` of the factory + lazy `js-yaml` so the classic 2-provider path stays decoupled and light. Zero new dependencies.

### Testing

- `tests/core/execution/parallel-executor.test.js`: 16 pre-existing tests untouched + 11 new (preset export, 3-way majority 2-1, 1-1-1 tie→BEST_OF, unavailable provider skipped, <2 available structured error, preset string resolution, unknown provider skipped, RACE N, BEST_OF N, decision-log written to tmp cwd, 2-provider compat). Full file: 27/27 passing.
- Broader gate `npx jest .aios-core/core/execution tests/core`: 56 suites / 2172 tests passing. ESLint clean on both files.

### File List

- `.aios-core/core/execution/parallel-executor.js` (modified)
- `tests/core/execution/parallel-executor.test.js` (modified — new tests added, existing untouched)
- `docs/stories/epics/epic-aios-workspace-brain/story-wsb-2.4-cross-vendor-consensus.md` (modified — status/ACs/record)

### Change Log

| Date | Change |
|------|--------|
| 2026-07-13 | Status Draft → In Progress; implemented N-provider RACE/CONSENSUS/BEST_OF + critical-review preset + `.ai/` consensus decision log; added 11 tests; ACs 1-5 marked complete. |
