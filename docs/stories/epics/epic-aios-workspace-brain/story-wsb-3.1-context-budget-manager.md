# Story WSB-3.1: Context Budget Manager (zonas verde/amarela/vermelha)

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-3.1
**Priority:** Critical
**Status:** In Progress
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 3 — Autonomy Engine

## User Story

**Como** motor de autonomia,
**Quero** um gerente de orçamento de contexto com 3 zonas (verde <60%, amarela 60-80%, vermelha >80%) que aciona compressão na amarela e prepara handoff na vermelha,
**Para** sessões longas nunca degradarem por contexto inchado nem desperdiçarem tokens.

## Acceptance Criteria

- [ ] AC1: `core/autonomy/context-budget-manager.js` — `ContextBudgetManager({cwd, thresholds})`: `zoneFor(percentUsed)` → GREEN|YELLOW|RED (limiares configuráveis, default 60/80); `evaluate({percentUsed, storyId, epicId})` → `{zone, action: continue|compress|handoff, recommendation}`
- [ ] AC2: Zona AMARELA → `compress({epicId, storyId})` aciona o `EpicContextAccumulator` existente (REUSE) e retorna `{compressedContext, level, estimatedTokens}`
- [ ] AC3: Mapeamento bracket SYNAPSE → zona documentado (FRESH/MODERATE→GREEN..YELLOW, DEPLETED→YELLOW/RED, CRITICAL→RED) com conversor `zoneFromBracket(bracket)`
- [ ] AC4: Transições de zona logadas em `.aios/autonomy/zone-log.json` (append, com timestamp e storyId); EventEmitter com eventos `zone_changed`, `compress_triggered`, `handoff_recommended`
- [ ] AC5: Zero dependências novas; degradação graciosa (accumulator ausente → compress retorna null com warning, nunca throw)
- [ ] AC6: Testes: fronteiras de zona, thresholds custom, compress (accumulator mockado), log de transições, eventos

## File List

- `.aios-core/core/autonomy/context-budget-manager.js` (novo)
- `.aios-core/core/autonomy/__tests__/context-budget-manager.test.js` (novo)

**Fora de escopo (lead):** barrel `autonomy/index.js`, `cli.js`.
