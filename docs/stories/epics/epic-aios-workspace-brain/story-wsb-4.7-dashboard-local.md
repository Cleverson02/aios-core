# Story WSB-4.7: Dashboard Local (custos, agentes, telemetria)

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-4.7
**Priority:** High
**Status:** Draft (após WSB-4.5 — lê o ledger)
**Type:** Feature
**Lead:** @dev (Dex) + @ux-design-expert (Uma)
**Repository:** aios-core
**Wave:** Fase 4 — Gateway + UX + Economia

## User Story

**Como** usuário/gestor,
**Quero** um painel local que mostra custos por LLM, consumo de tokens (incl. cache), qual agente está ativo em cada projeto/tarefa e a telemetria completa do que acontece por trás,
**Para** ter controle e visibilidade total sem sair do fluxo.

## Princípios (Constitution Art. I)

- Dashboard **OBSERVA, nunca controla** — leitura de `.aios/telemetry/`, build states, zone-logs, escalações
- 100% local: servidor http nativo do Node em localhost (porta configurável), HTML self-contained (CSS/JS inline) — **zero dependências novas**
- Zero LLM: todas as visões são agregações determinísticas do ledger (WSB-4.5)

## Acceptance Criteria

- [ ] AC1: `core/dashboard/server.js` — http nativo em `localhost:4801` (configurável): endpoints JSON `/api/costs` (agregações do report.js por provider/model/agent/story/day), `/api/agents` (ativos + atividade recente), `/api/builds` (build states + zonas + handoffs + escalações), `/api/health`; refresh por polling do front (5s)
- [ ] AC2: `core/dashboard/public/index.html` — página única self-contained com 4 visões: **Custos** (total, por LLM com % cacheado, custo/dia), **Agentes** (quem está ativo, em qual projeto/tarefa, timeline recente), **Execuções** (builds, zonas de contexto, escalações pendentes), **Telemetria** (tabela filtrável das últimas chamadas com tokens/custo/fonte estimada ou real)
- [ ] AC3: Bind APENAS em 127.0.0.1 (nunca 0.0.0.0); sem auth por ser local-only (documentado); CORS desabilitado
- [ ] AC4: `aios dashboard` CLI: `start [--port]` (abre navegador com instrução), `stop`, `status`; roda em foreground ou `--daemon` com pid file
- [ ] AC5: Dados ausentes (sem telemetria ainda) → estados vazios amigáveis com instrução do que rodar; nunca erro
- [ ] AC6: Testes: endpoints com fixtures de ledger/activity/build-state em tmp (fetch ao server em porta efêmera), bind local-only, estados vazios; sem browser na suíte

## File List

- `.aios-core/core/dashboard/server.js` (novo)
- `.aios-core/core/dashboard/public/index.html` (novo)
- `.aios-core/core/dashboard/cli.js` (novo)
- `.aios-core/core/dashboard/index.js` (novo — barrel)
- `.aios-core/core/dashboard/__tests__/dashboard.test.js` (novo)

**Fora de escopo (lead):** wiring `aios dashboard` no bin/aios.js.
