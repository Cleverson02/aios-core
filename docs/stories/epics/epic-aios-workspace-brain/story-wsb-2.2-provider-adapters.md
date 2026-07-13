# Story WSB-2.2: Provider Adapters — OpenAI Codex e xAI Grok

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-2.2
**Priority:** Critical
**Status:** Ready for Review
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 2 — LLM Router

## User Story

**Como** camada de execução,
**Quero** adapters de provider para OpenAI Codex (CLI) e xAI Grok (API) no padrão AIProvider existente,
**Para** despachar subtasks reais nos 4 providers (Claude, Gemini, Codex, Grok) com fallback e rate-limit já existentes.

## Acceptance Criteria

- [x] AC1: `infrastructure/integrations/ai-providers/codex-provider.js` — `CodexProvider extends AIProvider`: executa via CLI `codex exec` (non-interactive), `checkAvailability()` via `codex --version`; sem CLI instalado → unavailable gracioso, nunca throw na construção
- [x] AC2: `infrastructure/integrations/ai-providers/grok-provider.js` — `GrokProvider extends AIProvider`: API xAI direta (fetch nativo, endpoint OpenAI-compatible `https://api.x.ai/v1/chat/completions`, model default grok-4-5); requer `XAI_API_KEY` no env — sem chave → unavailable; nenhum request sem chave (testado com fetch mockado)
- [x] AC3: Registro na factory (`ai-provider-factory.js` + `index.js`): providers 'codex' e 'grok' criáveis, entram no fluxo de fallback existente; DEFAULT_CONFIG estendido com seções `codex` e `grok` (timeouts, model)
- [x] AC4: `subagent-dispatcher.js`: `providerMapping`/`resolveProvider` reconhecem 'codex' e 'grok' (hints em task.provider/tags/description) — mudança mínima
- [x] AC5: Retorno no formato AIResponse padrão dos providers existentes (ver claude-provider/gemini-provider)
- [x] AC6: Zero dependências novas; testes com execução/fetch mockados: availability sem CLI/chave, execute feliz, retry/erro, formato de resposta, factory cria e faz fallback, nenhum request de rede real na suíte

## File List

- `.aios-core/infrastructure/integrations/ai-providers/codex-provider.js` (novo)
- `.aios-core/infrastructure/integrations/ai-providers/grok-provider.js` (novo)
- `.aios-core/infrastructure/integrations/ai-providers/ai-provider-factory.js` (modificado)
- `.aios-core/infrastructure/integrations/ai-providers/index.js` (modificado)
- `.aios-core/core/execution/subagent-dispatcher.js` (modificado — mínimo)
- `tests/infrastructure/ai-providers/codex-provider.test.js` (novo)
- `tests/infrastructure/ai-providers/grok-provider.test.js` (novo)
- `tests/infrastructure/ai-providers/wsb-2.2-fallback.test.js` (novo)
- `tests/infrastructure/ai-providers/ai-provider-factory.test.js` (modificado — adiciona codex/grok)
- `tests/core/subagent-dispatcher.test.js` (modificado — adiciona resolveProvider codex/grok)

## Dev Agent Record

**Agent Model Used:** claude-opus-4-8[1m] (Dex — Builder)

### Implementation Notes

**IDS decisions**
- `codex-provider.js` → CREATE: nenhum adapter Codex existia. ADAPTOU o padrão de `claude-provider.js` (spawn sem shell, prompt via stdin, timeout via `setTimeout`+`SIGTERM`, `execSync` para `--version`). Subcomando não-interativo `codex exec`; prompt escrito no stdin (espelha Claude) para evitar injeção de shell.
- `grok-provider.js` → CREATE: adapter de API (não-CLI). ADAPTOU a classe base `AIProvider` com `fetch` nativo (Node 22, zero deps). `checkAvailability()` é puramente local (presença de `XAI_API_KEY`, sem rede). Timeout via `AbortController`. Erros HTTP → throw com status+corpo truncado (a `executeWithRetry` da base cuida do retry).
- `ai-provider-factory.js` / `index.js` → ADAPT: imports, `DEFAULT_CONFIG.codex`/`.grok`, merge em `loadConfig`, casos no switch de `getProvider`, inclusão em `getAvailableProviders`/`getProvidersStatus`, e exports. Fallback é genérico (usa `primary`/`fallback` do config) — codex/grok entram sem mudança na lógica.
- `subagent-dispatcher.js` → ADAPT (mínimo): `resolveProvider` reconhece hints `codex`/`grok` em `task.provider`, `task.tags` (`codex`/`@codex`, `grok`/`@grok`) e `task.description` (`@codex`/`@grok`). Nada mais alterado.

**Decisões autônomas**
- `[AUTO-DECISION]` Invocação Codex → `codex exec` com prompt no stdin (sem arg posicional) → mirror exato de `claude --print`, evita injeção e lida com prompts grandes. Nenhuma flag inventada além de `--model`.
- `[AUTO-DECISION]` Grok timeout → `AbortController` mapeado para mensagem `Grok execution timed out after {ms}ms`, consistente com o texto de timeout dos providers CLI.

### Completion Notes
- Zero dependências novas; CommonJS + JSDoc; estilo idêntico aos providers existentes.
- **Nenhum teste faz request de rede real:** `grok-provider.test.js` e `wsb-2.2-fallback.test.js` usam `jest.spyOn(global, 'fetch')` com default `mockRejectedValue('unexpected real fetch')`, garantindo falha ruidosa se algo tentar rede; `codex-provider.test.js` mocka `child_process` (spawn/execSync). Availability do Grok é verificada sem qualquer chamada a `fetch`.
- Testes: `npx jest ai-provider` → 4 suites / 39 tests PASS. `npx jest core/execution` → 1 suite / 16 tests PASS. Suite alvo completa (`tests/infrastructure/ai-providers` + `tests/core/subagent-dispatcher.test.js`) → 5 suites / 76 tests PASS.
- Lint: 0 errors nos arquivos tocados (warnings pré-existentes em `subagent-dispatcher.js` nas linhas 425/559, não relacionados a esta mudança).

### Change Log
| Data | Mudança |
|------|---------|
| 2026-07-13 | Adicionados `CodexProvider` (CLI) e `GrokProvider` (API xAI); registrados na factory + index; `resolveProvider` reconhece codex/grok; testes (unavailable/execute/retry/timeout/fallback/hints, fetch e child_process mockados). |
