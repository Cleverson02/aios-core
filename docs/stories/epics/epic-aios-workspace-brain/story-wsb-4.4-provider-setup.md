# Story WSB-4.4: Provider Setup — chaves, ativação e disponibilidade determinística

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-4.4
**Priority:** Critical (UX + economia)
**Status:** In Progress
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 4 — Gateway + UX + Economia

## User Story

**Como** usuário instalando ou operando o Cortex,
**Quero** um lugar fácil e lógico para cadastrar chaves de API, ativar/desativar LLMs e mudar depois,
**Para** que o sistema SAIBA o que tem disponível e vá direto ao que existe — sem queimar tokens nem tempo procurando provider indisponível.

## Acceptance Criteria

- [ ] AC1: `core/providers/credentials-store.js` — `~/.aiox/credentials.json` (chmod 600): set/get/remove de chaves por provider (anthropic, openai, xai, google, telegram); env vars SEMPRE têm precedência (documentado); nunca loga valor de chave
- [ ] AC2: `core/providers/availability.js` — `getAvailability({refresh})`: para cada provider da capability-matrix verifica determinìsticamente (chave presente? CLI instalado via version check?) e cacheia em `.aios/providers-status.json` com TTL 1h; `enabled` flag por provider (usuário pode desligar um provider mesmo com chave)
- [ ] AC3: Integração com o router: `LlmRouter.route()` filtra modelos cujo provider está disponível+habilitado ANTES de pontuar (curto-circuito determinístico — nunca recomenda o que não existe); fallback documentado quando categoria preferida não tem provider disponível
- [ ] AC4: `aios providers` CLI: `list` (tabela: provider, chave ✓/✗, CLI ✓/✗, habilitado, fonte env/store), `set-key <provider>` (prompt oculto via readline; ou `--from-env VAR`), `enable|disable <provider>`, `check` (refresh do cache)
- [ ] AC5: `aios setup` — wizard interativo pós-instalação: pergunta quais LLMs usar agora (multi-select), cadastra chaves, roda check, mostra resumo do que ficou ativo; reexecutável a qualquer momento
- [ ] AC6: Zero dependências novas (readline nativo); testes: store 600, precedência env, availability com mocks (sem rede/CLI real), router filtra indisponível, enable/disable persiste

## File List

- `.aios-core/core/providers/credentials-store.js` (novo)
- `.aios-core/core/providers/availability.js` (novo)
- `.aios-core/core/providers/cli.js` (novo)
- `.aios-core/core/providers/setup-wizard.js` (novo)
- `.aios-core/core/providers/index.js` (novo — barrel)
- `.aios-core/core/router/router.js` (modificado — filtro de disponibilidade)
- `.aios-core/core/providers/__tests__/providers.test.js` (novo)

**Fora de escopo (lead):** wiring `aios providers|setup` no bin/aios.js.
