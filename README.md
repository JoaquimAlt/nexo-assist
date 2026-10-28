# Nexo Assist — Service desk de TI

O colaborador conversa com o **Nexo Assist**, um agent que entende o pedido com um modelo de linguagem (Gemini, via Mastra), consulta os chamados dele, busca na central de ajuda, monta e abre chamados com confirmação e transfere para um analista quando precisa. O analista acompanha tudo no **console**: assume a conversa (com o agent pausado), responde, devolve ao agent ou encerra.

Cada resposta do agent tem um painel **"Como decidi"**, com o que ele entendeu, a ação que tomou, o grau de confiança, os motivos e quem interpretou a mensagem: o modelo, com tokens e tempo, ou as regras.

## Como rodar

```bash
npm install
cp .env.example .env   # coloque sua GOOGLE_API_KEY (https://aistudio.google.com/apikey)
npm run dev            # API em :8787 + front em http://localhost:5173
```

| Comando | O que faz |
| --- | --- |
| `npm run dev` | Sobe a API (`node --watch`) e o Vite juntos; o Vite repassa `/api` para a API |
| `npm test` | Testes do motor, das regras de prazo, do serviço de chamados, da API e da integração com o modelo |
| `npm run build` | Checagem de tipos do front e do servidor + build do front |
| `npm start` | Produção local: um único servidor entrega o front (`dist/`) e a API |

Requer Node 22 ou superior. **Sem `GOOGLE_API_KEY` o projeto funciona do mesmo jeito**: o agent usa só as regras, e o painel "Como decidi" avisa isso. Localmente, os dados ficam em `server/data/db.json`.

### Contas de demonstração

| Perfil | E-mail | Senha |
| --- | --- | --- |
| Colaboradora | `ana.souza@nexo.com.br` | qualquer |
| Analista N2 | `rafael.lima@nexo.com.br` | qualquer |

Outros colaboradores dos dados de exemplo: `carla.mendes@`, `bruno.tavares@`, `diego.ramos@`, `elisa.prado@`, `fabio.nunes@`, `gabriela.rocha@` (todos `@nexo.com.br`). A tela de login tem atalhos para Ana e Rafael.

### Roteiros

**Abrir chamado:** *"Meu notebook não conecta na VPN desde ontem. Aparece o erro 809."* → o agent explica que o artigo do erro 809 vale só para Windows 10 e pergunta quem é afetado → *"Só eu. Tenho reunião com um cliente às 14h"* → rascunho com prioridade alta. Se o prazo (4 h úteis) passar do horário citado, o agent avisa e oferece chamar um analista na hora.

**Consultar e transferir (duas abas):**
1. Na aba 1, entre como **Ana** com "Manter conectado" desmarcado. Pergunte *"Qual o status do meu chamado?"*, escolha o INC-20311 (vencido) e clique em **Falar com um analista**.
2. Na aba 2, entre como **Rafael**. A conversa da Ana aparece em "Para você", com o **resumo do agent** (motivo, chamado, relato e o que já foi feito).
3. **Assuma** e responda: a mensagem chega na aba da Ana em instantes. Enquanto o analista atende, o agent não responde. Teste **Devolver ao agent** e **Encerrar**.

**Outras regras:** *"Minha senha do SAP bloqueou de novo"* (oferece reabrir o INC-20150, resolvido há 4 dias) · *"Quando caem minhas férias?"* (fora de escopo → RH) · relate um problema e responda **Minha equipe** (prioridade crítica: ao confirmar, o agent cria o chamado e já transfere) · *"Preciso de uma licença do Adobe Acrobat"* (requisição REQ, prioridade baixa).

Para voltar ao estado inicial: menu do avatar no console › **Restaurar dados de demonstração**.

## Deploy na Vercel

O projeto roda inteiro na Vercel: o front é estático e a API vira uma função (`api/[[...route]].ts`, que usa o mesmo app Hono do servidor local).

1. Importe o repositório na Vercel. O `vercel.json` já define o build (`npm run build`), a pasta `dist` e a função da API.
2. Em **Storage**, crie um **Upstash Redis** (há plano gratuito) e conecte ao projeto. Ele cria `KV_REST_API_URL` e `KV_REST_API_TOKEN`; sem eles, a função não tem onde guardar conversas e chamados entre uma requisição e outra.
3. Em **Settings › Environment Variables**, adicione `GOOGLE_API_KEY`, `NEXO_MODEL` (o mesmo valor do seu `.env`) e um `LLM_DAILY_LIMIT` baixo (ex.: `200`).
4. Faça o deploy. Na primeira requisição, o banco é preenchido com os dados de demonstração.

**Proteção de chave e custo**, como pede o PRD: a chave fica só nas variáveis de ambiente da Vercel (nunca no repositório nem no navegador); o projeto do Google fica no nível gratuito, sem faturamento; `LLM_DAILY_LIMIT` limita as chamadas ao modelo por dia, e o limite de 30 mensagens por conversa é validado no servidor. Se o modelo estiver sobrecarregado ou o limite acabar, o agent continua funcionando pelas regras.

## Arquitetura

```
api/[[...route]].ts      função da Vercel: entrega todas as rotas /api/* ao app Hono
server/                  API (Hono) — tudo que tem chave, dado ou regra de acesso fica aqui
  app.ts                 rotas HTTP, validação de entrada (zod), permissões
  index.ts               servidor local (npm run dev / npm start)
  auth.ts                login, sessões e a visão filtrada por usuário (privacidade)
  db.ts                  banco: arquivo JSON localmente, Upstash Redis no deploy (com compare-and-set)
  llm.ts                 agent Mastra: interpreta a mensagem em formato estruturado
  runtime.ts             orquestra um turno: chamados → modelo → motor → efeitos no sistema legado
  tickets.ts             serviço de chamados simulado (legado: latência, falhas, dono do chamado)
  console.ts             ações do analista
src/
  agent/engine.ts        motor de regras (função pura): interpretação + contexto → resposta + efeitos + decisão
  data/                  tipos, rótulos, central de ajuda (kb.ts) e dados de demonstração
  lib/                   prazos (sla.ts), datas e limites
  api/                   cliente HTTP e ações da interface
  store/                 cópia local do estado, atualizada quando a revisão do servidor muda
  components/, pages/    interface (login, chat do colaborador, console do analista)
```

Um turno do agent, para uma mensagem de texto:

1. **Registra** a mensagem e mostra "digitando" (`runtime.ts`).
2. **Consulta os chamados** do colaborador no serviço legado, com até 3 tentativas.
3. **Interpreta** com o modelo (`llm.ts`): intenção, categoria, tipo, afetados, urgência, código de erro, artigo da central, confiança e motivos, validados por um schema zod.
4. **Decide** com o motor de regras (`engine.ts`), que aplica o Anexo A sobre essa interpretação e devolve a resposta, os *efeitos* (`create-ticket`, `add-note`, `reopen`, `handoff`…) e a decisão explicada.
5. **Aplica** os efeitos no serviço de chamados; se ele falhar, avisa que nada foi alterado e oferece **Tentar de novo**.
6. **Grava** a resposta; a revisão do banco muda e os navegadores, que perguntam a cada 1,5 s, baixam o estado novo.

O turno inteiro acontece dentro da requisição que enviou a mensagem, porque numa função da Vercel não existe "depois da resposta". Nenhum estado fica em memória entre requisições: tudo passa pelo banco, e cada gravação confere a revisão lida, para duas requisições simultâneas não apagarem a mudança uma da outra.

### Como o agent decide

O modelo **interpreta**; as regras **agem**. A divisão é proposital:

- **O modelo** resolve o que regras não resolvem bem: linguagem livre ("aquele quadro branco online", "ninguém aqui consegue trabalhar"), intenção implícita, dados espalhados na frase. Ele recebe só o necessário: quem é a pessoa, **apenas os chamados dela**, os títulos da central de ajuda, o estado da conversa e as últimas mensagens.
- **As regras** cuidam do que precisa ser exato e auditável: prazos em horas e dias úteis, prioridade pelo impacto e pela urgência, duplicidade e reabertura em até 7 dias, transferência, privacidade e **nenhuma criação ou alteração sem confirmação**. Nada que o modelo devolva cria ou altera um chamado sozinho; "quem é afetado" só é aceito se a pessoa disse.
- **Confiança:** abaixo de 50%, o agent não age e pede para reformular; na segunda vez seguida, transfere para um analista com o status "Agent pediu ajuda".
- **Fallback:** sem chave, com o modelo sobrecarregado, sem resposta em 10 s ou com o limite diário atingido, o motor segue com as regras de palavras-chave, e o painel diz o motivo.

### Escolha do modelo

**Gemini Flash** (`google/gemini-3.8-flash`), pelo model router do Mastra:

- A tarefa é **classificação estruturada**, não geração longa: um modelo rápido e barato resolve, e a saída é validada por schema.
- Responde em poucos segundos, o que cabe no chat e no tempo de uma função da Vercel, e tem nível gratuito no Google AI Studio, o que facilita avaliar o projeto.
- **Uso consciente do modelo:** só **mensagens de texto** chamam o modelo, uma vez cada (sem loop de ferramentas: o contexto já vai na chamada). Botões, escolhas de chamado e confirmações de rascunho não chamam. O painel mostra os tokens e o tempo de cada resposta.
- **Modelos reserva:** `NEXO_MODEL` aceita uma lista separada por vírgulas; se o primeiro estiver sobrecarregado, o Mastra tenta o seguinte.
- **Alternativa local e gratuita:** `NEXO_MODEL=ollama/qwen2.5:3b` usa um modelo aberto no [Ollama](https://ollama.com), sem chave e sem enviar dados a terceiros. Em CPU ele leva de 15 a 40 s por chamada, então nesse modo o modelo só é chamado quando as regras não entendem a mensagem com segurança (use `LLM_TIMEOUT_MS=45000`). Não funciona na Vercel.

### Como garanti a qualidade das decisões

- **Motor puro e testado:** o mesmo motor roda com interpretações reais ou simuladas, então os testes cobrem as regras do Anexo A e o comportamento com o modelo (categoria vinda do modelo, confiança baixa, campo inventado pelo modelo, privacidade mesmo que o modelo aponte para o chamado de outra pessoa, dúvida sem artigo não vira resposta inventada).
- **Saída do modelo validada:** schema zod com enums fechados (intenção, categoria, artigo); números de chamado inventados são descartados; a confiança é limitada a 0–1.
- **Prompt com fronteiras e exemplos:** a mensagem do colaborador vai delimitada e marcada como dado, não instrução; as instruções trazem exemplos dos casos difíceis.
- **API testada sem servidor:** os testes chamam o app Hono direto (o mesmo da função da Vercel): login, sessão, privacidade, permissões, revisão do estado, gravações simultâneas.
- **Transparência:** cada resposta registra entrada, origem (modelo ou regras), entendimento, ação, confiança e motivos.

### Regras do service desk (Anexo A)

| Regra | Como o agent aplica |
| --- | --- |
| Tipo | Pedido de acesso, equipamento ou software → requisição (`REQ`); algo que parou ou não funciona → incidente (`INC`) |
| Categorias | Acesso, Rede e VPN, Hardware, Software, E-mail e Outros |
| Prioridade | Incidente que para a equipe ou a empresa → crítica; compromisso em risco (reunião, cliente, hoje…) → alta; pedido sem urgência → baixa; senão média |
| Prazo (primeira resposta e cada atualização) | crítica 1 h · alta 4 h úteis · média 3 dias úteis · baixa 5 dias úteis (expediente: seg–sex, 8h–18h) |
| Abertura | Rascunho com título, descrição, tipo, categoria, prioridade e afetados; só cria depois da confirmação |
| Sem duplicidade | Chamado aberto sobre o mesmo problema é complementado (com confirmação); resolvido há até 7 dias pode ser reaberto |
| Transferência | Quando o colaborador pede, em chamado crítico (automática), em chamado vencido (oferecida, como no protótipo) e quando o agent não tem segurança. Leva um resumo do caso para o analista |
| Privacidade | A API só entrega a cada colaborador as próprias conversas e chamados; o modelo só recebe os chamados de quem está falando |
| Escopo | RH, financeiro e facilities são redirecionados, sem abrir chamado |
| Limite por conversa | 30 mensagens (validado também no servidor) |

### Sistema de chamados instável

O serviço de chamados (`server/tickets.ts`) simula o sistema legado: cada chamada leva de 150 a 450 ms e 8% delas falham. O runtime tenta até 3 vezes, com espera crescente, e mostra "Tentando de novo (2/3)…". Se as 3 falharem, o agent avisa que nada foi alterado e oferece **Tentar de novo**. Para ver esse fluxo, use `LEGACY_FAILURE_RATE=0.5` no `.env`.

### Segurança e privacidade

- A chave do modelo fica só no servidor (`.env` local, fora do git, ou variáveis de ambiente da Vercel); o navegador nunca a vê.
- Toda rota exige sessão; o colaborador só acessa as próprias conversas, e as ações de analista exigem o perfil de analista.
- Entradas validadas com zod e com tamanho limitado.

## Trade-offs

- **Interpretação por modelo + ação por regras**, em vez de um agent com ferramentas de escrita: menos "autonomia", mas decisões previsíveis, auditáveis e baratas (uma chamada por mensagem). As regras do Anexo A ficam testáveis sem o modelo.
- **Contexto na chamada em vez de ferramentas de leitura:** os chamados de um colaborador e a central de ajuda são pequenos; mandar tudo de uma vez evita idas e voltas ao modelo.
- **Consulta periódica em vez de conexão aberta (SSE/WebSocket):** funciona nas funções da Vercel, que não mantêm conexão; o navegador só baixa o estado quando a revisão muda (resposta 204 quando nada mudou). Em escala, mandaria só o que mudou.
- **Um documento só no banco:** simples e suficiente para o tamanho do desafio, com compare-and-set para gravações simultâneas. Com muitos usuários, separaria conversas e chamados em chaves ou tabelas próprias.
- **Senha qualquer:** como pede o PRD para os dados de exemplo; sessões são tokens aleatórios guardados no banco.

## O que faria com mais tempo

- Avaliações (evals) com um conjunto de mensagens reais rotuladas, medindo a acurácia de intenção, categoria e prioridade a cada mudança de prompt.
- Respostas da central de ajuda geradas pelo modelo a partir dos artigos (hoje o texto é o do artigo, para não inventar nada).
- Memória do Mastra para conversas longas e streaming da resposta.
- Limite de requisições por IP no deploy.
