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

- [x] AC1: `core/workspace/workspace-manager.js` exporta `WorkspaceManager` com `find()` (localiza workspace.yaml subindo diretórios), `load()` (parse + validação por schema), `getRoots({tier})`, `resolve(filePath)` → `{root, tier, area, writable, requiresApproval}`
- [x] AC2: Tiers e permissões: projects (write via story), areas (write com aprovação), resources (read-only), archives (read-only/frio)
- [x] AC3: `init()` faz scaffold de workspace.yaml + estrutura exemplo (01-projects, 02-areas, 03-resources, 04-archives) + `_index.md` templates conforme o guia
- [x] AC4: CLI handler para `aios workspace init|add|status` (wiring no bin/aios.js feito pelo lead)
- [x] AC5: Validação por JSON Schema (ajv) com erros claros; paths relativos e `~` resolvidos
- [x] AC6: Zero dependências novas; degradação graciosa (sem workspace.yaml → single-root no cwd, tier projects)
- [x] AC7: Testes unitários com diretórios temporários

## File List

- `.aios-core/core/workspace/workspace-manager.js` (novo)
- `.aios-core/core/workspace/workspace-schema.json` (novo)
- `.aios-core/core/workspace/templates/workspace-template.yaml` (novo)
- `.aios-core/core/workspace/templates/area-index-template.md` (novo)
- `.aios-core/core/workspace/cli.js` (novo)
- `.aios-core/core/workspace/index.js` (novo — barrel)
- `.aios-core/core/workspace/__tests__/workspace-manager.test.js` (novo)

## Dev Agent Record

**Agent:** Dex (Builder) · **Model:** claude-opus-4-8[1m]
**Status ao final:** Ready for Review

### Implementation Notes

- **Contrato público** implementado exatamente como especificado no spawn prompt.
  `index.js` exporta `{ WorkspaceManager }` (mais `workspaceCommand`, `TIER_PERMISSIONS`,
  `TIER_ORDER`, `TIER_FOLDERS`, `MANIFEST_FILENAME` para os consumidores da Fase 1).
- **`findManifest(startDir)`** (nome do contrato) sobe no máximo 10 níveis parando na
  raiz do filesystem. `find()` foi adicionado como alias fino para satisfazer a grafia
  literal do AC1 sem desviar do contrato.
- **`load()`** nunca lança por ausência de manifest — cai em modo degradado single-root
  (cwd como única raiz, tier `projects`, `aios` derivado da presença de `.aios-core/`).
- **Tiers → permissões** centralizados em `TIER_PERMISSIONS` (fonte única):
  projects `{writable:true, requiresApproval:false}`, areas `{writable:true, requiresApproval:true}`,
  resources/archives `{writable:false}`.
- **Resolução de paths:** relativo (ao dir do manifest), absoluto e `~`/`~/...` (home).
  `name` de cada raiz deriva do basename quando omitido.
- **`resolve()`** escolhe a raiz mais específica (path mais longo) e evita falso-positivo
  por prefixo compartilhado (`produto-x` vs `produto-xyz`) via `path.relative`.
- **Validação** por JSON Schema (ajv, `allErrors`) com `additionalProperties:false`.
  Erros formatados com caminho do campo + motivo (ex.: `roots.areas.0: must have required
  property 'path'`, `unknown property "bogus"`).
- **`init()`** faz scaffold das 4 pastas PARA + `02-areas/exemplo/_index.md` a partir dos
  templates; falha se `workspace.yaml` já existir. O manifest gerado carrega e valida.
- **CLI (`cli.js`)** — `init [--name] [--dir]`, `add <path> --tier <...> [--name] [--aios]`,
  `status`. `add` é idempotente. **Limitação documentada:** js-yaml não preserva comentários;
  `add` reescreve o `workspace.yaml` como YAML limpo (o cabeçalho do template é perdido) —
  trade-off aceito para manter zero dependências novas.
- **Wiring do CLI em `bin/aios.js` NÃO foi tocado** (responsabilidade do lead, conforme escopo).
  `.aios-core/core/brain/` também não foi tocado.

### Decisions (autonomous)

- `[AUTO-DECISION]` Adicionar `static find()` como alias de `findManifest()` → satisfaz AC1
  literalmente sem quebrar o contrato público (reason: AC1 cita `find()`, contrato pede `findManifest`).
- `[AUTO-DECISION]` `roots` no schema com `minProperties:1` e cada tier opcional → permite
  workspaces só-projects ou só-areas sem exigir todos os tiers (reason: flexibilidade PARA).
- `[AUTO-DECISION]` `add` idempotente (retorna 0 se path já existe) → evita duplicatas silenciosas
  (reason: comando seguro para re-execução).

### Validation

- `npx jest .aios-core/core/workspace --silent` → **28/28 passando**.
- `npx eslint .aios-core/core/workspace` → **0 erros, 0 warnings**.
- `npx tsc --noEmit` → **0 erros** originados dos arquivos de `core/workspace`.
- IDS: nenhum módulo de workspace/manifest pré-existente (busca em `core/`); decisão **CREATE** justificada.

### Change Log

| Data | Mudança |
|------|---------|
| 2026-07-12 | Implementação inicial do Workspace Manager (WSB-1.1): manager, schema, templates, CLI, barrel e testes. |
