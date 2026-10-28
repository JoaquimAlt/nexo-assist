# Nexo Assist — Service desk de TI

O colaborador conversa com o **Nexo Assist**, um agent que entende o pedido com um modelo de linguagem local e gratuito (Qwen 2.5 no Ollama, via Mastra), consulta os chamados dele, busca na central de ajuda, monta e abre chamados com confirmação e transfere para um analista quando precisa. O analista acompanha tudo no **console**: assume a conversa (com o agent pausado), responde, devolve ao agent ou encerra.

Cada resposta do agent tem um painel **"Como decidi"**, com o que ele entendeu, a ação que tomou, o grau de confiança, os motivos e quem interpretou a mensagem: o modelo, com tokens e tempo, ou as regras.

## Como rodar

1. Instale o [Ollama](https://ollama.com) (no Windows: `winget install Ollama.Ollama`) e baixe o modelo, cerca de 2 GB, uma vez só:
   ```bash
   ollama pull qwen2.5:3b
   ```
2. Rode o projeto:
   ```bash
   npm install
   cp .env.example .env
   npm run dev            # API em :8787 + front em http://localhost:5173
   ```

Ao subir, a API diz no terminal se encontrou o Ollama e o modelo, e o que falta se não encontrou.

| Comando | O que faz |
| --- | --- |
| `npm run dev` | Sobe a API (`node --watch`) e o Vite juntos; o Vite repassa `/api` para a API |
| `npm test` | Testes do motor, das regras de prazo, do serviço de chamados e da integração com o modelo |
| `npm run build` | Checagem de tipos do front e do servidor + build do front |
| `npm start` | Produção: um único servidor entrega o front (`dist/`) e a API |

Requer Node 22 ou superior. **Sem o Ollama o projeto funciona do mesmo jeito**: o agent usa só as regras, e o painel "Como decidi" avisa isso.

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
3. **Assuma** e responda: a mensagem chega na aba da Ana ao vivo. Enquanto o analista atende, o agent não responde. Teste **Devolver ao agent** e **Encerrar**.

**Outras regras:** *"Minha senha do SAP bloqueou de novo"* (oferece reabrir o INC-20150, resolvido há 4 dias) · *"Quando caem minhas férias?"* (fora de escopo → RH) · relate um problema e responda **Minha equipe** (prioridade crítica: ao confirmar, o agent cria o chamado e já transfere) · *"Preciso de uma licença do Adobe Acrobat"* (requisição REQ, prioridade baixa).

Para voltar ao estado inicial: menu do avatar no console › **Restaurar dados de demonstração**.

## Arquitetura

```
server/                  API Node (Hono) — tudo que tem chave, dado ou regra de acesso fica aqui
  index.ts               rotas HTTP, eventos ao vivo (SSE), validação de entrada (zod), permissões
  auth.ts                login, sessões e a visão filtrada por usuário (privacidade)
  db.ts                  banco em arquivo JSON (server/data/db.json): sobrevive a reinícios
  llm.ts                 agent Mastra + Ollama: interpreta a mensagem em formato estruturado
  runtime.ts             orquestra um turno: chamados → modelo → motor → efeitos no sistema legado
  tickets.ts             serviço de chamados simulado (legado: latência, falhas, dono do chamado)
  console.ts             ações do analista
src/
  agent/engine.ts        motor de regras (função pura): interpretação + contexto → resposta + efeitos + decisão
  data/                  tipos, rótulos, central de ajuda (kb.ts) e dados de demonstração
  lib/                   prazos (sla.ts), datas e limites
  api/                   cliente HTTP e ações da interface
  store/                 cópia local do estado, atualizada pelos eventos do servidor
  components/, pages/    interface (login, chat do colaborador, console do analista)
```

Um turno do agent, para uma mensagem de texto:

1. **Registra** a mensagem e mostra "digitando" (`runtime.ts`).
2. **Consulta os chamados** do colaborador no serviço legado, com até 3 tentativas.
3. **Interpreta** com o modelo (`llm.ts`): intenção, categoria, tipo, afetados, urgência, código de erro, artigo da central, confiança e motivos, validados por um schema zod.
4. **Decide** com o motor de regras (`engine.ts`), que aplica o Anexo A sobre essa interpretação e devolve a resposta, os *efeitos* (`create-ticket`, `add-note`, `reopen`, `handoff`…) e a decisão explicada.
5. **Aplica** os efeitos no serviço de chamados; se ele falhar, avisa que nada foi alterado e oferece **Tentar de novo**.
6. **Publica** a resposta; os navegadores recebem um evento e atualizam.

### Como o agent decide

O modelo **interpreta**; as regras **agem**. A divisão é proposital:

- **O modelo** resolve o que regras não resolvem bem: linguagem livre ("aquele quadro branco online", "ninguém aqui consegue trabalhar"), intenção implícita, dados espalhados na frase. Ele recebe só o necessário: quem é a pessoa, **apenas os chamados dela**, os títulos da central de ajuda, o estado da conversa e as últimas mensagens.
- **As regras** cuidam do que precisa ser exato e auditável: prazos em horas e dias úteis, prioridade pelo impacto e pela urgência, duplicidade e reabertura em até 7 dias, transferência, privacidade e **nenhuma criação ou alteração sem confirmação**. Nada que o modelo devolva cria ou altera um chamado sozinho.
- **Confiança:** abaixo de 50%, o agent não age e pede para reformular; na segunda vez seguida, transfere para um analista com o status "Agent pediu ajuda".
- **Fallback:** com o Ollama desligado, o modelo não baixado, sem resposta dentro do tempo limite ou com o limite diário atingido, o motor segue com as regras de palavras-chave, e o painel diz o motivo.

### Escolha do modelo

**Qwen 2.5 3B** (`ollama/qwen2.5:3b`), rodando localmente no [Ollama](https://ollama.com), conectado ao Mastra pela API compatível com OpenAI:

- **Custo zero e offline:** roda na máquina, sem chave, sem cota e sem enviar as conversas a terceiros, o que também é bom para a privacidade dos chamados.
- A tarefa é **classificação estruturada**, não geração longa: um modelo pequeno resolve, e o Ollama restringe a saída ao schema JSON, validado de novo com zod.
- É bom em português e roda em CPU, sem placa de vídeo, em alguns segundos por mensagem. O tempo limite padrão é 45 s.
- **Uso consciente do modelo:** só **mensagens de texto** chamam o modelo, uma vez cada (sem loop de ferramentas: o contexto já vai na chamada). Botões, escolhas de chamado e confirmações de rascunho não chamam. O painel mostra os tokens e o tempo de cada resposta.
- **Trocar de modelo** é mudar `NEXO_MODEL` no `.env`: outro modelo do Ollama (`ollama/qwen2.5:7b`, `ollama/llama3.2:3b`), um provedor na nuvem pelo model router do Mastra (`google/gemini-3.8-flash` com `GOOGLE_API_KEY`) ou `off` para usar só as regras.

### Como garanti a qualidade das decisões

- **Motor puro e testado:** o mesmo motor roda com interpretações reais ou simuladas, então os testes cobrem as regras do Anexo A e o comportamento com o modelo (categoria vinda do modelo, confiança baixa, privacidade mesmo que o modelo aponte para o chamado de outra pessoa, dúvida sem artigo não vira resposta inventada).
- **Saída do modelo validada:** schema zod com enums fechados (intenção, categoria, artigo); números de chamado inventados são descartados; a confiança é limitada a 0–1.
- **Prompt com fronteiras:** a mensagem do colaborador vai delimitada e marcada como dado, não instrução.
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

- O modelo roda localmente: as conversas não saem da máquina. Se for usado um provedor na nuvem, a chave fica só no servidor (`.env`, fora do git) e o navegador nunca a vê.
- Toda rota exige sessão; o colaborador só acessa as próprias conversas, e as ações de analista exigem o perfil de analista.
- Entradas validadas com zod e com tamanho limitado.

## Trade-offs

- **Interpretação por modelo + ação por regras**, em vez de um agent com ferramentas de escrita: menos "autonomia", mas decisões previsíveis, auditáveis e baratas (uma chamada por mensagem). As regras do Anexo A ficam testáveis sem o modelo.
- **Modelo local pequeno em vez de um modelo grande na nuvem:** custo zero, sem cota e sem dados saindo da máquina; em troca, mais lento em CPU e menos preciso em frases ambíguas. A confiança baixa e o fallback para as regras cobrem esses casos, e um modelo maior é uma linha no `.env`.
- **Contexto na chamada em vez de ferramentas de leitura:** os chamados de um colaborador e a central de ajuda são pequenos; mandar tudo de uma vez evita idas e voltas ao modelo.
- **Banco em arquivo JSON:** zero instalação e sobrevive a reinícios; não serve para várias instâncias. Trocar por SQLite/Postgres mexe só em `server/db.ts`.
- **Atualização por SSE + nova busca do estado:** simples e robusto para o tamanho do desafio; em escala, mandaria só o que mudou.
- **Senha qualquer:** como pede o PRD para os dados de exemplo; sessões são tokens aleatórios guardados no servidor.

## O que faria com mais tempo

- Avaliações (evals) com um conjunto de mensagens reais rotuladas, medindo a acurácia de intenção, categoria e prioridade a cada mudança de prompt.
- Respostas da central de ajuda geradas pelo modelo a partir dos artigos (hoje o texto é o do artigo, para não inventar nada).
- Memória do Mastra para conversas longas e streaming da resposta.
- Deploy com limite de requisições por IP e banco gerenciado.
