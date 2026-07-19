# Story WSB-5.3: Empacotamento e Distribuição do Cortex

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-5.3
**Priority:** Critical (é o que permite a equipe/testers instalarem)
**Status:** In Progress
**Type:** Feature
**Lead:** @devops (Gage) + @dev (Dex)
**Repository:** aios-core
**Wave:** Fase 5 — Radar + Empacotamento

## User Story

**Como** membro da equipe ou tester,
**Quero** instalar o AIOX Cortex com um comando e ser guiado do zero ao primeiro resultado,
**Para** usar tudo que foi construído sem depender do owner.

## Contexto verificado

O installer copia `core/` e `infrastructure/` INTEIROS (FOLDERS_TO_COPY) — os módulos novos (workspace, brain, router, autonomy, gateway, providers, telemetry, dashboard, guide, radar, routines) já viajam automaticamente. O gap é: manifest desatualizado, README sem o Cortex, e validação de que a instalação nova funciona.

## Acceptance Criteria

- [ ] AC1: `install-manifest.yaml` regenerado (`npm run generate:manifest`) incluindo todos os módulos novos e validado (`npm run validate:manifest` ou script equivalente — descobrir o real)
- [ ] AC2: README.md ganha seção "AIOX Cortex" (EN, curta) apresentando workspace/brain/router/autonomy/gateway/dashboard com o quickstart de 5 comandos (setup → workspace init → brain index → next → dashboard) e link para docs/guides/primeiros-passos-cortex.md
- [ ] AC3: Smoke test de instalação REAL: rodar o installer em diretório tmp (modo programático do aios-core-installer) e verificar: módulos do Cortex presentes no destino, `aios --help` mostra as seções novas, `workspace init` + `brain index` funcionam na instalação
- [ ] AC4: `aios doctor` reconhece o Cortex: check simples de presença dos módulos novos + estado (workspace? índice? providers configurados?) — aditivo ao doctor existente (descobrir o mecanismo real de checks em health-check/)
- [ ] AC5: Testes automatizados do smoke (AC3) e do check novo (AC4); zero dependências novas

## File List (previsto)

- `.aios-core/install-manifest.yaml` (regenerado)
- `README.md` (modificado — seção Cortex)
- `.aios-core/core/health-check/checks/project/cortex-modules.js` (novo — se o padrão de checks permitir)
- Teste de smoke da instalação (local a descobrir pelo padrão do repo)
