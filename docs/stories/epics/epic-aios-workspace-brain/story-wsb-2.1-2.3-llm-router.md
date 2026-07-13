# Story WSB-2.1 + WSB-2.3: LLM Router — Capability Matrix, Policies e Roteamento por Tarefa

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story IDs:** WSB-2.1 (matrix+policies) e WSB-2.3 (roteamento+conselheiro), implementadas juntas
**Priority:** Critical
**Status:** Ready for Review
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 2 — LLM Router

## User Story

**Como** orquestrador e operador,
**Quero** uma capability matrix versionada em YAML (modelos, forças, custo) com policies (quality/cost/speed-first) e um roteador que classifica a tarefa e indica/decide o melhor modelo,
**Para** usar Opus 4.8 onde importa, Codex/Grok onde são melhores e mais baratos — atualizável quando sair modelo novo sem mudar código.

## Acceptance Criteria (WSB-2.1)

- [x] AC1: `core/router/capability-matrix.yaml` — modelos claude-opus-4-8, gpt-5.5-codex, grok-4-5, gemini-2.x com `provider`, `strengths[]`, `cost_tier (high|medium|low)`, `speed_tier`, `notes`; seções `routing_policies` e `task_routing` (categoria → modelo ou `policy:<nome>`)
- [x] AC2: `core/router/matrix-loader.js` — carrega+valida por JSON Schema (ajv), erros claros, cache, override por `.aios/capability-matrix.yaml` do projeto (merge raso documentado)
- [x] AC3: Matrix atualizável sem código: adicionar modelo novo no YAML passa na validação e fica roteável

## Acceptance Criteria (WSB-2.3)

- [x] AC4: `core/router/router.js` — `class LlmRouter`: `route(task, {policy})` → `{model, provider, category, complexity, reason, alternatives[]}`; usa `TaskComplexityClassifier` (REUSE de orchestration) + heurística de categoria por keywords (architecture-decision, bulk-refactor, test-generation, code-review, research-summarize, story-implementation, default)
- [x] AC5: Policies: `quality-first` (melhor match de strengths, ignora custo), `cost-first` (menor cost_tier que cubra a categoria), `speed-first`; policy default configurável na matrix
- [x] AC6: Modo conselheiro — `routeCommand(args)`: `aios route suggest "<task>" [--policy X]` (imprime modelo recomendado + razão + alternativas), `aios route matrix` (tabela), `aios route policies`; wiring no bin/aios.js pelo lead
- [x] AC7: Zero dependências novas; degradação graciosa (matrix corrompida → erro claro, nunca crash silencioso); testes: validação de schema, cada policy, categorias, override de projeto, suggest end-to-end

## File List

- `.aios-core/core/router/capability-matrix.yaml` (novo)
- `.aios-core/core/router/capability-matrix-schema.json` (novo)
- `.aios-core/core/router/matrix-loader.js` (novo)
- `.aios-core/core/router/router.js` (novo)
- `.aios-core/core/router/cli.js` (novo)
- `.aios-core/core/router/index.js` (novo — barrel)
- `.aios-core/core/router/__tests__/router.test.js` (novo)

**Fora de escopo (lead):** wiring `aios route` no bin/aios.js.

---

## Dev Agent Record

### Agent Model Used

Opus 4.8 (`@dev` — Dex, Builder)

### IDS Decisions (search-first)

- **REUSE** `TaskComplexityClassifier` de `.aios-core/core/orchestration/task-complexity-classifier.js` — API real `classify({description})` → `{level: simple|medium|complex}`. Usado para o upgrade de tier em `cost-first`.
- **REUSE** padrão de validação ajv + erro path-annotated de `.aios-core/core/workspace/workspace-manager.js`.
- **REUSE** idioma `parseArgs` (flags/positionals) e formatação chalk de `.aios-core/core/brain/cli.js` e `workspace/cli.js` — utilitário inline pequeno, sem módulo compartilhado no repo.
- **REUSE** deps existentes: `js-yaml`, `ajv`, `chalk` (zero deps novas — AC7).
- **CREATE** `core/router/*` — não havia módulo de roteamento (Grep confirmou diretório novo).

### Design Notes

- **Categorização (PT+EN)**: heurística por substring com prioridade por ordem em `CATEGORY_KEYWORDS` (architecture → security → bulk-refactor → test → code-review → research → agentic → story → default).
- **Resolução de rota**: `categorize` → `task_routing[categoria]` (fallback `default`) → modelo direto OU `policy:<nome>`. Um `{policy}` explícito no `route()` sobrepõe a policy/modelo da matrix.
- **Policies** operam só sobre modelos "relevantes" (strengths ∩ `CATEGORY_STRENGTHS[categoria]`; categoria `default` = todos). `quality-first` = mais matches (desempate: mais strengths totais, depois nome); `cost-first` = menor cost_tier (desempate: velocidade, depois nome); `speed-first` = mais rápido (desempate: custo, depois nome).
- **Upgrade por complexidade**: `cost-first` + `complexity === 'complex'` sobe um cost tier (do mais barato para o próximo tier acima) priorizando qualidade — sinalizado no `reason` e coberto por teste.
- **Merge raso do override de projeto** (`.aios/capability-matrix.yaml`): `models`/`routing_policies`/`task_routing` mesclados por chave (projeto substitui a chave; sem deep-merge de campos); `default_policy`/`version` do projeto vencem quando presentes. Documentado no cabeçalho de `matrix-loader.js`.
- **Cache** por caminho do override com invalidação por `mtimeMs` de ambos os arquivos-fonte.
- **Degradação graciosa**: YAML corrompido / schema inválido / rota semântica quebrada → erro claro com caminho do campo, nunca crash silencioso. O CLI captura e imprime `✖ <msg>` com exit 1.

### Completion Notes

- 37 testes passando (`npx jest .aios-core/core/router --silent`): validação de schema (strengths vazio, enum cost_tier), validação semântica (rota → modelo inexistente), override de projeto + invalidação de cache, categorias PT e EN (15 casos), cada policy (quality/cost/speed), upgrade por complexidade, `routeCommand` e2e (suggest/matrix/policies + exit codes), matrix real do repo carrega e valida.
- ESLint: 0 erros, 0 warnings em `.aios-core/core/router/`.
- Typecheck: N/A — módulo 100% CommonJS/JS sem superfície TS (`tsc --noEmit` cobre os pacotes TS, não faz `checkJs` nestes arquivos).
- Escopo respeitado: apenas `.aios-core/core/router/*` criado + esta story atualizada. Nada tocado em `infrastructure/integrations/ai-providers/`, `core/execution/` ou `bin/aios.js` (wiring do lead).

### Change Log

| Data | Versão | Descrição | Autor |
|------|--------|-----------|-------|
| 2026-07-13 | 1.0.0 | Implementação WSB-2.1+2.3: capability-matrix.yaml + schema, matrix-loader (ajv+semântica+cache+override), LlmRouter (categorize/route/policies/upgrade), cli.js (suggest/matrix/policies), barrel, 37 testes. | @dev (Dex) |

### File List

- `.aios-core/core/router/capability-matrix.yaml` (novo)
- `.aios-core/core/router/capability-matrix-schema.json` (novo)
- `.aios-core/core/router/matrix-loader.js` (novo)
- `.aios-core/core/router/router.js` (novo)
- `.aios-core/core/router/cli.js` (novo)
- `.aios-core/core/router/index.js` (novo — barrel)
- `.aios-core/core/router/__tests__/router.test.js` (novo)
- `docs/stories/epics/epic-aios-workspace-brain/story-wsb-2.1-2.3-llm-router.md` (atualizado)
