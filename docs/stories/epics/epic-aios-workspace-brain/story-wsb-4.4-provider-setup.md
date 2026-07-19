# Story WSB-4.4: Provider Setup — chaves, ativação e disponibilidade determinística

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-4.4
**Priority:** Critical (UX + economia)
**Status:** Ready for Review
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 4 — Gateway + UX + Economia

## User Story

**Como** usuário instalando ou operando o Cortex,
**Quero** um lugar fácil e lógico para cadastrar chaves de API, ativar/desativar LLMs e mudar depois,
**Para** que o sistema SAIBA o que tem disponível e vá direto ao que existe — sem queimar tokens nem tempo procurando provider indisponível.

## Acceptance Criteria

- [x] AC1: `core/providers/credentials-store.js` — `~/.aiox/credentials.json` (chmod 600): set/get/remove de chaves por provider (anthropic, openai, xai, google, telegram); env vars SEMPRE têm precedência (documentado); nunca loga valor de chave
- [x] AC2: `core/providers/availability.js` — `getAvailability({refresh})`: para cada provider da capability-matrix verifica determinìsticamente (chave presente? CLI instalado via version check?) e cacheia em `.aios/providers-status.json` com TTL 1h; `enabled` flag por provider (usuário pode desligar um provider mesmo com chave)
- [x] AC3: Integração com o router: `LlmRouter.route()` filtra modelos cujo provider está disponível+habilitado ANTES de pontuar (curto-circuito determinístico — nunca recomenda o que não existe); fallback documentado quando categoria preferida não tem provider disponível
- [x] AC4: `aios providers` CLI: `list` (tabela: provider, chave ✓/✗, CLI ✓/✗, habilitado, fonte env/store), `set-key <provider>` (prompt oculto via readline; ou `--from-env VAR`), `enable|disable <provider>`, `check` (refresh do cache)
- [x] AC5: `aios setup` — wizard interativo pós-instalação: pergunta quais LLMs usar agora (multi-select), cadastra chaves, roda check, mostra resumo do que ficou ativo; reexecutável a qualquer momento
- [x] AC6: Zero dependências novas (readline nativo); testes: store 600, precedência env, availability com mocks (sem rede/CLI real), router filtra indisponível, enable/disable persiste

## File List

- `.aios-core/core/providers/credentials-store.js` (novo)
- `.aios-core/core/providers/availability.js` (novo)
- `.aios-core/core/providers/cli.js` (novo)
- `.aios-core/core/providers/setup-wizard.js` (novo)
- `.aios-core/core/providers/index.js` (novo — barrel)
- `.aios-core/core/router/router.js` (modificado — filtro de disponibilidade)
- `.aios-core/core/providers/__tests__/providers.test.js` (novo)

**Fora de escopo (lead):** wiring `aios providers|setup` no bin/aios.js.

---

## Dev Agent Record

### Agent Model Used

Dex (Builder) — @dev, Opus 4.8 (1M context).

### IDS Decisions (Search → Decide → Log)

- **credentials-store.js** — SEARCH: nenhum store de credenciais em `core/` ou `squads/` (grep `credentials`, `.aiox`). DECIDE: CREATE. Justificativa: superfície nova; segue o padrão de I/O de `matrix-loader.js` (fs síncrono + degradação silenciosa em arquivo corrompido).
- **availability.js** — SEARCH: `ai-provider-factory.js` já tem `getProvidersStatus`, mas faz probes assíncronos e mira o dispatcher, não a matrix. DECIDE: CREATE (consome `matrix-loader` para derivar providers; REUTILIZA o padrão de version-check `<cli> --version` dos providers existentes claude/gemini/codex, porém com `execFileSync` + timeout 3s e sem rede). Não toquei `infrastructure/integrations/ai-providers/` (só li).
- **router.js** — DECIDE: ADAPT (mudança mínima aditiva ao `route()`): novo `_unavailableProviders()` via `require('../providers')` lazy com try/catch → neutro sem cache; novo `_availablePool()` para o fallback direto. Nenhuma assinatura pública quebrada; `route(task, { ignoreAvailability })` adicionado.
- **cli.js / setup-wizard.js** — REUSE do estilo do `router/cli.js` (chalk, `parseArgs`, exit codes). Muting de echo via `rl._writeToOutput` + `rl.stdoutMuted` (readline nativo, zero dep).

### Completion Notes

- Filtro do router é **neutro por padrão**: sem `.aios/providers-status.json` → `_unavailableProviders()` retorna `null` → zero filtragem. Os 37 testes existentes do router passam intactos.
- **Nunca strand**: se todos os providers relevantes (ou todos da matrix) estiverem indisponíveis, mantém a escolha curada original em vez de deixar o caller sem modelo.
- Fallback de rota direta: quando o modelo curado da categoria está com provider indisponível, re-roteia pela `default_policy` entre os disponíveis (relevantes primeiro; senão qualquer disponível) e anota no `reason` (`"<modelo> indisponível → roteado para X"`).
- Precedência de chave documentada e testada: env var canônica → store. `listProviders()` expõe só `{provider, hasKey, source}` — valor da chave nunca sai.
- `chmod 600` aplicado no write e reforçado com `chmodSync` (rewrite); teste verifica `mode & 0o777 === 0o600` (skip em win32).
- Availability é **determinística e offline**: único spawn é `<cli> --version` (timeout 3s, stdio ignore); xAI é API-only (`cliPresent: null`). Nenhuma request de rede.
- `providersCommand`/`runSetup` são `async` (readline). Wiring no `bin/aios.js` fica com o lead (fora de escopo).

### Validation

- `npx jest .aios-core/core/providers --silent` → **19 passed** (credentials 8, availability 6, router-integration 5).
- `npx jest .aios-core/core/router --silent` → **37 passed** (regressão intacta).
- `eslint` limpo nos 7 arquivos tocados. `tsc --noEmit` sem erros relacionados a `providers/` (arquivos são CommonJS/JSDoc).
- Saída real de `providersCommand(['list'])` neste ambiente (cwd isolado, `~/.aiox` real): `anthropic` chave ✗ / CLI ✓ / habilitado / **disponível ✓** (binário `claude` instalado); `openai` CLI ✗ / indisponível; `xai` CLI n/a / indisponível (sem `XAI_API_KEY`); `google` CLI ✗ / indisponível; `telegram` (só credencial) sem linha de availability.

### Change Log

- 2026-07-19 — Implementada Story WSB-4.4 (credentials-store, availability, cli, setup-wizard, index barrel, filtro de disponibilidade no router + testes). Status → Ready for Review.

### File List

- `.aios-core/core/providers/credentials-store.js` (novo)
- `.aios-core/core/providers/availability.js` (novo)
- `.aios-core/core/providers/cli.js` (novo)
- `.aios-core/core/providers/setup-wizard.js` (novo)
- `.aios-core/core/providers/index.js` (novo — barrel)
- `.aios-core/core/providers/__tests__/providers.test.js` (novo)
- `.aios-core/core/router/router.js` (modificado — filtro de disponibilidade, AC3)
