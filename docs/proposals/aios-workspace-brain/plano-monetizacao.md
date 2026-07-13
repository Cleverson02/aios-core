# AIOX Cortex — Plano de Monetização

> **Status:** Proposta para validação do owner
> **Data:** 2026-07-13
> **Relacionado:** proposta seção 8 (decisão #2: core aberto vs Pro) e seção 9 (distribuição) · Épico MON

---

## 1. Princípio central (leia primeiro)

O AIOX é JavaScript distribuído — o código instalado é visível. Tentar "proteger" código com ofuscação é guerra perdida e irrita cliente bom. O que se monetiza com sucesso neste modelo é:

1. **Conteúdo vivo** — squads/skills premium que recebem atualização contínua (quem pirateia fica com a versão velha)
2. **Serviços hospedados** — o que roda nos NOSSOS servidores não tem como piratear (dashboards, índice compartilhado, radar com pesquisa, MCP hosted)
3. **Conveniência** — instalação em 1 comando, updates automáticos, suporte
4. **Time** — seats, colaboração, administração

A licença é o **cadeado social e de conveniência**, não a muralha. A muralha são os serviços hospedados.

## 2. As 4 camadas do produto

| Camada | O quê | Preço (hipótese a validar) |
|---|---|---|
| **Free (core aberto)** | AIOS metodologia completa + Workspace + Brain local (léxico + hashing) + Router + squads básicos | R$ 0 — motor de adoção e comunidade |
| **Cortex Pro** (assinatura individual) | Tudo do free + embeddings de alta qualidade (API), Radar de Oportunidades, Gateway Telegram, autonomia longa (Fase 3), squads Pro do catálogo, updates prioritários | **R$ 97/mês** ou R$ 970/ano |
| **Cortex Team** (assinatura por empresa) | Tudo do Pro ×5 seats + **índice compartilhado do brain** (o cérebro da empresa sincronizado entre o time) + dashboard de observabilidade + administração de permissões | **R$ 297/mês** (5 seats; +R$ 47/seat extra) |
| **Squads Premium avulsos** | Squads específicos, caros e difíceis de replicar (ex.: copy-chief com 24 copywriters, legal-chief BR, cyber-chief, traffic-masters) | **R$ 197–697 compra única** por squad (inclui 12 meses de updates) — ou inclusos no Team |

**Regra de bolso do que é pago:** tudo que (a) roda em servidor nosso, (b) é conteúdo especializado de alto valor, ou (c) multiplica produtividade de TIME — é pago. O motor individual local é livre.

### Recalibração honesta vs decisão #2

A decisão #2 previa "brain semântico na Pro", mas a busca semântica local (hashing) já foi mergeada no core aberto — **não recomendo retirar** (quebra confiança da comunidade). O diferencial Pro passa a ser: embeddings neurais/API (qualidade superior), índice compartilhado de time, Radar e Gateway. Fica até melhor: o free é genuinamente útil e o upgrade é desejo, não chantagem.

## 3. Catálogo inicial de monetizáveis

| Item | Tipo | Modelo |
|---|---|---|
| copy-chief (24 copywriters lendários) | Squad premium | Avulso R$ 497 ou Team |
| legal-chief (especialistas BR) | Squad premium | Avulso R$ 697 ou Team |
| cyber-chief, data-chief, design-chief, traffic-masters, story-chief | Squads premium | Avulso R$ 197–497 ou Team |
| mmos / mind-cloning (clonar mentes) | Squad premium flagship | Avulso R$ 697 |
| Radar de Oportunidades (Fase 5) | Feature Pro | Assinatura |
| Gateway Telegram (Fase 4) | Feature Pro | Assinatura |
| Autonomia longa / handoff (Fase 3) | Feature Pro | Assinatura |
| Dashboard de observabilidade (SaaS) | Serviço hospedado | Team |
| Brain compartilhado do time | Serviço hospedado | Team |
| MCP hosted do Cortex | Serviço hospedado | Team / add-on |
| Implantação assistida ("montamos seu workspace-cérebro") | Serviço | R$ 2–5k por projeto, ticket alto |

## 4. Mecânica de entrega e licenciamento (a parte técnica)

Respondendo diretamente sua dúvida "MCP com login/senha, API, assinatura ou compra única":

### 4.1 Licença — chave única, tudo integrado

- **`aios pro activate <chave>`** — a infraestrutura JÁ EXISTE (`packages/aios-pro-cli` com activate/deactivate/status/features). A chave carrega os *entitlements* (plano + squads comprados).
- Validação online na ativação e a cada ~7 dias, com **grace period offline** (não pune quem viaja sem internet). Expirou de verdade → features Pro degradam graciosamente para o free (nunca quebra o trabalho do usuário).
- Um único identificador para tudo: CLI, download de squads, dashboard e MCP usam a mesma conta.

### 4.2 Squads premium — registry autenticado

- `aios squad add copy-chief` → o CLI chama nossa API com o token da licença → se o entitlement cobre, baixa o pacote (tarball assinado, hash verificado pelo manifest — mecanismo que o installer já usa).
- Compra única = entitlement perpétuo de uso + 12 meses de updates; renovação de updates com desconto.
- Piração possível? Sim, o pacote baixado é legível. Mas atualizações, novos agentes do squad e suporte só via licença — é onde o valor mora.

### 4.3 Dashboards — SaaS com login/senha

- Painel hospedado (login/senha ou SSO no Team) que **observa** o que os CLIs do time fazem (a telemetria opt-in dos hooks do monitor já existe no core).
- Respeita a Constitution Art. I: dashboard **nunca controla**, só observa — o que também simplifica segurança.

### 4.4 MCP hosted — o canal mais estratégico

- Um servidor MCP remoto (`mcp.aiox.com.br`) autenticado por **API key da conta**: o cliente conecta o Claude/Cursor/etc. da equipe direto no cérebro da empresa hospedado (busca, entidades, digests).
- É a resposta ao "como será a entrega": para features de conhecimento, **MCP com API key é melhor que login/senha em site** — o valor aparece dentro da ferramenta onde a pessoa já trabalha.
- Só faz sentido no plano Team (dados da empresa num serviço nosso = responsabilidade LGPD; contrato claro, dados isolados por tenant, região BR).

### 4.5 Billing

- **Brasil:** Stripe (tem PIX e parcelamento hoje) como primário; alternativa Hotmart/Kiwify para o funil de squads avulsos (checkout de infoproduto que o público BR já conhece).
- **Internacional:** Stripe. Preços em USD ~30-40% acima do BRL convertido (padrão de mercado).
- Webhook de pagamento → emite/atualiza a chave de licença automaticamente (license server, MON-1).

## 5. Estratégia de lançamento (ordem que minimiza risco)

1. **Agora (custo ~zero):** vender squads premium avulsos com entrega manual (chave por e-mail + `aios pro activate`) — valida disposição a pagar ANTES de construir infra.
2. **MON-1/2:** license server + registry autenticado → automatiza a entrega dos avulsos.
3. **Lançar Cortex Pro** (assinatura) quando Fases 3-4 estiverem prontas (Radar/Gateway/Autonomia são o "porquê assinar").
4. **Lançar Team** (brain compartilhado + dashboard + MCP hosted) — maior ticket, maior esforço, por último.

## 6. Épico MON — implementação da monetização

| Story | Entrega | Depende de |
|---|---|---|
| MON-1 | License server (emissão/validação de chaves, entitlements, grace period) + integração `aios pro activate` | — |
| MON-2 | Registry autenticado de squads (`aios squad add` com token, tarball assinado) | MON-1 |
| MON-3 | Feature-gating Pro no CLI (radar/gateway/embeddings-API checam entitlement, degradação graciosa) | MON-1, Fases 3-5 |
| MON-4 | Billing: Stripe + webhook → chave automática; página de checkout | MON-1 |
| MON-5 | Dashboard SaaS de observabilidade (multi-tenant, login/SSO) | telemetria opt-in |
| MON-6 | MCP hosted do brain (API key, tenant isolado, LGPD) | Team infra |
| MON-7 | Telemetria opt-in + métricas de uso (MRR, ativação, churn por feature) | MON-1 |

## 7. Decisões em aberto (para o owner validar)

1. **Preços** — os valores acima são hipóteses; validar com 5-10 clientes-alvo antes de fixar.
2. **Checkout BR** — Stripe puro ou Hotmart/Kiwify para squads avulsos?
3. **Nome comercial dos planos** — Free / Pro / Team, ou nomes próprios (ex.: "Cortex Solo" / "Cortex Company")?
4. **Quais squads ficam no free** — sugestão: dev/qa/po/sm/architect (a metodologia) livres; chiefs especializados pagos.
5. **Garantia** — 7 ou 30 dias de reembolso nos avulsos (30 dias é padrão infoproduto BR e aumenta conversão).
