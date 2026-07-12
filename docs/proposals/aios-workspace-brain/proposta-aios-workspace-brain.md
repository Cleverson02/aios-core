# AIOS Workspace Brain — Análise e Blueprint Arquitetural

> **Produto:** AIOX Cortex (nome confirmado pelo owner; grafia alternativa aceita: Cortex-AIOX)
> **Status:** ✅ VALIDADA — 5 decisões confirmadas pelo owner em 2026-07-12
> **Data:** 2026-07-12
> **Autores:** Análise técnica assistida por IA sobre o código real do aios-core v4.0.0
> **Épico relacionado:** `docs/stories/epics/epic-aios-workspace-brain/`

---

## 1. Sumário Executivo

**Pergunta:** É interessante e viável transformar o AIOS em um *workspace orquestrador* — um "segundo cérebro" com acesso a todos os projetos e documentos da empresa, autonomia de longa duração, gestão inteligente de janelas de contexto, roteador multi-LLM (Claude Opus 4.8 / Fable 5, OpenAI Codex, xAI Grok) e comando remoto via Telegram?

**Veredicto: SIM — viável e estrategicamente forte.** E o mais surpreendente da análise: **~70% das fundações já existem no código do aios-core**, porém fragmentadas em três gerações de orquestradores e com a camada de memória praticamente vazia. O trabalho não é "construir do zero" — é **consolidar, completar e conectar** o que já existe, e adicionar 5 capacidades novas.

O que já existe hoje (verificado no código):

| Capacidade desejada | O que já existe | Onde |
|---|---|---|
| Orquestração multi-agente | 3 orquestradores (Workflow, Master/ADE, Bob) | `.aios-core/core/orchestration/` |
| Trabalho autônomo longo | Loop autônomo de build com checkpoint/resume, timeout, retry | `.aios-core/core/execution/autonomous-build-loop.js`, `build-state-manager.js` |
| Execução paralela | Wave executor + parallel executor com modos RACE/CONSENSUS/BEST_OF/FALLBACK | `.aios-core/core/execution/` |
| Multi-provider LLM | Dispatcher Claude + Gemini | `.aios-core/core/execution/subagent-dispatcher.js` |
| Medição de janela de contexto | Context bracket + token budget por camada | `.aios-core/core/synapse/context/context-tracker.js` |
| Escalação humana criteriosa | Surface criteria (quando parar e perguntar) | `.aios-core/core/orchestration/bob-surface-criteria.yaml` |
| Injeção de contexto per-prompt | SYNAPSE 8 camadas, <100ms | `.aios-core/core/synapse/engine.js` |
| Spawn de novas sessões/terminais | Terminal spawner cross-platform | `.aios-core/core/orchestration/terminal-spawner.js` |
| Observabilidade | Hooks Python + eventos de dashboard | `.aios-core/monitor/`, `.aios-core/core/events/` |
| Distribuição | npm/npx + manifest de 969 arquivos + squads | `packages/installer/`, `install-manifest.yaml` |

O que **não** existe e precisa ser construído (os 5 gaps):

1. **Workspace multi-raiz** — o AIOS é per-projeto; não há conceito de workspace da empresa.
2. **Second Brain real** — a camada de memória tem só `gotchas-memory.js`; o memory bridge do SYNAPSE (SYN-10) é um placeholder no-op; não há índice semântico de documentos.
3. **Roteador de LLM por capacidade** — o dispatcher conhece Claude/Gemini, mas não roteia por tipo de tarefa nem conhece Codex/Grok.
4. **Handoff de contexto** — o sistema *mede* o contexto, mas não lança janela limpa com pacote de handoff quando o contexto enche.
5. **Gateway remoto (Telegram)** — inexistente.

---

## 2. Correção de fatos: o cenário de modelos (julho/2026)

Antes do blueprint, um ajuste factual importante para o roteador:

- **xAI**: o lançamento novo é o **Grok 4.5** (anunciado em 08/07/2026), não "Grok 5.4". É co-treinado com o Cursor, focado em coding agêntico multi-arquivo, ~2x mais eficiente em tokens, preço US$2/M input e US$6/M output. Posicionado como "comparável ao Opus 4.7, porém mais rápido e barato".
- **OpenAI**: o Codex hoje roda a família **GPT-5.5 / GPT-5.6** (GPT-5.6 saiu em 09/07/2026). O GPT-5.5 é o modelo agêntico de coding mais forte deles (82,7% no Terminal-Bench 2.0).
- **Anthropic**: **Claude Opus 4.8** e a nova família **Claude 5** (Fable 5), o topo de capacidade geral.

Fontes: [xAI — Introducing Grok 4.5](https://x.ai/news/grok-4-5), [OpenAI — Introducing GPT-5.5](https://openai.com/index/introducing-gpt-5-5/), [OpenAI Codex](https://openai.com/codex/), [OpenAI — Introducing GPT-5.4](https://openai.com/index/introducing-gpt-5-4/).

Implicação de design: o mercado muda a cada ~60 dias. O roteador **não pode ter modelos hardcoded** — precisa de uma *capability matrix* versionada em YAML, atualizável sem release.

---

## 3. Diagnóstico do estado atual (análise cirúrgica)

### 3.1 Forças reais

1. **Metodologia madura** — Constitution com gates, story-driven development, 12 agentes, ~200 tasks, 14 workflows, quality gates em 3 camadas. Isso é o que frameworks concorrentes não têm: *processo*.
2. **Execução autônoma já resolvida no nível mecânico** — `autonomous-build-loop` (plan → execute → verify → retry, máx. 10 iterações/subtask), `build-state-manager` (checkpoint/resume, detecção de builds abandonados), `semantic-merge-engine` (merge com resolução de conflitos por IA), worktrees automáticos (`autoClaude` no core-config).
3. **SYNAPSE é a joia escondida** — pipeline de 8 camadas com orçamento de 100ms que já calcula *context bracket* (percentual de janela usada) e token budget. É a fundação perfeita tanto para o second brain quanto para o handoff de contexto.
4. **Distribuição resolvida** — installer npm com manifest hasheado, upgrades brownfield, squads como pacotes npm. O "AIOS Turbinado" distribui pelo mesmo canal.

### 3.2 Fraquezas (dívidas que o projeto Workspace deve resolver, não herdar)

1. **Três gerações de orquestradores sobrepostas** (WorkflowOrchestrator, MasterOrchestrator/ADE, BobOrchestrator) com responsabilidades duplicadas. Não construir uma quarta — **consolidar sobre o Bob** (o mais recente, com surface-criteria e session-state próprios).
2. **Três registries** (service-registry.json, entity-registry.yaml, workflow-registry) e **três sistemas de sessão** distintos. O brain deve unificá-los atrás de uma API única.
3. **Memória esquelética** — `memory-query.js` e `session-memory.js` foram removidos (Story MIS-2) mas ainda são referenciados com fallback null por `execution/` e `ideation/`. O SYN-10 (memory bridge) está como no-op. **Este é o gap nº 1.**
4. **Ideation engine é heurístico e local** — os 5 analyzers são regex/heurísticas, não usam LLM nem contexto de negócio. Serve de esqueleto para o Radar de Oportunidades, mas o miolo precisa ser trocado.

---

## 4. Blueprint: os 6 módulos do AIOS Workspace Brain

Arquitetura proposta, respeitando a Constitution (CLI First; tudo funciona 100% via CLI antes de qualquer UI):

```
┌─────────────────────────────────────────────────────────────┐
│                    GATEWAY (Telegram/CLI)                    │  ← comando remoto
├─────────────────────────────────────────────────────────────┤
│                 ORCHESTRATOR (Bob consolidado)               │  ← decide O QUE fazer
├──────────────┬──────────────────┬───────────────────────────┤
│  LLM ROUTER  │  AUTONOMY ENGINE │   OPPORTUNITY RADAR       │  ← decide COMO/QUEM/QUANDO
├──────────────┴──────────────────┴───────────────────────────┤
│                    BRAIN (Second Brain)                      │  ← sabe TUDO
├─────────────────────────────────────────────────────────────┤
│                 WORKSPACE (multi-raiz, permissões)           │  ← acesso a TUDO
└─────────────────────────────────────────────────────────────┘
```

### 4.1 `workspace/` — Workspace Manager (fundação)

O AIOS deixa de enxergar "um projeto" e passa a enxergar **a empresa**.

- **`workspace.yaml`** na raiz do workspace do usuário, declarando raízes no modelo PARA (Projects, Areas, Resources, Archives):

```yaml
workspace:
  name: "Minha Empresa"
  roots:
    projects:            # código ativo — leitura + escrita via stories
      - path: ~/dev/produto-x
        aios: true       # tem .aios-core instalado
      - path: ~/dev/site-institucional
    areas:               # operação contínua — leitura + escrita supervisionada
      - path: ~/Drive/Financeiro
      - path: ~/Drive/Marketing
    resources:           # referência — somente leitura
      - path: ~/Drive/Contratos
      - path: ~/Notas/Obsidian
    archives:            # histórico — somente leitura, indexação fria
      - path: ~/Drive/Arquivo-2024
  permissions:
    default: read
    write_requires: story | approval   # Constitution Art. III preservada
```

- **Camadas de permissão**: leitura em qualquer raiz; escrita **só** em `projects` via story ou em `areas` com aprovação (surface decision). Isso mantém a autonomia segura — o agente "tem acesso a qualquer coisa se necessário" sem risco de reescrever um contrato.
- **CLI**: `aios workspace init`, `aios workspace add <path> --tier projects|areas|resources|archives`, `aios workspace status`.
- **Reuso**: o `context-detector`/`context-loader` de `core/session/` passa a resolver "em qual raiz estou e o que ela significa".

### 4.2 `brain/` — Second Brain (o coração do Mega Brain)

Índice vivo de tudo que a empresa produz, consultável por agentes e pelo dono.

**Componentes:**

1. **Indexer** — varredura incremental das raízes do workspace (reusa `chokidar` + `fast-glob`, já dependências do projeto). Extrai: markdown, código, PDFs/Office (via conversores), decisões (`.ai/decision-logs`), stories, gotchas.
2. **Índice híbrido** — duas camadas:
   - *Léxica*: índice invertido local (rápido, zero custo) para busca exata.
   - *Semântica*: embeddings em SQLite com extensão vetorial (ex.: `sqlite-vec`), 100% local — nenhum documento sai da máquina para indexação, só para consultas que o usuário autorizar.
3. **Grafo de entidades** — clientes, produtos, pessoas, projetos, decisões e as relações entre eles ("o contrato X pertence ao cliente Y que usa o produto Z"). Evolui o `entity-registry.yaml` do IDS de "artefatos do framework" para "entidades do negócio".
4. **Memory API unificada** — reimplementa `memory-query.js` e `session-memory.js` (os módulos removidos que `execution/` e `ideation/` ainda tentam importar — os pontos de integração **já estão lá esperando**), agora respondendo com dados do brain.
5. **SYNAPSE L8** — nova camada "Workspace Knowledge" no pipeline SYNAPSE: a cada prompt, o brain injeta os 3-5 fatos/documentos mais relevantes dentro do token budget que o `context-tracker` já calcula. **Isto completa o SYN-10** (hoje um placeholder no-op).
6. **Ciclo de escrita (aprendizado)** — ao fim de cada sessão/story, um *session digest* (decisões, aprendizados, arquivos tocados) é gravado de volta no brain. O cérebro aprende com o trabalho — não é só um índice passivo.

**CLI**: `aios brain index`, `aios brain ask "<pergunta>"`, `aios brain entities`, `aios brain digest`.

### 4.3 `router/` — LLM Router (multi-modelo por capacidade)

Evolução do `subagent-dispatcher.js` (que já roteia Claude/Gemini) para um roteador universal orientado a *capability matrix*:

```yaml
# .aios-core/core/router/capability-matrix.yaml (versionado, atualizável sem release)
models:
  claude-opus-4-8:
    provider: anthropic          # via Claude Code CLI / API
    strengths: [reasoning, architecture, long-context, writing, review]
    cost_tier: high
  gpt-5.5-codex:
    provider: openai             # via codex CLI
    strengths: [agentic-coding, terminal, refactor-scale, computer-use]
    cost_tier: medium
  grok-4-5:
    provider: xai                # via API / cursor-agent
    strengths: [coding-speed, token-efficiency, cost, long-repo-context]
    cost_tier: low
  gemini-2.x:
    provider: google             # já suportado hoje
    strengths: [long-context-bulk, multimodal, cost]
    cost_tier: low
routing_policies:
  quality-first: prefer highest capability match
  cost-first: prefer lowest cost_tier above threshold
  speed-first: prefer fastest above threshold
task_routing:
  architecture-decision: claude-opus-4-8
  bulk-refactor: gpt-5.5-codex | grok-4-5
  test-generation: grok-4-5
  code-review: claude-opus-4-8
  research-summarize: gemini-2.x
  story-implementation: policy:cost-first
```

- **Classificação** — o `task-complexity-classifier.js` **já existe** em orchestration; o router o usa para mapear task → categoria → modelo.
- **Dois modos**: *autônomo* (executa no modelo escolhido) e *conselheiro* (`aios route suggest <task>` — apenas indica qual modelo usar, para quando você opera manualmente no Cursor/Codex/Grok).
- **Consenso cross-vendor** — os modos RACE/CONSENSUS/BEST_OF do `parallel-executor.js` **já existem** para Claude+Gemini; estendê-los para 4 providers cria algo raro no mercado: *code review por consenso entre Opus, Codex e Grok* para decisões críticas.
- **Fallback e resiliência** — `rate-limit-manager.js` já implementa backoff; o router adiciona failover entre providers (Anthropic fora do ar → rebota a wave no Codex).

**CLI**: `aios route suggest "<task>"`, `aios route run --policy cost-first`, `aios route matrix`.

**Sobre "equiparar qualquer modelo ao Fable 5"** — expectativa honesta: harness nenhum transforma um modelo fraco em um modelo de fronteira. O que o AIOS **pode** fazer (e é comprovadamente eficaz) é fechar boa parte do gap via *context engineering*: (a) o brain entrega ao modelo exatamente o contexto certo; (b) as waves decompõem o problema em subtarefas pequenas onde modelos médios performam como grandes; (c) os quality gates + consenso cross-model pegam os erros que o modelo menor comete. Resultado prático: **Grok 4.5 a US$2/M com o harness do AIOS entrega resultado próximo ao de um modelo top sem harness** — e o router garante que as decisões realmente difíceis vão para o Opus/Fable. É assim que o "Mega Brain" fica barato E bom.

### 4.4 `autonomy/` — Long-Run Engine (trabalhar horas sem degradar)

O que falta para "rodar por mais tempo de maneira independente sem perder qualidade" é fechar o ciclo entre peças que já existem:

1. **Context Budget Manager** — usa o `context-tracker` do SYNAPSE (que já calcula bracket) com 3 zonas: **verde** (<60%: segue), **amarela** (60-80%: comprime com o `epic-context-accumulator`, que já existe), **vermelha** (>80%: prepara handoff).
2. **Handoff Packet** — na zona vermelha, gera um pacote de continuação: estado do build (`build-state-manager` já persiste), story atual + checkboxes, decisões tomadas (decision logs já existem), gotchas relevantes e próxima subtask. É a materialização do "handoff warning" que o SYNAPSE já sinaliza mas não age.
3. **Fresh Window Spawner** — lança nova sessão limpa com o handoff packet como contexto inicial (o `terminal-spawner.js` cross-platform já existe; em Claude Code, também dá para usar worktree + nova sessão). A nova janela começa com ~5% de contexto em vez de 85%. **Zero desperdício de tokens em contexto morto.**
4. **Heartbeat + Escalação** — a cada N subtasks, checkpoint + autoavaliação contra os quality gates; se travar 2x na mesma subtask ou bater um surface-criteria (`bob-surface-criteria.yaml` já define isso), escala para o humano — via Gateway (Telegram) se você estiver longe.

**CLI**: `aios run --long <story|epic>`, `aios run status`, `aios run resume <session-id>`.

### 4.5 `gateway/` — Remote Gateway (Telegram primeiro)

Comando e retorno pelo Telegram, respeitando CLI First (o gateway é um *cliente* do CLI, nunca um segundo cérebro de decisão):

- **Bot Telegram** (long polling — não requer servidor público) com autenticação por chat-id na allowlist + comando de pareamento.
- **Comandos**: `/status` (o que está rodando), `/run <story>`, `/ask <pergunta ao brain>`, `/approve` e `/reject` (surface decisions com botões inline), `/report` (digest diário).
- **Notificações de saída** — o `notification-manager.js` dos quality-gates já existe como ponto de plug: fim de build, gate FAIL, escalações, PR criado.
- **Segurança**: tokens fora do repo (env), escopo de comandos configurável, ações destrutivas sempre exigem confirmação explícita, tudo logado em `.ai/`.

**CLI**: `aios gateway start|stop|pair|status`.

### 4.6 `radar/` — Opportunity Radar (orientar novas ideias e gaps)

Upgrade do `ideation-engine.js` de heurísticas locais para inteligência com contexto de negócio:

- **Entrada**: grafo de entidades + digests do brain + métricas dos projetos + (opcional) pesquisa web via EXA (MCP já configurado).
- **Análises**: gaps entre o que a empresa faz e o que os clientes pedem; retrabalho recorrente (gotchas repetidos = oportunidade de produto interno); ativos subaproveitados ("vocês têm 3 projetos com o mesmo módulo de billing — extrair um pacote"); tendências externas cruzadas com capacidades internas.
- **Saída**: relatório mensal/sob demanda de oportunidades ranqueadas por esforço × impacto, cada uma já no formato de *project brief* do AIOS (pronta para virar PRD → epic → stories).
- **Rotina**: agendável (cron/Routine), com entrega via Telegram.

**CLI**: `aios radar scan`, `aios radar report`, `aios radar brief <opportunity-id>`.

---

## 5. Vantagens reais (por que vale a pena)

1. **De framework de desenvolvimento → sistema operacional da empresa.** Hoje o AIOS orquestra *um projeto de software*. Com workspace + brain, orquestra *o portfólio*: código, documentos, decisões e conhecimento num só grafo. É exatamente o posicionamento "Mega Brain" — mas com uma vantagem estrutural: os concorrentes de "second brain" (Notion AI, Rewind, etc.) não **executam**; o AIOS executa com metodologia e gates.
2. **Economia direta de tokens.** Handoff de janela + compressão por bracket + roteamento cost-first: a maior parte do volume roda em Grok 4.5/Gemini (baixo custo), reservando Opus/Fable para decisões de arquitetura e review. Estimativa conservadora: 40-60% de redução de custo por story versus rodar tudo no modelo top com contexto inchado.
3. **Qualidade defensável.** Consenso cross-vendor em decisões críticas + quality gates existentes = menos regressões que qualquer operador humano solo.
4. **Assimetria competitiva na distribuição.** O canal npm/squads já existe. O "AIOS Turbinado" pode ser distribuído em camadas: core open-source (workspace + router básico) e brain/radar/gateway como módulo pro (o submodule `pro/` e o `aios-pro-cli` já existem para licenciamento).
5. **Antifragilidade a mudança de modelos.** Capability matrix em YAML = quando sair o próximo Grok/GPT/Claude, é um PR de 10 linhas, não um refactor.

## 6. Riscos e mitigações (viabilidade honesta)

| Risco | Severidade | Mitigação |
|---|---|---|
| Herdar a dívida das 3 gerações de orquestradores | Alta | Fase 0 consolida sobre o Bob antes de construir em cima |
| Privacidade (indexar documentos da empresa) | Alta | Indexação 100% local; embeddings locais; allowlist de raízes; nada sai sem consulta explícita |
| Telegram como vetor de ataque | Média | Allowlist de chat-id, pareamento, confirmação para ações de escrita, log completo |
| Custo de manter integrações com 4 providers | Média | Adapters finos por CLI oficial (claude/codex/api xAI); matrix em YAML |
| Scope creep (virar "faz-tudo" e não terminar) | Alta | Roadmap em fases com valor entregável por fase; cada fase é utilizável sozinha |
| Modelos menores decepcionarem mesmo com harness | Média | Router com policy quality-first para tarefas críticas; consenso como rede de segurança |

**Esforço estimado (ordem de grandeza, com o próprio AIOS executando):** Fase 0-1 (consolidação + workspace + brain MVP) ≈ 3-4 semanas; Fases 2-3 (router + autonomy) ≈ 2-3 semanas; Fases 4-5 (gateway + radar) ≈ 2 semanas. Total ≈ 7-9 semanas de execução story-driven.

## 7. Roadmap em fases

| Fase | Entrega | Valor imediato |
|---|---|---|
| **0 — Consolidação** | Bob como orquestrador único; unificar 3 registries e 3 sessões atrás de APIs únicas; reativar Memory API (MIS) | Base sólida; destrava SYN-10 |
| **1 — Workspace + Brain MVP** | `workspace.yaml`, indexer léxico+semântico local, `aios brain ask`, SYNAPSE L8 | O segundo cérebro nasce; agentes passam a saber "tudo da empresa" |
| **2 — LLM Router** | Capability matrix, adapters (Anthropic/OpenAI/xAI/Google), modo conselheiro + autônomo | Roteamento por tarefa; economia imediata |
| **3 — Autonomy Engine** | Zonas de contexto, handoff packet, fresh window spawn, heartbeat | Sessões de horas sem degradação nem desperdício |
| **4 — Gateway Telegram** | Bot, aprovações inline, notificações, digest | Comando remoto do bolso |
| **5 — Radar + Empacotamento** | Opportunity radar, rotinas agendadas, empacotamento core/pro para distribuição | O "Mega Brain" completo e distribuível |

O detalhamento em stories está no épico: `docs/stories/epics/epic-aios-workspace-brain/epic-aios-workspace-brain.md`.

## 8. Decisões — ✅ CONFIRMADAS pelo owner em 2026-07-12

> Todas as 5 decisões abaixo foram validadas pelo owner. Alterações futuras exigem amendment (processo de governança da Constitution).

| # | Decisão | Decisão confirmada | Alternativas descartadas |
|---|---------|---------------------|--------------|
| 1 | **Nome/brand** | **AIOX Cortex** ✅ — herança AIOS→AIOX + "Cortex" (o córtex é o cérebro executivo: quem sabe, decide e coordena). npm `@aiox/cortex` | *Synkra Nexus*, *AIOX Atlas*, *AIOX Hive* |
| 2 | **Open-source vs Pro** | ✅ Workspace + Router no **core aberto** (adoção/comunidade); Brain semântico, Radar e Gateway Telegram na **Pro** (diferencial pago — a infra `aios-pro-cli` já existe) | Tudo aberto; tudo Pro |
| 3 | **Embeddings** | ✅ **Local por padrão, API opt-in** — nenhum documento da empresa sai da máquina na indexação; quem quiser qualidade máxima ativa API explicitamente | Sempre local; sempre API |
| 4 | **Canal remoto** | ✅ **Telegram primeiro**, com interface de canal plugável para WhatsApp/Slack depois | Multi-canal desde o início |
| 5 | **Integração Grok** | ✅ **API xAI direta** (mais controle, sem dependência do Cursor) | Via Cursor CLI |

## 9. Onde o AIOX vive: repositórios, instalação e distribuição

Plano de armazenamento e distribuição (do desenvolvimento até a equipe e testers externos):

### 9.1 No GitHub (fonte da verdade)

| Estágio | Local | Papel |
|---|---|---|
| **Agora (validação)** | `Cleverson02/aios-core`, branch `claude/aiox-workspace-orchestration-lv9gzt` | Onde esta proposta e o épico WSB estão. PRs de desenvolvimento partem daqui |
| **Fase 0-2 (construção)** | Mesmo fork, branches `feat/wsb-*` mergeadas na `main` do fork | Desenvolvimento story-driven normal |
| **A partir da Fase 5 (produto)** | **Repositório dedicado `Cleverson02/aiox-cortex`** (depois, org própria ex.: `aiox-ai/cortex`) | Identidade própria, releases versionados via semantic-release, issues/discussões de testers separadas do upstream SynkraAI |
| **Camada Pro** | Repo privado `aiox-cortex-pro` (mesmo modelo do submodule `pro/` atual) | Brain semântico, Radar, Gateway — acesso por licença |

### 9.2 No computador (do owner e da equipe)

| O quê | Onde | Observação |
|---|---|---|
| Clone de desenvolvimento | `~/dev/aiox-cortex` (ou onde preferir) | É onde se trabalha nas stories |
| Instalação Pro existente | `/projeto/scout` | Permanece como instância de teste real (brownfield) — o upgrade da Fase 5 (WSB-5.3) valida contra ela |
| Instalação nos projetos da equipe | Cada projeto recebe `.aios-core/` via installer, como hoje | Nada muda no fluxo mental de quem já usa AIOS |
| Workspace Brain (dados) | `~/.aiox/` (índice, grafo, digests) + `workspace.yaml` na raiz do workspace | Fora dos repositórios git — conhecimento da empresa não vai para o GitHub |

### 9.3 Distribuição para equipe e testers

1. **Curto prazo (antes do npm):** instalação direto do GitHub — `npx github:Cleverson02/aios-core install` (o installer atual suporta; testers precisam apenas de acesso ao repo).
2. **Médio prazo:** publicar no npm como `@aiox/cortex` → equipe/testers rodam `npx @aiox/cortex install` (mesmo fluxo do `npx aios-core install` de hoje, manifest hasheado e upgrade brownfield inclusos).
3. **Pro:** ativação via CLI de licença (`aiox pro activate <key>`), reaproveitando o `packages/aios-pro-cli`.
4. **Squads extras** (os que hoje diferenciam sua instalação em `/projeto/scout`): empacotados como pacotes npm de squad, instaláveis por `aiox squad add <nome>` — assim testers recebem exatamente o mesmo ambiente seu.

---

*Documento gerado a partir de análise direta do código (aios-core v4.0.0, 969 arquivos no manifest) e verificação do cenário de modelos em 12/07/2026.*
