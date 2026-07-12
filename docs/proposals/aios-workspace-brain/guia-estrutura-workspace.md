# Guia de Estrutura do Workspace — AIOX Cortex

> **Público:** owner e equipe. Este guia define a convenção oficial de pastas do workspace e explica como o cérebro central localiza cada informação.
> **Relacionado:** proposta seção 4.1/4.2 · stories WSB-1.1 a WSB-1.6

---

## 1. A convenção de pastas (modelo PARA)

Cada tipo de atribuição/conteúdo tem sua pasta. A estrutura **é** a semântica: a pasta onde algo vive diz ao cérebro o que aquilo significa e quem pode escrever ali.

```
Empresa/
├── workspace.yaml              ← o "mapa-mãe" que o cérebro lê primeiro
├── 01-projects/                • o que está sendo CONSTRUÍDO agora
│   ├── produto-x/              (código, com .aios-core instalado)
│   └── novo-site/
├── 02-areas/                   • operação contínua — uma pasta por área
│   ├── marketing/
│   │   ├── _index.md           ← porta de entrada da área
│   │   ├── campanhas/
│   │   ├── ideias/             ← ideias "jogadas" ficam aqui mesmo
│   │   └── resultados/
│   ├── design/
│   ├── comercial/
│   └── financeiro/
├── 03-resources/               • referência estável (só leitura)
│   ├── marca/                  ← logo, manual da marca, tom de voz
│   ├── contratos/
│   └── templates/
└── 04-archives/                • histórico (indexação fria)
```

### Regras da convenção

1. **Uma pasta por área em `02-areas/`** — tudo de marketing vive em `marketing/`, sem exceção. Conteúdo solto na raiz não é indexado com semântica de área.
2. **Cada área tem um `_index.md`** — ~10 linhas: o que vive ali, qual é o documento oficial de cada assunto, o que está em rascunho. É o que um humano novo leria primeiro; o cérebro também.
3. **Uma fonte da verdade por assunto** — o manual da marca oficial fica em `03-resources/marca/`; versões de trabalho ficam na área. O `_index.md` aponta qual é o oficial.
4. **Tiers definem permissão de escrita dos agentes:**

| Tier | Leitura | Escrita |
|------|---------|---------|
| `projects` | ✓ | ✓ via story |
| `areas` | ✓ | ✓ com aprovação (surface decision) |
| `resources` | ✓ | ✗ (só humanos) |
| `archives` | ✓ (indexação fria) | ✗ |

## 2. Como o cérebro sabe onde buscar — as 3 camadas

**Camada 1 — O mapa (`workspace.yaml` + `_index.md`):** o manifest declara quais raízes existem e o que significam; os `_index.md` dizem o que vive em cada área. Resolve "onde está o oficial de X" sem busca nenhuma.

**Camada 2 — O índice (WSB-1.2/1.3):** o indexer varre as raízes e cada trecho indexado carrega metadados de origem: `{área, tier, arquivo, data}`. Busca escopada ("só marketing") e resposta sempre com fonte citada.

**Camada 3 — O grafo de entidades (WSB-1.4):** liga as coisas: *marca → manual em resources/marca → usada pelo produto-x → do cliente Y*. Permite raciocínio de projeto: "para o sistema novo preciso da identidade visual (sei onde está), tom de voz (idem) e das decisões de stack anteriores (decision logs do produto-x)".

**Fluxo completo:** pedido → grafo identifica entidades relevantes → índice puxa trechos certos → SYNAPSE L8 injeta o que cabe no orçamento de tokens → agente trabalha já sabendo tudo, citando fontes.

## 3. Trabalho em equipe

**O conteúdo é compartilhado; o índice é local em cada máquina.**

- As pastas vivem em armazenamento que a equipe já usa: Google Drive/OneDrive (documentos) + repositórios git (código). Ninguém muda de ferramenta.
- Cada membro instala o AIOX e roda `aios brain index` — indexa localmente o mesmo conteúdo compartilhado. Mesmo conhecimento, privacidade local, zero servidor.
- As permissões por tier valem para os agentes de todos os membros.
- Evolução futura (Pro): índice compartilhado num servidor da empresa — o que o agente de um membro aprende hoje aparece para o time amanhã. Fora do MVP de propósito: local-first primeiro.

## 4. Anti-padrões (o que NÃO fazer)

- ❌ Pasta "geral"/"outros" — conteúdo sem área é conteúdo que o cérebro não contextualiza.
- ❌ Duplicar o documento oficial em várias áreas — link/referência no `_index.md`, não cópia.
- ❌ Colocar código de produção em `areas/` — código ativo é `projects/`.
- ❌ Guardar segredos (senhas, chaves) em pastas indexadas — o indexer tem denylist, mas segredos pertencem a um cofre, não ao workspace.
