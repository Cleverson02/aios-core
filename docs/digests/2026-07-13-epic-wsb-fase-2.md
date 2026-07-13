---
date: '2026-07-13'
story: Epic-WSB-Fase-2
agent: claude
entities:
  - aios-core
---

## Resumo

Fase 2 do AIOX Cortex: LLM Router (capability matrix + policies), providers Codex/Grok, consenso cross-vendor e comando aios route

## Decisões

- Decision Log: Story test
- Decision Log: Story test-story
- Decision Log: Story story-6.1.2.6
- Decision Log Index

## Arquivos alterados

- .aios-core/core/brain/__tests__/hot-index.test.js
- .aios-core/core/brain/cli.js
- .aios-core/core/brain/hot-index.js
- .aios-core/core/brain/index.js
- .aios-core/core/execution/parallel-executor.js
- .aios-core/core/execution/subagent-dispatcher.js
- .aios-core/core/router/__tests__/router.test.js
- .aios-core/core/router/capability-matrix-schema.json
- .aios-core/core/router/capability-matrix.yaml
- .aios-core/core/router/cli.js
- .aios-core/core/router/index.js
- .aios-core/core/router/matrix-loader.js
- .aios-core/core/router/router.js
- .aios-core/core/synapse/context/context-tracker.js
- .aios-core/core/synapse/engine.js
- .aios-core/core/synapse/layers/l8-workspace-knowledge.js
- .aios-core/core/synapse/output/formatter.js
- .aios-core/data/entity-registry.yaml
- .aios-core/infrastructure/integrations/ai-providers/ai-provider-factory.js
- .aios-core/infrastructure/integrations/ai-providers/codex-provider.js
- .aios-core/infrastructure/integrations/ai-providers/grok-provider.js
- .aios-core/infrastructure/integrations/ai-providers/index.js
- bin/aios.js
- docs/stories/epics/epic-aios-workspace-brain/story-wsb-1.5-synapse-l8.md
- docs/stories/epics/epic-aios-workspace-brain/story-wsb-2.1-2.3-llm-router.md
- docs/stories/epics/epic-aios-workspace-brain/story-wsb-2.2-provider-adapters.md
- docs/stories/epics/epic-aios-workspace-brain/story-wsb-2.4-cross-vendor-consensus.md
- tests/core/execution/parallel-executor.test.js
- tests/core/subagent-dispatcher.test.js
- tests/infrastructure/ai-providers/ai-provider-factory.test.js
- tests/infrastructure/ai-providers/codex-provider.test.js
- tests/infrastructure/ai-providers/grok-provider.test.js
- tests/infrastructure/ai-providers/wsb-2.2-fallback.test.js
- tests/synapse/context-tracker.test.js
- tests/synapse/engine.test.js
- tests/synapse/formatter.test.js
- tests/synapse/l8-workspace-knowledge.test.js

## Commits

- `2840dba` feat: consenso cross-vendor N-way no parallel-executor [WSB-2.4] (Claude, 2026-07-13)
- `24ed583` chore: sync entity-registry (IDS hook) [Epic WSB] (Claude, 2026-07-13)
- `ee85074` feat: comando aios route no CLI + registros das stories 2.2/2.4 [WSB-2.3] (Claude, 2026-07-13)
- `6803e49` feat: providers OpenAI Codex (CLI) e xAI Grok (API) [WSB-2.2] (Claude, 2026-07-13)
- `2a3150b` feat: LLM router — capability matrix, policies e modo conselheiro [WSB-2.1, WSB-2.3] (Claude, 2026-07-13)
- `f7cf92a` chore: sync entity-registry (IDS hook) [Epic WSB] (Claude, 2026-07-13)
- `774cc36` docs: stories da Fase 2 — LLM Router (WSB-2.1/2.2/2.3/2.4) [Epic WSB] (Claude, 2026-07-13)
- `18c96ec` chore: sync entity-registry (IDS hook) [Epic WSB] (Claude, 2026-07-13)
- `752a6b2` feat: SYNAPSE L8 workspace knowledge — o cérebro alimenta cada prompt [WSB-1.5] (Claude, 2026-07-13)
- `0ff6f15` feat: session digest — o cérebro aprende com cada sessão [WSB-1.6] (Claude, 2026-07-13)
