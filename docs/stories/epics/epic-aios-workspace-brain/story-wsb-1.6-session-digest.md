# Story WSB-1.6: Session Digest — o cérebro aprende com cada sessão

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-1.6
**Priority:** High
**Status:** Ready for Review
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

- [x] AC1: `core/brain/digest.js` — `generateDigest({cwd, storyId, summary, agent, dryRun})` coleta: commits recentes do git (desde o último digest; fallback últimos 10), arquivos alterados, decisões da SessionMemory (WSB-0.2) e dos decision logs `.ai/`, gotchas recentes (se disponíveis)
- [x] AC2: Digest gravado em `docs/digests/YYYY-MM-DD-<slug>.md` com front-matter (`date`, `story`, `agent`, `entities:` quando detectáveis) e seções: Resumo, Decisões, Arquivos, Commits, Aprendizados
- [x] AC3: Pós-gravação dispara index incremental (BrainIndexer) — digest consultável via `aios brain ask` imediatamente
- [x] AC4: Degradação graciosa total: sem git → seções de git omitidas; sem SessionMemory/decision logs → seções omitidas; nunca throw
- [x] AC5: `digestCommand(args)` exportado para wiring como `aios brain digest [--story X] [--summary "..."] [--agent Y] [--dry-run]` (wiring pelo lead)
- [x] AC6: Idempotência diária: segundo digest no mesmo dia com mesmo slug incrementa sufixo (-2, -3), nunca sobrescreve
- [x] AC7: Zero dependências novas; testes com repo git de fixture em tmp (init + commits) e fixture sem git

## File List

- `.aios-core/core/brain/digest.js` (novo)
- `.aios-core/core/brain/__tests__/digest.test.js` (novo)

**Fora de escopo (lead):** wiring do subcomando em `brain/cli.js`; barrel.

## Dev Agent Record

### Agent Model Used

Opus 4.8 (claude-opus-4-8[1m]) — @dev (Dex)

### Implementation Log (IDS decisions)

| Componente | Decisão | Justificativa |
|-----------|---------|---------------|
| `execFile` + `promisify` (git) | CREATE | Sem helper git existente em `brain/`; git sempre via `execFile('git', args)` (nunca shell-interpolado), tudo em try/catch |
| `SessionMemory` (`memory/session-memory.js`) | REUSE | Contrato real `getDecisions({limit})` → `[{decision, reason, timestamp}]` |
| `GotchasMemory` (`memory/gotchas-memory.js`) | REUSE | `listGotchas()` → objetos com `title/description/severity/createdAt/source.lastSeen`; construído com `{quiet:true}` para não poluir stdout |
| `BrainIndexer` (`brain/indexer.js`) | REUSE | `defaultBrainDir(cwd)` p/ localizar `entities.json` e `index({incremental:true})` p/ re-index pós-gravação |
| `EntityStore` + `slugify` (`brain/entities/entity-store.js`) | REUSE | Detecção de entidades por nome/alias (word-boundary unicode) e slug do storyId para o nome do arquivo |
| `js-yaml` | REUSE (dep existente) | Dump de front-matter garantidamente válido (parseável por js-yaml nos testes) |
| `parseArgs` | ADAPT (helper local duplicado) | Story exige duplicar o padrão do `brain/cli.js` sem importar do cli.js — mantém `digest.js` desacoplado |

### Completion Notes

- `digest.js` exporta `{ generateDigest, digestCommand }` — assinatura `generateDigest({cwd, storyId, summary, agent, dryRun, brainDir})`. O parâmetro extra `brainDir` é opcional (default `BrainIndexer.defaultBrainDir(cwd)`) e existe só para isolar os testes de `~/.aiox`.
- Retorno: `{path, content, sections:{commits, files, decisions, gotchas}, indexed}`.
- Data-base derivada do digest mais recente em `docs/digests/` (parse do `YYYY-MM-DD` do nome). Sem digest prévio → `git log -n 10`; com data-base → `git log --since=<data>`.
- Arquivos alterados = commits do range (`git log --name-only`) unidos aos não commitados (`git status --porcelain`, trata renomeações `old -> new`).
- Entidades detectadas sobre o corpo já renderizado do digest (word-boundary unicode via `\p{L}\p{N}`), listadas em `entities:` no front-matter apenas quando presentes.
- Degradação graciosa total: sem git / SessionMemory / gotchas / entities → seções omitidas, nunca throw. Falha do re-index pós-gravação não falha o digest (`indexed:false`).
- `dryRun` retorna `{content, path}` sem gravar nem indexar.
- Testes: repo git de fixture real (`git init` + 3 commits), fixture sem git (AC4), idempotência `-2`/`-3` (AC6), dryRun não grava, decisões via `.aios/session-memory.json` e complemento `.ai/*.md`, front-matter válido (js-yaml) e detecção de entidades via `entities.json` na fixture. Todas as fixtures em tmp com `brainDir` isolado.

### Validation

- `npx jest .aios-core/core/brain --silent` → **5 suites, 63 testes, todos passam** (inclui os 12 novos de `digest.test.js` + suites de outros módulos brain intactas).
- `npx eslint .aios-core/core/brain/digest.js .aios-core/core/brain/__tests__/digest.test.js` → **0 problemas**.
- Exemplo real gerado em fixture: front-matter `date/story/agent` + seções `Resumo`, `Decisões`, `Arquivos alterados`, `Commits`; `indexed:true`.

### File List

- `.aios-core/core/brain/digest.js` (novo)
- `.aios-core/core/brain/__tests__/digest.test.js` (novo)

### Change Log

| Data | Versão | Descrição | Autor |
|------|--------|-----------|-------|
| 2026-07-13 | 1.0.0 | Implementação inicial do Session Digest (WSB-1.6): `generateDigest` + `digestCommand`, coleta git/decisões/gotchas/entidades, front-matter YAML, idempotência diária, re-index incremental pós-gravação, degradação graciosa total; 12 testes novos | @dev (Dex) |
