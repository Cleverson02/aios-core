# Story WSB-1.6: Session Digest — o cérebro aprende com cada sessão

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-1.6
**Priority:** High
**Status:** In Progress
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 1 — Workspace + Brain MVP
**Depends On:** WSB-0.2 (SessionMemory), WSB-1.2 (indexação)

## User Story

**Como** cérebro central,
**Quero** que ao fim de cada sessão/story um digest (decisões, aprendizados, arquivos tocados, commits) seja gravado como documento no workspace e indexado,
**Para** que o conhecimento produzido trabalhando vire memória consultável da empresa — inclusive pela equipe (digest é versionado em git).

## Decisão de design

Digests são **conhecimento compartilhado** → vivem no conteúdo do projeto (`docs/digests/YYYY-MM-DD-<slug>.md`), não no brainDir local. Assim: versionados em git, visíveis para a equipe, e indexados naturalmente pelo `brain index`.

## Acceptance Criteria

- [ ] AC1: `core/brain/digest.js` — `generateDigest({cwd, storyId, summary, agent, dryRun})` coleta: commits recentes do git (desde o último digest; fallback últimos 10), arquivos alterados, decisões da SessionMemory (WSB-0.2) e dos decision logs `.ai/`, gotchas recentes (se disponíveis)
- [ ] AC2: Digest gravado em `docs/digests/YYYY-MM-DD-<slug>.md` com front-matter (`date`, `story`, `agent`, `entities:` quando detectáveis) e seções: Resumo, Decisões, Arquivos, Commits, Aprendizados
- [ ] AC3: Pós-gravação dispara index incremental (BrainIndexer) — digest consultável via `aios brain ask` imediatamente
- [ ] AC4: Degradação graciosa total: sem git → seções de git omitidas; sem SessionMemory/decision logs → seções omitidas; nunca throw
- [ ] AC5: `digestCommand(args)` exportado para wiring como `aios brain digest [--story X] [--summary "..."] [--agent Y] [--dry-run]` (wiring pelo lead)
- [ ] AC6: Idempotência diária: segundo digest no mesmo dia com mesmo slug incrementa sufixo (-2, -3), nunca sobrescreve
- [ ] AC7: Zero dependências novas; testes com repo git de fixture em tmp (init + commits) e fixture sem git

## File List

- `.aios-core/core/brain/digest.js` (novo)
- `.aios-core/core/brain/__tests__/digest.test.js` (novo)

**Fora de escopo (lead):** wiring do subcomando em `brain/cli.js`; barrel.
