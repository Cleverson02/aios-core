# Story WSB-1.1: Workspace Manager (workspace.yaml multi-raiz)

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-1.1
**Priority:** Critical (fundação da Fase 1)
**Status:** In Progress
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 1 — Workspace + Brain MVP
**Convenção de pastas:** docs/proposals/aios-workspace-brain/guia-estrutura-workspace.md

## User Story

**Como** owner e agentes do AIOX,
**Quero** um manifest `workspace.yaml` multi-raiz (modelo PARA) com tiers de permissão e um gerenciador programático,
**Para** que o AIOX enxergue a empresa inteira (projects/areas/resources/archives) e saiba o que pode ler e onde pode escrever.

## Acceptance Criteria

- [ ] AC1: `core/workspace/workspace-manager.js` exporta `WorkspaceManager` com `find()` (localiza workspace.yaml subindo diretórios), `load()` (parse + validação por schema), `getRoots({tier})`, `resolve(filePath)` → `{root, tier, area, writable, requiresApproval}`
- [ ] AC2: Tiers e permissões: projects (write via story), areas (write com aprovação), resources (read-only), archives (read-only/frio)
- [ ] AC3: `init()` faz scaffold de workspace.yaml + estrutura exemplo (01-projects, 02-areas, 03-resources, 04-archives) + `_index.md` templates conforme o guia
- [ ] AC4: CLI handler para `aios workspace init|add|status` (wiring no bin/aios.js feito pelo lead)
- [ ] AC5: Validação por JSON Schema (ajv) com erros claros; paths relativos e `~` resolvidos
- [ ] AC6: Zero dependências novas; degradação graciosa (sem workspace.yaml → single-root no cwd, tier projects)
- [ ] AC7: Testes unitários com diretórios temporários

## File List

- `.aios-core/core/workspace/workspace-manager.js` (novo)
- `.aios-core/core/workspace/workspace-schema.json` (novo)
- `.aios-core/core/workspace/templates/workspace-template.yaml` (novo)
- `.aios-core/core/workspace/templates/area-index-template.md` (novo)
- `.aios-core/core/workspace/cli.js` (novo)
- `.aios-core/core/workspace/index.js` (novo — barrel)
- `.aios-core/core/workspace/__tests__/workspace-manager.test.js` (novo)
