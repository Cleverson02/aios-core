# Story WSB-2.1 + WSB-2.3: LLM Router — Capability Matrix, Policies e Roteamento por Tarefa

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story IDs:** WSB-2.1 (matrix+policies) e WSB-2.3 (roteamento+conselheiro), implementadas juntas
**Priority:** Critical
**Status:** In Progress
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 2 — LLM Router

## User Story

**Como** orquestrador e operador,
**Quero** uma capability matrix versionada em YAML (modelos, forças, custo) com policies (quality/cost/speed-first) e um roteador que classifica a tarefa e indica/decide o melhor modelo,
**Para** usar Opus 4.8 onde importa, Codex/Grok onde são melhores e mais baratos — atualizável quando sair modelo novo sem mudar código.

## Acceptance Criteria (WSB-2.1)

- [ ] AC1: `core/router/capability-matrix.yaml` — modelos claude-opus-4-8, gpt-5.5-codex, grok-4-5, gemini-2.x com `provider`, `strengths[]`, `cost_tier (high|medium|low)`, `speed_tier`, `notes`; seções `routing_policies` e `task_routing` (categoria → modelo ou `policy:<nome>`)
- [ ] AC2: `core/router/matrix-loader.js` — carrega+valida por JSON Schema (ajv), erros claros, cache, override por `.aios/capability-matrix.yaml` do projeto (merge raso documentado)
- [ ] AC3: Matrix atualizável sem código: adicionar modelo novo no YAML passa na validação e fica roteável

## Acceptance Criteria (WSB-2.3)

- [ ] AC4: `core/router/router.js` — `class LlmRouter`: `route(task, {policy})` → `{model, provider, category, complexity, reason, alternatives[]}`; usa `TaskComplexityClassifier` (REUSE de orchestration) + heurística de categoria por keywords (architecture-decision, bulk-refactor, test-generation, code-review, research-summarize, story-implementation, default)
- [ ] AC5: Policies: `quality-first` (melhor match de strengths, ignora custo), `cost-first` (menor cost_tier que cubra a categoria), `speed-first`; policy default configurável na matrix
- [ ] AC6: Modo conselheiro — `routeCommand(args)`: `aios route suggest "<task>" [--policy X]` (imprime modelo recomendado + razão + alternativas), `aios route matrix` (tabela), `aios route policies`; wiring no bin/aios.js pelo lead
- [ ] AC7: Zero dependências novas; degradação graciosa (matrix corrompida → erro claro, nunca crash silencioso); testes: validação de schema, cada policy, categorias, override de projeto, suggest end-to-end

## File List

- `.aios-core/core/router/capability-matrix.yaml` (novo)
- `.aios-core/core/router/capability-matrix-schema.json` (novo)
- `.aios-core/core/router/matrix-loader.js` (novo)
- `.aios-core/core/router/router.js` (novo)
- `.aios-core/core/router/cli.js` (novo)
- `.aios-core/core/router/index.js` (novo — barrel)
- `.aios-core/core/router/__tests__/router.test.js` (novo)

**Fora de escopo (lead):** wiring `aios route` no bin/aios.js.
