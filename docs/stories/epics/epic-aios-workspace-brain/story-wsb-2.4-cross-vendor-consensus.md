# Story WSB-2.4: Consenso Cross-Vendor

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-2.4
**Priority:** High
**Status:** Draft (inicia após WSB-2.2)
**Type:** Feature
**Lead:** @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 2 — LLM Router
**Depends On:** WSB-2.2 (providers codex/grok na factory)

## User Story

**Como** operador tomando decisões críticas,
**Quero** os modos RACE/CONSENSUS/BEST_OF do parallel-executor estendidos para lista arbitrária de providers (resolvida via factory) com preset "critical-review" (Opus + Codex + Grok votam),
**Para** que decisões de arquitetura e reviews críticos tenham rede de segurança multi-fornecedor com votos registrados em decision log.

## Acceptance Criteria

- [ ] AC1: `parallel-executor.js` aceita N providers (lista por nome via factory) mantendo compat com a API atual de 2 providers
- [ ] AC2: CONSENSUS com N: maioria simples decide; empate → BEST_OF como desempate; votos individuais preservados no resultado
- [ ] AC3: Preset `critical-review` = [claude, codex, grok] (configurável); providers indisponíveis são pulados com warning (mínimo 2 para consenso)
- [ ] AC4: Votos registrados em decision log (`.ai/`) no formato ADR existente
- [ ] AC5: Testes com providers mockados: 3-way consenso, empate, provider indisponível, compat 2-provider preservada

## File List (previsto)

- `.aios-core/core/execution/parallel-executor.js` (modificado)
- Testes no padrão existente
