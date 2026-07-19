# Story WSB-4.8: Modo Guiado — "qual o próximo passo?" sem curso nem tokens

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-4.8
**Priority:** Critical (facilidade de uso ≥ AIOS)
**Status:** Ready for Review
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 4 — Gateway + UX + Economia

## User Story

**Como** usuário que NÃO conhece a metodologia AIOS,
**Quero** que o sistema me diga a cada momento qual é o próximo agente/comando da sequência (com o porquê em 1 frase),
**Para** não queimar tokens nem quebrar a cabeça descobrindo a ordem @po → @dev → @qa → @devops.

## Insight de reuso

O `workflow-intelligence` JÁ tem `getSuggestions(context)` (registry de workflows + confidence scorer + `*next`). O gap é de EXPOSIÇÃO: não existe comando de primeira classe nem detecção automática de estado do projeto. Esta story é 80% wiring determinístico, 0% LLM.

## Acceptance Criteria

- [x] AC1: `core/guide/project-state.js` — detecção determinística do estado: tem PRD? arquitetura? stories (status de cada)? builds ativos? git sujo? → `{stage: ideation|planning|architecture|development|review|done, evidence[]}`
- [x] AC2: `core/guide/next-step.js` — combina project-state + WIS `getSuggestions` (REUSE) + status das stories → `{nextAgent, nextCommand, why (1 frase), alternatives[]}`; tabela de sequência da metodologia embutida como fallback quando o WIS não tem confiança
- [x] AC3: `aios next` CLI: mostra o próximo passo com o comando pronto para copiar (ex.: "@sm *create-story — a story WSB-X foi aprovada, falta detalhar a próxima"); `aios next --explain` mostra o mapa completo do fluxo com onde você está
- [~] AC4: Onboarding — PARCIAL: `docs/guides/primeiros-passos-cortex.md` (PT, 10 passos) entregue. A ponte de exibir `aios next` ao final de `aios setup` (WSB-4.4) e de `aios workspace init` é do LEAD (fora de escopo deste agente — não tocar bin/aios.js / setup-wizard.js). `nextCommand(args)` já está pronto para ser chamado por esses fluxos.
- [x] AC5: Zero LLM, zero dependências novas; testes: cada stage detectado com fixtures, próximo passo por stage, fallback sem WIS, sugestão pós-setup (18 testes verdes)

## File List

- `.aios-core/core/guide/project-state.js` (novo)
- `.aios-core/core/guide/next-step.js` (novo)
- `.aios-core/core/guide/cli.js` (novo)
- `.aios-core/core/guide/index.js` (novo — barrel)
- `docs/guides/primeiros-passos-cortex.md` (novo)
- `.aios-core/core/guide/__tests__/guide.test.js` (novo)

**Fora de escopo (lead):** wiring `aios next` no bin/aios.js.

## Dev Agent Record

**Agent Model Used:** Opus 4.8 (claude-opus-4-8[1m])
**Agent:** @dev (Dex)

### File List

- `.aios-core/core/guide/project-state.js` (novo) — `detectProjectState({cwd})` determinístico por filesystem.
- `.aios-core/core/guide/next-step.js` (novo) — `getNextStep({cwd})`: WIS `getSuggestions` (REUSE) com fallback de metodologia.
- `.aios-core/core/guide/cli.js` (novo) — `nextCommand(args)`: bloco padrão, `--explain` (mapa do fluxo), `--json`.
- `.aios-core/core/guide/index.js` (novo) — barrel `{detectProjectState, getNextStep, nextCommand}`.
- `.aios-core/core/guide/__tests__/guide.test.js` (novo) — 18 testes.
- `docs/guides/primeiros-passos-cortex.md` (novo) — guia PT de 10 passos.

### Completion Notes

- **Zero LLM / zero deps novas.** Tudo derivado de disco + `git status --porcelain` (execFile em try/catch — git ausente não quebra). Reusos: WIS `getSuggestions` (`../../workflow-intelligence`), `SessionContextLoader` (contexto da sessão, mesmo schema `.aios/session-state.json`), `WorkspaceManager.findManifest` (hasWorkspace), `BrainIndexer.defaultBrainDir` (hasBrainIndex) — todos via require lazy protegido.
- **Stage derivation** (ordem estrita): sem PRD→ideation; PRD sem arch→architecture; arch sem stories→planning; in-progress/approved ou build ativo→development; todas ready-for-review→review; todas done→done.
- **next-step:** WIS consultado primeiro; só vence com `confidence >= 0.5` (espelha `LOW_CONFIDENCE_THRESHOLD`). Sem contexto de sessão (lastCommands vazio) → WIS não é acionado → metodologia. Build ativo → `aios run resume`. Development aponta para a story in-progress mais recente (natural sort por id).
- **AC4 parcial:** o guia PT foi entregue e `nextCommand(args)` está exportado e pronto; a chamada ao final de `aios setup` / `aios workspace init` cabe ao lead (bin/aios.js e setup-wizard.js estão fora do escopo deste agente).
- **Validação:** `npx jest .aios-core/core/guide --silent` → 18/18 verdes. `npx eslint .aios-core/core/guide/` → limpo (exit 0). `tsc` não cobre estes arquivos (`checkJs: false`).
- **Nota de estado do repo:** no aios-core não há `docs/prd.md`/`docs/prd/`, então `aios next` reporta corretamente `ideation` (comportamento determinístico esperado pela spec).

### Change Log

| Data | Mudança |
|------|---------|
| 2026-07-19 | Implementação inicial do Modo Guiado (project-state, next-step, cli, barrel, guia PT, 18 testes). Status → Ready for Review. |
