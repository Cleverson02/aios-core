# Story WSB-3.2: Handoff Packet + Fresh Window

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-3.2
**Priority:** Critical
**Status:** Ready for Review
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 3 — Autonomy Engine

## User Story

**Como** sessão em zona vermelha de contexto,
**Quero** gerar um pacote de handoff completo (estado do build, story, decisões, gotchas, próxima subtask) e lançar uma janela limpa que continua de onde parei,
**Para** atravessar trabalhos de horas em N janelas começando cada uma com ~5% de contexto.

## Acceptance Criteria

- [x] AC1: `core/autonomy/handoff-packet.js` — `generateHandoffPacket({cwd, storyId, reason})` coleta: último checkpoint + próxima subtask (`BuildStateManager` REUSE), story file (caminho + checkboxes abertos), decisões recentes (`SessionMemory` + `.ai/`), gotchas relevantes, snapshot de zona
- [x] AC2: Pacote gravado em `.aios/autonomy/handoffs/<storyId>-<n>.md` (front-matter + seções legíveis) e gêmeo `.json`; numeração incremental, nunca sobrescreve; retorna `{path, jsonPath, packet}`
- [x] AC3: `core/autonomy/fresh-window.js` — `spawnFreshWindow({packetPath, agent='dev', dryRun})` usa o `terminal-spawner` existente (REUSE) para abrir sessão nova com prompt de continuação apontando o pacote; ambiente sem terminal visual → `{spawned:false, instructions}` com o comando pronto para copiar (nunca falha)
- [x] AC4: `loadHandoffPacket(pathOrStoryId)` → resolve o pacote mais recente da story para o resume
- [x] AC5: Zero dependências novas; toda fonte ausente → seção omitida (degradação graciosa)
- [x] AC6: Testes com fixtures em tmp: geração completa, numeração -2/-3, fontes ausentes, load do mais recente, spawn com terminal-spawner mockado + dryRun

## File List

- `.aios-core/core/autonomy/handoff-packet.js` (novo)
- `.aios-core/core/autonomy/fresh-window.js` (novo)
- `.aios-core/core/autonomy/__tests__/handoff.test.js` (novo)

**Fora de escopo (lead):** barrel, `cli.js` (`aios run handoff|resume`).

---

## Dev Agent Record

### Agent Model Used

Opus 4.8 (claude-opus-4-8[1m]) — @dev (Dex)

### Completion Notes

- `handoff-packet.js`: `generateHandoffPacket({cwd, storyId, reason, zoneSnapshot})` reúne build-state (via `BuildStateManager.loadState()` + `getLastCheckpoint()`, com `nextSubtask` derivada de `currentSubtask` ∉ `completedSubtasks`), story (scan recursivo de `docs/stories` por `story*<id>*.md`, case-insensitive; extrai linhas `- [ ]` abertas e contagem de concluídas), decisões (`SessionMemory.getDecisions({limit:10})` + títulos de `.ai/*.md`) e gotchas relevantes (`GotchasMemory.getContextForTask`). Grava twins `.aios/autonomy/handoffs/<storyId>-<n>.{md,json}` com `<n>` incremental que NUNCA sobrescreve (varre o dir pelo maior n). Retorna `{path, jsonPath, packet}` (`markdownPath` também incluso).
- `loadHandoffPacket(storyIdOrPath, {cwd})`: resolve o maior `<n>` da story, ou carrega direto de um path `.json`/`.md` (lê o twin). Retorna `{packet, path, markdown}` ou `null`.
- `fresh-window.js`: `buildContinuationPrompt(packet)` gera prompt com resumo de 3 linhas (story/build/próxima subtask). `spawnFreshWindow({packetPath, agent, cwd, dryRun})` faz lazy-require do `terminal-spawner` real; `dryRun` → `{spawned:false, dryRun:true, command}`; ambiente headless (`detectEnvironment().supportsVisualTerminal === false`), spawner indisponível ou falha de spawn → `{spawned:false, instructions}` (comando `aios run resume <storyId>` pronto para copiar). Nunca lança (AC3).
- Degradação graciosa total (AC5): toda fonte ausente vira `null`/`[]` e a seção correspondente é omitida do Markdown. Zero dependências novas (apenas `fs`/`path`, mais requires lazy dos módulos REUSE já existentes).
- Testes: 11 casos, todos passando (`npx jest .aios-core/core/autonomy/__tests__/handoff.test.js --silent`). Fixtures em `os.tmpdir()`; `terminal-spawner` mockado via `jest.mock` — nenhum spawn real. ESLint limpo (0 erros/0 warnings) nos três arquivos.

### Coordination Note (para o lead)

Os arquivos lead-owned `index.js` e `cli.js` (não commitados, fora do meu escopo) referenciam a API de rascunho anterior de `handoff-packet.js`. Para não quebrá-los, `handoff-packet.js` mantém re-exports compatíveis: `loadLatestHandoffPacket({storyId, projectRoot})`, `renderMarkdown`, `HANDOFF_DIR` (agora `.aios/autonomy/handoffs`) e `PACKET_SCHEMA_VERSION` — o barrel carrega sem erro. Porém `spawnFreshWindow` migrou para `fresh-window.js` com nova assinatura (`{packetPath,...}` em vez de `(packet, options)`). O `cli.js` (`run handoff --spawn`) precisa passar a importar `spawnFreshWindow`/`buildContinuationPrompt` de `./fresh-window` e adaptar a chamada (`{ packetPath: jsonPath }`). `generateHandoffPacket` mudou de `{projectRoot}` para `{cwd}` e retorna `{path, jsonPath, packet}` (inclui `markdownPath` como alias para compatibilidade).

### File List

- `.aios-core/core/autonomy/handoff-packet.js` (novo)
- `.aios-core/core/autonomy/fresh-window.js` (novo)
- `.aios-core/core/autonomy/__tests__/handoff.test.js` (novo)
- `docs/stories/epics/epic-aios-workspace-brain/story-wsb-3.2-handoff-fresh-window.md` (atualizado)

### Change Log

| Data | Versão | Descrição | Autor |
|------|--------|-----------|-------|
| 2026-07-19 | 1.0.0 | Implementação de handoff-packet.js + fresh-window.js + testes (11 casos). ACs 1-6 completos. | @dev (Dex) |
