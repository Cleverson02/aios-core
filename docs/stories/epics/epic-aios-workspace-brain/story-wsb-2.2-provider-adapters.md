# Story WSB-2.2: Provider Adapters — OpenAI Codex e xAI Grok

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-2.2
**Priority:** Critical
**Status:** In Progress
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 2 — LLM Router

## User Story

**Como** camada de execução,
**Quero** adapters de provider para OpenAI Codex (CLI) e xAI Grok (API) no padrão AIProvider existente,
**Para** despachar subtasks reais nos 4 providers (Claude, Gemini, Codex, Grok) com fallback e rate-limit já existentes.

## Acceptance Criteria

- [ ] AC1: `infrastructure/integrations/ai-providers/codex-provider.js` — `CodexProvider extends AIProvider`: executa via CLI `codex exec` (non-interactive), `checkAvailability()` via `codex --version`; sem CLI instalado → unavailable gracioso, nunca throw na construção
- [ ] AC2: `infrastructure/integrations/ai-providers/grok-provider.js` — `GrokProvider extends AIProvider`: API xAI direta (fetch nativo, endpoint OpenAI-compatible `https://api.x.ai/v1/chat/completions`, model default grok-4-5); requer `XAI_API_KEY` no env — sem chave → unavailable; nenhum request sem chave (testado com fetch mockado)
- [ ] AC3: Registro na factory (`ai-provider-factory.js` + `index.js`): providers 'codex' e 'grok' criáveis, entram no fluxo de fallback existente; DEFAULT_CONFIG estendido com seções `codex` e `grok` (timeouts, model)
- [ ] AC4: `subagent-dispatcher.js`: `providerMapping`/`resolveProvider` reconhecem 'codex' e 'grok' (hints em task.provider/tags/description) — mudança mínima
- [ ] AC5: Retorno no formato AIResponse padrão dos providers existentes (ver claude-provider/gemini-provider)
- [ ] AC6: Zero dependências novas; testes com execução/fetch mockados: availability sem CLI/chave, execute feliz, retry/erro, formato de resposta, factory cria e faz fallback, nenhum request de rede real na suíte

## File List

- `.aios-core/infrastructure/integrations/ai-providers/codex-provider.js` (novo)
- `.aios-core/infrastructure/integrations/ai-providers/grok-provider.js` (novo)
- `.aios-core/infrastructure/integrations/ai-providers/ai-provider-factory.js` (modificado)
- `.aios-core/infrastructure/integrations/ai-providers/index.js` (modificado)
- `.aios-core/core/execution/subagent-dispatcher.js` (modificado — mínimo)
- `tests/` ou `__tests__` no padrão dos testes existentes de providers (novo)
