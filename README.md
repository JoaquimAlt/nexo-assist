# Nexo Assist — Service desk de TI

Front-end em React + TypeScript (Vite) do service desk de TI da Nexo. Ele segue os protótipos de login, atendimento com o assistente, perfil e console do analista.

O colaborador conversa com o **Nexo Assist**, que consulta chamados, busca na central de ajuda, monta e abre chamados, e transfere para um analista. O analista acompanha tudo no **console**: assume a conversa, responde, devolve ao agent ou encerra.

## Como rodar

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # testes do motor do assistente
npm run build    # checagem de tipos + build de produção
```

Requer Node 18 ou superior.

### Contas de demonstração

| Perfil        | E-mail                     | Senha      |
| ------------- | -------------------------- | ---------- |
| Colaboradora  | `ana.souza@nexo.com.br`    | `nexo2026` |
| Analista N2   | `rafael.lima@nexo.com.br`  | `nexo2026` |

A tela de login tem atalhos que preenchem essas contas.

### Ver o fluxo completo (duas abas)

1. Na aba 1, entre como **Ana** com "Manter conectado" **desmarcado**.
2. Pergunte *"Qual o status do meu chamado?"*, escolha o INC-20311 e clique em **Falar com um analista**.
3. Na aba 2, entre como **Rafael**. A conversa da Ana aparece em "Para você", com o status *Aguardando atendente*.
4. Clique em **Assumir atendimento** e responda. A mensagem chega na aba da Ana em tempo real, e o indicador de digitação aparece nos dois sentidos.
5. Teste também **Devolver ao agent** e **Encerrar atendimento**.

Outro roteiro, para abrir um chamado: *"Meu notebook não conecta na VPN desde ontem. Aparece o erro 809."*, e depois *"Só eu. Tenho reunião com um cliente às 14h"*. O assistente monta o rascunho, que você pode editar, cancelar ou confirmar (também com Ctrl/⌘ + Enter).

Para voltar ao estado inicial, use o menu do avatar no console: **Restaurar dados de demonstração**.

## O que foi implementado

**Login**
- Validação de e-mail corporativo (`@nexo.com.br`), erro de credencial e opção de mostrar/ocultar a senha.
- "Manter conectado" e fluxo de "Esqueci minha senha".
- Rotas protegidas por perfil: colaborador vai para `/atendimento` e analista para `/console`.

**Atendimento (colaborador)**
- Ferramentas usadas pelo assistente aparecem uma a uma enquanto ele "pensa".
- Escolha de chamado em lista e cartão do chamado com prazo calculado (SLA em dias úteis).
- Respostas rápidas, rascunho de chamado editável e confirmação.
- Fila de espera com prazo, mensagens do analista e eventos da conversa ("Rafael Lima entrou na conversa").
- Limite de 30 mensagens por sessão e "Nova conversa".

**Meu perfil**
- Dados da conta e redefinição de senha com espera de 60 s para reenviar.

**Console (analista)**
- Lista ordenada por urgência, com filtros *Todas / Para você / Com o agent / Minhas* e busca por nome, chamado ou texto.
- Contador de não lidas, prévia da última mensagem e "digitando…".
- Ações: assumir, devolver ao agent, encerrar, marcar como não lida e busca dentro da conversa.
- Painel com os chamados do colaborador: chamado desta conversa, outros chamados expansíveis e modal com todos.
- Disponibilidade (Disponível/Ausente).

**Responsivo**
- Layout adaptado até 390px, sem rolagem horizontal.

## Arquitetura

```
src/
  agent/
    engine.ts        motor do assistente (função pura: entrada + contexto → resposta + efeitos)
    engine.test.ts   testes do motor (Vitest)
    runtime.ts       aplica a resposta ao "backend": atraso, ferramentas, efeitos
  services/
    tickets.ts       serviço de chamados simulado (sistema legado: latência, falhas, dono do chamado)
  store/
    store.ts         "backend" simulado em localStorage, sincronizado entre abas
    auth.ts          sessão por aba (sessionStorage) + "manter conectado"
    consoleActions.ts ações do analista
    selectors.ts     consultas derivadas (não lidas, conversa ativa…)
  data/              tipos, rótulos e dados de demonstração (datas relativas a hoje)
  lib/               datas, SLA, utilitários
  components/        UI compartilhada (avatar, status, menu, cartão de chamado)
  pages/             login, área do colaborador e console
  styles/            CSS com tokens (sem framework)
```

### Decisões

- **Sem backend real.** O desafio é de front-end, então o "servidor" é um documento no `localStorage`. O evento `storage` propaga mudanças entre abas, e por isso colaborador e analista conversam ao vivo em duas abas. Trocar por uma API é trocar `updateDB`/`useDB` por chamadas HTTP/WebSocket; as telas não mudam.
- **Assistente determinístico.** O motor (`agent/engine.ts`) é baseado em regras e é uma função pura. Ele devolve *efeitos* (`handoff`, `create-ticket`, `add-note`…) em vez de alterar estado, o que deixa a lógica testável e permite trocar por um LLM com *tool use* mantendo o mesmo contrato.
- **Sessão por aba.** A sessão fica no `sessionStorage`, para que Ana e Rafael possam ficar logados lado a lado. "Manter conectado" grava também no `localStorage`.
- **Dados com datas relativas.** O cenário dos protótipos (chamado parado há 5 dias úteis, conversas de hoje e de ontem) se mantém em qualquer dia em que o projeto for aberto.

### Regras do service desk (Anexo A)

| Regra | Como o agent aplica |
| --- | --- |
| Tipo | Pedido de acesso, equipamento ou software → requisição (`REQ`); algo que parou ou não funciona → incidente (`INC`) |
| Categorias | Acesso, Rede e VPN, Hardware, Software, E-mail e Outros |
| Prioridade | Incidente que para a equipe ou a empresa → crítica; compromisso em risco (reunião, cliente, hoje…) → alta; pedido sem urgência → baixa; senão média |
| Prazo (primeira resposta e cada atualização) | crítica 1 h · alta 4 h úteis · média 3 dias úteis · baixa 5 dias úteis (expediente: seg–sex, 8h–18h) |
| Abertura | Rascunho com título, descrição, tipo, categoria, prioridade e afetados; só cria depois da confirmação |
| Sem duplicidade | Chamado aberto sobre o mesmo problema é complementado; resolvido há até 7 dias pode ser reaberto |
| Transferência | Quando o colaborador pede, em chamado crítico (automática), em chamado vencido (oferecida) e quando o agent não entende duas vezes seguidas (status "Agent pediu ajuda"). Leva um resumo do caso para o analista |
| Privacidade | O serviço de chamados só devolve e altera chamados de quem os abriu |
| Escopo | RH, financeiro e facilities são redirecionados, sem abrir chamado |
| Retorno após transferência | 2 h úteis |
| Limite por conversa | 30 mensagens |

### Sistema de chamados instável

O serviço de chamados (`src/services/tickets.ts`) simula o sistema legado: cada chamada leva de 150 a 450 ms e 8% delas falham. O runtime tenta até 3 vezes, com espera crescente, e mostra "Tentando de novo (2/3)…" enquanto isso. Se as 3 falharem, o agent avisa que nada foi alterado e oferece **Tentar de novo**. Abra o app com `?instavel` na URL (por exemplo `http://localhost:5173/atendimento?instavel`) para 50% de falhas e ver esse fluxo.
