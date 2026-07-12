# Epic: AIOX Cortex — Workspace Brain (WSB)

> **Produto:** AIOX Cortex (nome confirmado pelo owner em 2026-07-12)

**Epic ID:** WSB
**Status:** Approved (5 decisões da proposta confirmadas pelo owner em 2026-07-12)
**Priority:** High
**Proposta completa:** `docs/proposals/aios-workspace-brain/proposta-aios-workspace-brain.md`
**Constitution:** Art. I (CLI First) e Art. III (Story-Driven) aplicam-se a todas as stories

---

## Objetivo

Evoluir o AIOS de framework per-projeto para **orquestrador de workspace** com second brain, roteador multi-LLM (Claude Opus 4.8/Fable 5, GPT-5.5-Codex, Grok 4.5, Gemini), autonomia de longa duração com gestão de janela de contexto, gateway Telegram e radar de oportunidades.

## Princípios do épico

1. **Consolidar antes de construir** — nenhum módulo novo depende das 3 gerações de orquestradores; tudo assenta sobre o Bob consolidado.
2. **CLI First** — cada capacidade nasce como comando `aios *` funcional; Telegram e dashboard são clientes.
3. **Privacidade por padrão** — indexação e embeddings locais; nada sai da máquina sem opt-in.
4. **Reuso máximo** — cada story lista explicitamente os módulos existentes que reutiliza (IDS: decisão reuse > adapt > create).

---

## Fase 0 — Consolidação (fundação)

### WSB-0.1 — Consolidar orquestração sobre o Bob
Unificar pontos de entrada de WorkflowOrchestrator/MasterOrchestrator no BobOrchestrator; deprecar caminhos duplicados.
**Reusa:** `bob-orchestrator.js`, `workflow-executor.js`, `surface-checker.js`.
**AC:** um único entrypoint de orquestração documentado; testes das 3 gerações passam via caminho novo.

### WSB-0.2 — Memory API unificada (reativar MIS)
Reimplementar `memory-query.js` e `session-memory.js` (removidos na MIS-2, ainda referenciados com fallback null por `execution/subagent-dispatcher.js`, `execution/context-injector.js`, `ideation/ideation-engine.js`).
**AC:** consumidores existentes deixam de cair no fallback null; testes de integração.

### WSB-0.3 — Fachada única de registries
API `registry-facade` sobre service-registry, entity-registry (IDS) e workflow-registry (WIS).
**AC:** busca unificada `aios search` cobre os 3; nenhum consumidor quebra.

## Fase 1 — Workspace + Brain MVP

### WSB-1.1 — Workspace Manager (`workspace.yaml`)
Manifest multi-raiz modelo PARA (projects/areas/resources/archives) com tiers de permissão (read / write-via-story / write-com-aprovação).
**CLI:** `aios workspace init|add|status`.
**AC:** agentes resolvem raiz atual + tier; escrita fora de `projects` bloqueada sem aprovação (gate).

### WSB-1.2 — Brain Indexer (léxico)
Varredura incremental das raízes (chokidar + fast-glob); extração de md/código/decisões/stories/gotchas; índice invertido local.
**CLI:** `aios brain index`, `aios brain ask` (busca léxica).
**AC:** indexação incremental <5s em re-run; busca retorna trechos com fonte.

### WSB-1.3 — Índice semântico local
Embeddings locais + SQLite vetorial (ex.: sqlite-vec); busca híbrida léxica+semântica.
**AC:** `aios brain ask` responde perguntas conceituais; zero chamadas externas na indexação.

### WSB-1.4 — Grafo de entidades de negócio
Evoluir entity-registry para entidades do workspace (clientes, produtos, pessoas, projetos, decisões) com relações.
**CLI:** `aios brain entities`.
**AC:** entidades extraídas automaticamente de docs indexados + curadoria manual.

### WSB-1.5 — SYNAPSE L8 (Workspace Knowledge) — completa SYN-10
Nova camada L8 no pipeline SYNAPSE injetando top-K fatos do brain dentro do token budget do context-tracker.
**Reusa:** `synapse/engine.js`, `context-tracker.js`, Memory API (WSB-0.2).
**AC:** injeção respeita budget e o hard limit de 100ms do pipeline (L8 com cache).

### WSB-1.6 — Session Digest (ciclo de escrita do brain)
Ao fim de sessão/story: digest de decisões, aprendizados e arquivos → gravado no brain.
**AC:** digests consultáveis via `aios brain ask`; digest automático no fechamento de story.

## Fase 2 — LLM Router

### WSB-2.1 — Capability Matrix + policies
`capability-matrix.yaml` versionado (modelos, strengths, cost_tier) + policies quality/cost/speed-first.
**AC:** atualizável sem código; validação por schema (ajv já é dependência).

### WSB-2.2 — Provider adapters (OpenAI Codex + xAI Grok)
Adapters finos por CLI/API estendendo o `subagent-dispatcher.js` (que já faz Claude/Gemini).
**AC:** dispatch de subtask real nos 4 providers; rate-limit-manager cobre todos; failover entre providers.

### WSB-2.3 — Roteamento por tarefa + modo conselheiro
Integrar `task-complexity-classifier.js` → categoria → modelo/policy. Modo `aios route suggest` (indica sem executar).
**AC:** stories executadas com roteamento automático logam modelo/custo por subtask.

### WSB-2.4 — Consenso cross-vendor
Estender modos RACE/CONSENSUS/BEST_OF do `parallel-executor.js` para 4 providers; preset "critical review" (Opus + Codex + Grok votam).
**AC:** decisão de consenso com registro dos votos em decision log.

## Fase 3 — Autonomy Engine

### WSB-3.1 — Context Budget Manager (zonas verde/amarela/vermelha)
Zonas sobre o bracket do `context-tracker`; zona amarela ativa compressão via `epic-context-accumulator`.
**AC:** transições logadas; compressão reduz contexto medido sem perder estado da story.

### WSB-3.2 — Handoff Packet + Fresh Window
Na zona vermelha: gerar pacote (build-state + story + decisões + gotchas + próxima subtask) e spawn de sessão limpa (`terminal-spawner`/worktree).
**AC:** story longa completa através de ≥2 janelas sem intervenção e sem regressão nos gates.

### WSB-3.3 — Heartbeat + escalação por surface-criteria
Checkpoint/autoavaliação a cada N subtasks; travou 2x ou bateu surface-criteria → escala.
**Reusa:** `bob-surface-criteria.yaml`, quality-gates.
**AC:** escalações chegam ao canal configurado com contexto acionável.

## Fase 4 — Gateway Telegram

### WSB-4.1 — Bot + pareamento seguro
Long polling; allowlist de chat-id; `aios gateway start|pair`.
**AC:** comando de não-pareado é rejeitado e logado.

### WSB-4.2 — Comandos e aprovações inline
`/status`, `/run`, `/ask` (brain), `/approve|/reject` com botões (surface decisions), `/report`.
**AC:** aprovação remota destrava execução em andamento; ações de escrita exigem confirmação.

### WSB-4.3 — Notificações via notification-manager
Plugar canal Telegram no `notification-manager.js` (quality-gates): fim de build, gate FAIL, PR criado, escalações.
**AC:** eventos configuráveis por tipo; opt-out por evento.

## Fase 5 — Radar + Empacotamento

### WSB-5.1 — Opportunity Radar
Substituir heurísticas do `ideation-engine` por análise LLM com contexto do brain (+ EXA opcional); saída ranqueada esforço×impacto em formato project-brief.
**CLI:** `aios radar scan|report|brief`.
**AC:** relatório com ≥5 oportunidades rastreáveis a evidências do brain.

### WSB-5.2 — Rotinas agendadas
Radar mensal, digest diário, re-index noturno — via cron/Routines com entrega no Telegram.
**AC:** rotinas sobrevivem a restart; log de execuções.

### WSB-5.3 — Empacotamento e distribuição (core vs pro)
Definir fronteira open-source/pro; empacotar módulos novos no install-manifest; upgrade brownfield limpo.
**Reusa:** installer, manifest hasheado, `aios-pro-cli`.
**AC:** `npx aios-core install` em projeto existente ativa workspace-brain sem quebrar instalação atual.

---

## Métricas de sucesso do épico

- **Custo:** ≥40% de redução de tokens/custo por story (roteamento + handoff) vs baseline atual.
- **Autonomia:** stories de >4h completadas sem intervenção, atravessando múltiplas janelas.
- **Brain:** ≥90% das perguntas "onde está / o que decidimos sobre X" respondidas com fonte correta.
- **Qualidade:** zero regressão nos quality gates existentes.

## Riscos

Ver seção 6 da proposta. Principais: dívida das 3 gerações (mitigada pela Fase 0), privacidade (local-first), scope creep (fases independentes e utilizáveis).
