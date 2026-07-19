# Story WSB-3.2: Handoff Packet + Fresh Window

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-3.2
**Priority:** Critical
**Status:** In Progress
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 3 — Autonomy Engine

## User Story

**Como** sessão em zona vermelha de contexto,
**Quero** gerar um pacote de handoff completo (estado do build, story, decisões, gotchas, próxima subtask) e lançar uma janela limpa que continua de onde parei,
**Para** atravessar trabalhos de horas em N janelas começando cada uma com ~5% de contexto.

## Acceptance Criteria

- [ ] AC1: `core/autonomy/handoff-packet.js` — `generateHandoffPacket({cwd, storyId, reason})` coleta: último checkpoint + próxima subtask (`BuildStateManager` REUSE), story file (caminho + checkboxes abertos), decisões recentes (`SessionMemory` + `.ai/`), gotchas relevantes, snapshot de zona
- [ ] AC2: Pacote gravado em `.aios/autonomy/handoffs/<storyId>-<n>.md` (front-matter + seções legíveis) e gêmeo `.json`; numeração incremental, nunca sobrescreve; retorna `{path, jsonPath, packet}`
- [ ] AC3: `core/autonomy/fresh-window.js` — `spawnFreshWindow({packetPath, agent='dev', dryRun})` usa o `terminal-spawner` existente (REUSE) para abrir sessão nova com prompt de continuação apontando o pacote; ambiente sem terminal visual → `{spawned:false, instructions}` com o comando pronto para copiar (nunca falha)
- [ ] AC4: `loadHandoffPacket(pathOrStoryId)` → resolve o pacote mais recente da story para o resume
- [ ] AC5: Zero dependências novas; toda fonte ausente → seção omitida (degradação graciosa)
- [ ] AC6: Testes com fixtures em tmp: geração completa, numeração -2/-3, fontes ausentes, load do mais recente, spawn com terminal-spawner mockado + dryRun

## File List

- `.aios-core/core/autonomy/handoff-packet.js` (novo)
- `.aios-core/core/autonomy/fresh-window.js` (novo)
- `.aios-core/core/autonomy/__tests__/handoff.test.js` (novo)

**Fora de escopo (lead):** barrel, `cli.js` (`aios run handoff|resume`).
