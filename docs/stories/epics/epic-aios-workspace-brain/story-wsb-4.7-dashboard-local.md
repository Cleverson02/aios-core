# Story WSB-4.7: Dashboard Local (custos, agentes, telemetria)

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-4.7
**Priority:** High
**Status:** Ready for Review (após WSB-4.5 — lê o ledger)
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

- [x] AC1: `core/dashboard/server.js` — http nativo em `localhost:4801` (configurável): endpoints JSON `/api/costs` (agregações do report.js por provider/model/agent/story/day), `/api/agents` (ativos + atividade recente), `/api/builds` (build states + zonas + handoffs + escalações), `/api/health`; refresh por polling do front (5s)
- [x] AC2: `core/dashboard/public/index.html` — página única self-contained com 4 visões: **Custos** (total, por LLM com % cacheado, custo/dia), **Agentes** (quem está ativo, em qual projeto/tarefa, timeline recente), **Execuções** (builds, zonas de contexto, escalações pendentes), **Telemetria** (tabela filtrável das últimas chamadas com tokens/custo/fonte estimada ou real)
- [x] AC3: Bind APENAS em 127.0.0.1 (nunca 0.0.0.0); sem auth por ser local-only (documentado); CORS desabilitado
- [x] AC4: `aios dashboard` CLI: `start [--port]` (abre navegador com instrução), `stop`, `status`; roda em foreground ou `--daemon` com pid file
- [x] AC5: Dados ausentes (sem telemetria ainda) → estados vazios amigáveis com instrução do que rodar; nunca erro
- [x] AC6: Testes: endpoints com fixtures de ledger/activity/build-state em tmp (fetch ao server em porta efêmera), bind local-only, estados vazios; sem browser na suíte

## File List

- `.aios-core/core/dashboard/server.js` (novo)
- `.aios-core/core/dashboard/public/index.html` (novo)
- `.aios-core/core/dashboard/cli.js` (novo)
- `.aios-core/core/dashboard/index.js` (novo — barrel)
- `.aios-core/core/dashboard/__tests__/dashboard.test.js` (novo)

**Fora de escopo (lead):** wiring `aios dashboard` no bin/aios.js.

## Dev Agent Record

**Agent:** @dev (Dex) · **Status:** Ready for Review

### IDS Decisions (Reuse/Adapt/Create)

- **REUSE** `telemetry/report.aggregate` + `getActiveAgents` (WSB-4.5) — fonte determinística de custos e agentes ativos; consumido sem modificação.
- **REUSE** `telemetry/ledger` constantes (`TELEMETRY_RELDIR`/`USAGE_FILE`/`ACTIVITY_FILE`) para localizar os ledgers.
- **REUSE** `execution/build-state-manager.BuildStateManager.getAllBuilds(cwd)` — varredura de `plan/` e `docs/stories/*/build-state.json` já pronta; evita reimplementar a busca.
- **REUSE** convenção de escalação pendente do `gateway/escalation-watcher`: `<id>.md` sem `<id>.decision.json` irmão = pendente.
- **CREATE** `server.js`, `cli.js`, `index.js`, `public/index.html`, testes — não havia dashboard local; http nativo, zero deps.

### Autonomous Decisions

- `[AUTO-DECISION]` Endpoint extra `GET /api/telemetry?limit=100` → CRIADO (reason: a visão **Telemetria** do AC2 exige a lista bruta das últimas chamadas com tokens/custo/fonte, e nenhuma das 4 rotas base expõe linhas cruas do `usage.jsonl`; é leitura pura do ledger, dentro do princípio "observa, nunca controla").
- `[AUTO-DECISION]` Card "Hoje" dos Custos → front faz segundo fetch `?by=day` e filtra a chave do dia atual (reason: manter o endpoint `/api/costs` com uma única dimensão de agrupamento por request, sem inflar o payload).
- `[AUTO-DECISION]` `.port` exposto como getter vivo (reason: refletir a porta real após bind efêmero `port:0`).

### Implementation Notes

- Bind **explícito** `server.listen(port, '127.0.0.1')`; nenhum header CORS é emitido; sem auth (local-only, documentado no header do `server.js`) — AC3.
- AC5: cada leitura de disco é defensiva (arquivo ausente/corrupto → `[]`); erro inesperado em `/api/*` → `200 { error }` amigável; front renderiza estados vazios com o comando a rodar (`aios run long <story-id>`).
- SPA dark-theme self-contained (CSS+JS inline, sem CDN), header "AIOX Cortex — Observability", 4 abas trocadas por JS puro, polling 5s, barras proporcionais em CSS, zonas coloridas verde/amarelo/vermelho, escalações pendentes destacadas, filtro client-side na Telemetria.
- CLI daemon: `spawn` detached de `cli.js __serve --port N`, pid em `.aios/dashboard.pid`; `stop`/`status` via `process.kill(pid, 0)`.

### Validation

- `npx jest .aios-core/core/dashboard --silent` → **14/14 verde**.
- `npx eslint` nos 4 `.js` → limpo (o `index.html` não passa por eslint, por design).
- `npx tsc --noEmit` → sem erros nos arquivos do dashboard.
- Amostra real `/api/costs?by=provider` (fixtures): `totals.costUsd = 0.035`, `calls = 3`, grupos `grok`/`claude`; `/api/builds`: 1 build `in_progress` (33%), 2 transições de zona, 1 handoff, 1 escalação pendente (a resolvida com `.decision.json` é filtrada).

### Change Log

| Data | Mudança |
|------|---------|
| 2026-07-19 | Implementação inicial WSB-4.7: server/cli/index/public + suíte de testes (14). AC1–AC6 atendidos. |
