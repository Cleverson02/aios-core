# Story WSB-5.3: Empacotamento e Distribuição do Cortex

**Epic:** AIOX Cortex — Workspace Brain (WSB)
**Story ID:** WSB-5.3
**Priority:** Critical (é o que permite a equipe/testers instalarem)
**Status:** Ready for Review
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

- [x] AC1: `install-manifest.yaml` regenerado (`npm run generate:manifest`) incluindo todos os módulos novos e validado (`npm run validate:manifest`)
- [x] AC2: README.md ganha seção "AIOX Cortex" (EN, curta) apresentando workspace/brain/router/autonomy/gateway/dashboard com o quickstart de 5 comandos (setup → workspace init → brain index → next → dashboard) e link para docs/guides/primeiros-passos-cortex.md
- [x] AC3: Smoke test de instalação REAL: rodar o installer em diretório tmp (modo programático do aios-core-installer) e verificar: módulos do Cortex presentes no destino, barrels do Cortex carregam do destino, `workspace init` + `brain index` funcionam na instalação
- [x] AC4: `aios doctor`/health-check reconhece o Cortex: check `project.cortex-modules` de presença dos módulos novos + estado (workspace? índice? providers configurados?) — aditivo (severity LOW, nunca derruba o doctor), registrado no CheckRegistry real
- [x] AC5: Testes automatizados do smoke (AC3) e do check novo (AC4); zero dependências novas

## File List (previsto)

- `.aios-core/install-manifest.yaml` (regenerado)
- `README.md` (modificado — seção Cortex)
- `.aios-core/core/health-check/checks/project/cortex-modules.js` (novo — se o padrão de checks permitir)
- Teste de smoke da instalação (local a descobrir pelo padrão do repo)

## Dev Agent Record

### Agent Model Used

Dex (Builder / @dev) — Opus 4.8

### File List (real)

- `.aios-core/install-manifest.yaml` — regenerado (969 → 1069 arquivos)
- `README.md` — nova seção "AIOX Cortex — Workspace Brain" (EN)
- `.aios-core/core/health-check/checks/project/cortex-modules.js` — NOVO check `project.cortex-modules`
- `.aios-core/core/health-check/checks/project/index.js` — registra `CortexModulesCheck` (mudança mínima, mecanismo real de auto-registro)
- `tests/installer/cortex-smoke.test.js` — NOVO smoke test (jest, 6 testes)
- `tests/health-check/health-check.test.js` — atualizado (contagem de checks 34→35 / project 8→9, consequência direta do registro do novo check)
- `docs/stories/epics/epic-aios-workspace-brain/story-wsb-5.3-packaging.md` — esta story

### Completion Notes

- **AC1 — Manifest**: `npm run generate:manifest` + `npm run validate:manifest` → VALID.
  - Antes: `file_count: 969`, 0 arquivos Cortex (manifest estava obsoleto).
  - Depois (regen final desta story): `file_count: 1069`.
  - Arquivos Cortex capturados: workspace 7, brain 23, router 9, autonomy 10, gateway 7, providers 6, telemetry 5, dashboard 5, guide 5 (= 77) + radar 5 e routines 5 (ver nota).
  - **NOTA p/ o lead (IMPORTANTE)**: `core/radar/` e `core/routines/` estão sendo escritos por agentes em paralelo. Durante esta story o manifest ficou OUTDATED porque esses agentes criaram novos arquivos após minha regeneração; regenerei mais uma vez para deixar o manifest válido AGORA, capturando radar/routines em estado **parcial** (5 arquivos cada no momento). Como esses módulos ainda podem receber arquivos, **o lead DEVE rodar `npm run generate:manifest` uma última vez no fechamento da fase** para congelar o estado final. NÃO toquei em `core/radar/` nem `core/routines/`.
- **AC2 — README**: seção inserida entre "ADE" e "Criando Seu Próprio Squad", EN, ~1 parágrafo + quickstart de 5 comandos + links para `docs/guides/primeiros-passos-cortex.md` e `docs/proposals/aios-workspace-brain/` (ambos existem). Tom CLI-first consistente.
- **AC3/AC5 — Smoke**: install REAL rápido (~1.3s / 1079 arquivos), então roda em jest inline (timeout 30s, sem `describe.skip`). Descoberta técnica: os módulos instalados dependem de pacotes (fs-extra/js-yaml/fast-glob) resolvidos subindo a árvore; para requerer os barrels a partir do destino em `/tmp`, o teste cria um symlink `node_modules → node_modules do repo`. Assertivas: 9 dirs Cortex presentes, barrels `workspace`/`brain` carregam do destino, `WorkspaceManager.init` cria `workspace.yaml` + pastas PARA, `BrainIndexer.index({roots explícitos, brainDir em tmp})` gera `index.json`.
- **AC4 — Health check**: `project.cortex-modules` segue o padrão exato de `aios-directory.js` (estende `BaseCheck`, auto-registrado via `checks/project/index.js`). Verifica presença dos 9 dirs em `core/{workspace,brain,router,autonomy,gateway,providers,telemetry,dashboard,guide}` (resolvidos relativos ao próprio módulo → inspeciona o framework instalado real). Informa estado (workspace.yaml?, índice do brain em `~/.aiox/brain/<hash>/index.json`?, `>=1` provider disponível via cache `.aios/providers-status.json`). **Severity LOW** → nunca derruba o doctor (roda em modo `full`; `quick` filtra CRITICAL/HIGH).
  - Execução via engine real: `HealthCheck({mode:'full', domains:['project']})` → check presente, `status: pass`, `severity: LOW`, overall score **93 (healthy)**.
- **Escopo**: `bin/aios.js` NÃO tocado — o `aios doctor` legado é um diagnóstico separado (não usa o health-check engine); o mecanismo real de checks é o `CheckRegistry`, onde o check foi registrado.
- **Regressão**: `npm test` (jest, runner canônico) — suíte health-check + installer: **313 testes passando** (115 health-check/smoke + 198 installer). Lint limpo nos arquivos tocados. Zero dependências novas.
- **Pré-existente (não é regressão)**: `npm run test:health-check` (mocha) já quebrava antes desta story — `tests/health-check/engine.test.js` usa o global `jest` (`jest.setTimeout`), incompatível com mocha (confirmado em `git show HEAD`). O runner canônico é jest.

### Change Log

| Data | Versão | Descrição | Autor |
|------|--------|-----------|-------|
| 2026-07-19 | 1.0 | Implementação WSB-5.3: manifest regenerado, seção README Cortex, check `project.cortex-modules`, smoke test de instalação real | Dex (@dev) |
