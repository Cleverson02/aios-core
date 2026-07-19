# Story WSB-3.1: Context Budget Manager (zonas verde/amarela/vermelha)

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-3.1
**Priority:** Critical
**Status:** Ready for Review
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 3 — Autonomy Engine

## User Story

**Como** motor de autonomia,
**Quero** um gerente de orçamento de contexto com 3 zonas (verde <60%, amarela 60-80%, vermelha >80%) que aciona compressão na amarela e prepara handoff na vermelha,
**Para** sessões longas nunca degradarem por contexto inchado nem desperdiçarem tokens.

## Acceptance Criteria

- [x] AC1: `core/autonomy/context-budget-manager.js` — `ContextBudgetManager({cwd, thresholds})`: `zoneFor(percentUsed)` → GREEN|YELLOW|RED (limiares configuráveis, default 60/80); `evaluate({percentUsed, storyId, epicId})` → `{zone, action: continue|compress|handoff, recommendation}`
- [x] AC2: Zona AMARELA → `compress({epicId, storyId})` aciona o `EpicContextAccumulator` existente (REUSE) e retorna `{compressedContext, level, estimatedTokens}`
- [x] AC3: Mapeamento bracket SYNAPSE → zona documentado (FRESH/MODERATE→GREEN..YELLOW, DEPLETED→YELLOW/RED, CRITICAL→RED) com conversor `zoneFromBracket(bracket)`
- [x] AC4: Transições de zona logadas em `.aios/autonomy/zone-log.json` (append, com timestamp e storyId); EventEmitter com eventos `zone_changed`, `compress_triggered`, `handoff_recommended`
- [x] AC5: Zero dependências novas; degradação graciosa (accumulator ausente → compress retorna null com warning, nunca throw)
- [x] AC6: Testes: fronteiras de zona, thresholds custom, compress (accumulator mockado), log de transições, eventos

## File List

- `.aios-core/core/autonomy/context-budget-manager.js` (novo)
- `.aios-core/core/autonomy/__tests__/context-budget-manager.test.js` (novo)

**Fora de escopo (lead):** barrel `autonomy/index.js`, `cli.js`.

## Dev Agent Record

### Agent Model Used

Opus 4.8 (@dev / Dex)

### Implementation Log (IDS decisions)

- **REUSE** `synapse/context/context-tracker` (SYN-3) — source of truth for the real SYNAPSE brackets. No reimplementation; `zoneFromBracket` maps the tracker's real thresholds (`calculateBracket`: `>=60` FRESH, `>=40` MODERATE, `>=25` DEPLETED, else CRITICAL) onto zones.
- **REUSE** `orchestration/epic-context-accumulator` (Story 12.4) for yellow-zone compression via `buildAccumulatedContext(epicId, storyN, opts)`. Required **lazily** inside `compress()` so a missing module degrades gracefully (AC5) instead of failing at import.
- **REUSE** `orchestration/session-state` (`SessionState` + `loadSessionState`) — loaded best-effort to feed the accumulator; null-safe so no-state runs return an empty context rather than throwing.
- **ADAPT** EventEmitter pattern from `memory/gotchas-memory.js` (repo standard: `class X extends EventEmitter`, `Events` enum, `this.emit(...)`).
- **CREATE** `ContextBudgetManager` per spec — justified: no existing zone/budget manager in the codebase. The pre-existing scaffold in this untracked dir used a divergent API (`{projectRoot}`, `>redAt` boundary, JSONL log, non-EventEmitter); rewritten to match the story spec while keeping the barrel's expected exports (`ContextBudgetManager`, `calculateZone`, `Zone`, `ZONE_ACTIONS`, `DEFAULT_THRESHOLDS`, `AUTONOMY_DIR`) so `autonomy/index.js` (lead-owned) keeps resolving.

### Bracket → Zone mapping (AC3)

Zones are a function of context **used** (`used = 100 − remaining`); brackets are a function of context **remaining**. Converting each bracket's real remaining-range and applying default thresholds (yellow=60, red=80):

| Bracket | remaining% (real) | used% | Zone | Justification |
|---------|-------------------|-------|------|---------------|
| FRESH | `[60,100]` | `[0,40]` | GREEN | used < 60 throughout |
| MODERATE | `[40,60)` | `(40,60]` | GREEN | bulk < 60; only touches the YELLOW edge at used=60 |
| DEPLETED | `[25,40)` | `(60,75]` | YELLOW | `60 <= used < 80` throughout — never reaches red=80 |
| CRITICAL | `[0,25)` | `(75,100]` | RED | tracker raises `handoffWarning` here → maps to the handoff zone |

Unknown brackets → RED (mirrors the tracker treating unknown input as CRITICAL).

### Zone boundaries (AC1)

`< yellow` → GREEN; `>= yellow && < red` → YELLOW; `>= red` → RED. Verified exact: `59.9→GREEN`, `60→YELLOW`, `79.9→YELLOW`, `80→RED`.

### Completion Notes

- `evaluate()` accepts `percentUsed` **or** `bracket` (percentUsed wins). Emits `zone_changed` on per-`storyId` zone change (first eval logs `from: null`), plus `compress_triggered`/`handoff_recommended` per resolved action.
- Zone transitions persisted to `.aios/autonomy/zone-log.json` as a JSON **array** of `{timestamp, storyId, from, to, percentUsed}`; directory auto-created; corrupt/missing file tolerated (advisory, never load-bearing).
- `compress()` is async and never throws — returns `null` + `console.warn` when the accumulator is unavailable or errors (AC5).
- Zero new dependencies. `npx jest` on the suite: **32 passed**. ESLint: clean on both files.

### File List

- `.aios-core/core/autonomy/context-budget-manager.js` (new)
- `.aios-core/core/autonomy/__tests__/context-budget-manager.test.js` (new)

### Change Log

| Date | Change |
|------|--------|
| 2026-07-19 | Implemented `ContextBudgetManager` (zones GREEN/YELLOW/RED, EventEmitter, zone-log, graceful compress) + 32 tests. Status → Ready for Review. |
