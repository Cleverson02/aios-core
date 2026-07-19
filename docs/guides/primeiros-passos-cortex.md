# Primeiros passos com o AIOX Cortex

Guia direto para sair do zero e deixar o `aios next` te guiar pela metodologia.
Se você não conhece a ordem `@pm → @po/@sm → @dev → @qa → @devops`, não precisa
decorar: rode `aios next` a cada passo e siga a recomendação.

## O ciclo básico (10 passos)

1. **Instale o AIOS** — `npx aios-core install`
   _Traz a CLI, os agentes e a metodologia para o seu projeto._

2. **Configure os provedores** — `aios setup`
   _Cadastra suas chaves de LLM e prepara o ambiente; ao final ele já sugere o próximo passo._

3. **Crie o workspace** — `aios workspace init`
   _Declara o "mapa-mãe" (projects/areas/resources/archives) que o brain lê primeiro._

4. **Indexe o brain** — `aios brain index`
   _Constrói o índice determinístico que dá contexto aos agentes sem gastar tokens._

5. **Pergunte o que fazer** — `aios next`
   _Mostra o estado atual do projeto e o próximo agente/comando, com o porquê em 1 frase._

6. **Escreva o PRD** — `@pm *create-prd`
   _O Product Manager transforma a ideia em requisitos claros (siga o que o `aios next` indicar)._

7. **Quebre em stories** — `@po *create-story` (ou `@sm *create-story`)
   _O PO/SM detalha o trabalho em stories acionáveis com acceptance criteria._

8. **Implemente** — `@dev *develop-story <id>`
   _O Dev implementa exatamente os AC da story; rode `aios next` para saber qual story vem._

9. **Revise e publique** — `@qa *review-story` e depois `@devops *push`
   _O QA valida a qualidade; só o DevOps publica as mudanças no remoto._

10. **Acompanhe custos e observe** — `aios dashboard start` e `aios costs summary`
    _O dashboard local observa o que a CLI faz; o resumo de custos garante que você não é "bebedor de tokens"._

## Regra de ouro

Sempre que estiver em dúvida, rode **`aios next`** (ou `aios next --explain` para ver o
mapa completo do fluxo). A CLI é a fonte da verdade — ela te diz onde você está e para
onde ir, sem queimar tokens.
