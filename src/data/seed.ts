import type { Conversation, DB, EventIcon, Message, Ticket, User } from './types.js';
import { ddmm, dueLabel, subBusinessDays } from '../lib/time.js';
import { slaDeadline } from '../lib/sla.js';

/** Incrementar quando o formato do banco mudar: dados antigos são descartados. */
export const SEED_VERSION = 2;

/**
 * Dados de demonstração. Todas as datas são relativas a `now`, então o
 * cenário dos protótipos (chamado parado há 5 dias, conversas de hoje e de
 * ontem) se mantém em qualquer dia.
 */
export function createSeed(now = new Date()): DB {
  const iso = (d: Date) => d.toISOString();
  const ago = (min: number) => iso(new Date(now.getTime() - min * 60_000));
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const at = (base: Date, h: number, m: number) => {
    const d = new Date(base);
    d.setHours(h, m, 0, 0);
    return iso(d);
  };

  const users: User[] = [
    { id: 'u-ana', name: 'Ana Souza', email: 'ana.souza@nexo.com.br', role: 'colaborador', department: 'Financeiro', os: 'Windows 11', color: 0, online: true, passwordChangedAt: iso(daysAgo(42)) },
    { id: 'u-rafael', name: 'Rafael Lima', email: 'rafael.lima@nexo.com.br', role: 'analista', department: 'TI', team: 'Suporte N2', color: 3, online: true, passwordChangedAt: iso(daysAgo(18)) },
    { id: 'u-carla', name: 'Carla Mendes', email: 'carla.mendes@nexo.com.br', role: 'colaborador', department: 'Controladoria', os: 'Windows 11', color: 1, online: true, passwordChangedAt: iso(daysAgo(10)) },
    { id: 'u-bruno', name: 'Bruno Tavares', email: 'bruno.tavares@nexo.com.br', role: 'colaborador', department: 'Comercial', os: 'Windows 11', color: 2, online: false, passwordChangedAt: iso(daysAgo(70)) },
    { id: 'u-diego', name: 'Diego Ramos', email: 'diego.ramos@nexo.com.br', role: 'colaborador', department: 'Marketing', os: 'macOS', color: 3, online: true, passwordChangedAt: iso(daysAgo(5)) },
    { id: 'u-elisa', name: 'Elisa Prado', email: 'elisa.prado@nexo.com.br', role: 'colaborador', department: 'Pessoas', os: 'Windows 11', color: 4, online: false, passwordChangedAt: iso(daysAgo(33)) },
    { id: 'u-fabio', name: 'Fábio Nunes', email: 'fabio.nunes@nexo.com.br', role: 'colaborador', department: 'Jurídico', os: 'Windows 10', color: 5, online: false, passwordChangedAt: iso(daysAgo(90)) },
    { id: 'u-gabriela', name: 'Gabriela Rocha', email: 'gabriela.rocha@nexo.com.br', role: 'colaborador', department: 'Operações', os: 'Windows 11', color: 6, online: false, passwordChangedAt: iso(daysAgo(21)) },
  ];

  const stale = subBusinessDays(now, 5);
  const staleOpened = at(stale, 14, 20);
  const elisaOpened = new Date(now.getTime() - 2 * 60_000);

  const tickets: Ticket[] = [
    {
      id: 'INC-20311',
      title: 'Notebook lento após atualização do Windows',
      shortTitle: 'Notebook lento após atualização',
      description: `Lentidão geral desde a atualização de ${ddmm(new Date(stale.getTime() - 86_400_000))}. Reiniciar e rodar o diagnóstico da central não resolveu.`,
      category: 'Hardware',
      priority: 'media',
      status: 'aguardando_analista',
      requesterId: 'u-ana',
      openedAt: staleOpened,
      updatedAt: staleOpened,
      notes: [],
    },
    {
      id: 'INC-20298',
      title: 'Acesso à pasta Financeiro no SharePoint',
      shortTitle: 'Acesso à pasta Financeiro',
      description: 'Preciso de permissão de edição na pasta Financeiro/Fechamento para o fechamento do mês.',
      category: 'Acesso',
      priority: 'media',
      status: 'em_andamento',
      requesterId: 'u-ana',
      openedAt: at(subBusinessDays(now, 7), 9, 12),
      updatedAt: at(subBusinessDays(now, 1), 16, 40),
      assignee: 'Marina Costa',
      notes: [],
    },
    {
      id: 'REQ-10442',
      title: 'Segundo monitor para home office',
      description: 'Monitor adicional de 24" para trabalho remoto, aprovado pela gestora.',
      category: 'Hardware',
      priority: 'baixa',
      status: 'aprovado',
      requesterId: 'u-ana',
      openedAt: at(subBusinessDays(now, 12), 11, 5),
      updatedAt: at(subBusinessDays(now, 2), 10, 0),
      notes: [],
    },
    {
      id: 'INC-20150',
      title: 'Senha do SAP bloqueada',
      description: 'Conta do SAP bloqueada depois de várias tentativas de login.',
      category: 'Acesso',
      priority: 'media',
      status: 'resolvido',
      requesterId: 'u-ana',
      openedAt: at(daysAgo(5), 9, 10),
      updatedAt: at(daysAgo(4), 11, 30),
      resolvedAt: at(daysAgo(4), 11, 30),
      assignee: 'Rafael Lima',
      notes: [],
    },
    {
      id: 'INC-19877',
      title: 'Outlook não sincroniza no celular',
      description: 'E-mails corporativos pararam de chegar no aplicativo do Outlook no celular.',
      category: 'E-mail',
      priority: 'media',
      status: 'resolvido',
      requesterId: 'u-ana',
      openedAt: at(daysAgo(56), 10, 30),
      updatedAt: at(daysAgo(54), 15, 0),
      resolvedAt: at(daysAgo(54), 15, 0),
      assignee: 'Rafael Lima',
      notes: [],
    },
    {
      id: 'INC-19410',
      title: 'Troca de senha da rede',
      description: 'Senha da rede expirou durante as férias.',
      category: 'Acesso',
      priority: 'alta',
      status: 'resolvido',
      requesterId: 'u-ana',
      openedAt: at(daysAgo(108), 8, 50),
      updatedAt: at(daysAgo(107), 9, 20),
      resolvedAt: at(daysAgo(107), 9, 20),
      notes: [],
    },
    {
      id: 'INC-20502',
      title: 'Painel de vendas do Power BI não atualiza',
      description: 'O painel de vendas não atualiza desde segunda-feira.',
      category: 'Software',
      priority: 'alta',
      status: 'aguardando_analista',
      requesterId: 'u-bruno',
      openedAt: ago(16),
      updatedAt: ago(16),
      notes: [],
    },
    {
      id: 'INC-20519',
      title: 'Impressora do 3º andar não imprime',
      description: 'A impressora do 3º andar não imprime nada. Reinstalar pela central não resolveu.',
      category: 'Hardware',
      priority: 'media',
      status: 'aguardando_analista',
      requesterId: 'u-elisa',
      openedAt: iso(elisaOpened),
      updatedAt: iso(elisaOpened),
      notes: [],
    },
  ];

  let n = 0;
  const mk = (author: Message['author'], at: string, rest: Partial<Message>): Message => ({ id: `seed-${n++}`, at, author, ...rest });
  const say = (min: number, text: string) => mk('contact', ago(min), { text });
  const bot = (min: number, text: string, tools?: string[]) => mk('assistant', ago(min), { blocks: [{ type: 'text', text }], tools });
  const ev = (min: number, icon: EventIcon, text: string, contactText?: string) => mk('event', ago(min), { text, event: { icon, contactText } });

  const conv = (c: Omit<Conversation, 'agent'>): Conversation => ({ agent: {}, ...c });
  const elisaDeadline = dueLabel(slaDeadline('media', elisaOpened), now);

  const conversations: Conversation[] = [
    conv({
      id: 'c-carla',
      contactId: 'u-carla',
      status: 'waiting',
      createdAt: ago(15),
      queue: 'Suporte N2',
      waitingSince: ago(12.5),
      waitingDeadline: iso(new Date(now.getTime() + 25 * 60_000)),
      lastReadAt: ago(10),
      handoff: {
        reason: 'A colaboradora pediu para falar com um analista.',
        report: 'Acesso ao SAP expirou e ela não consegue lançar as notas.',
        tried: ['consultou seus acessos'],
      },
      messages: [
        say(15, 'Oi, meu acesso ao SAP expirou e não consigo lançar as notas.'),
        bot(14.5, 'Acessos ao SAP são liberados pelo Suporte N2 depois da aprovação da sua gestora. Quer que eu chame um analista?', ['consultou seus acessos']),
        say(13, 'Quero, por favor.'),
        bot(12.5, 'Encaminhei para o Suporte N2. Um analista vai falar com você em até 2 h úteis.'),
        ev(12.5, 'transfer', 'Transferida para Suporte N2', 'Transferida para o Suporte N2'),
        say(9, 'Preciso de acesso ao SAP ainda hoje'),
      ],
    }),
    conv({
      id: 'c-bruno',
      contactId: 'u-bruno',
      status: 'help',
      createdAt: ago(18),
      ticketId: 'INC-20502',
      queue: 'Suporte N2',
      confidence: 0.41,
      waitingSince: ago(16),
      waitingDeadline: iso(new Date(now.getTime() + 104 * 60_000)),
      lastReadAt: ago(15),
      handoff: {
        reason: 'O agent não teve segurança para decidir (confiança 41%): dois artigos indicam soluções diferentes.',
        ticket: 'INC-20502 · Painel de vendas do Power BI não atualiza · Aguardando analista',
        report: 'O painel de vendas do Power BI não atualiza desde segunda.',
        tried: ['consultou seus chamados', 'buscou na central de ajuda'],
      },
      messages: [
        say(18, 'O painel de vendas do Power BI não atualiza desde segunda.'),
        bot(17, 'Encontrei dois artigos que podem explicar isso, mas eles indicam soluções diferentes para o seu caso.', ['consultou seus chamados', 'buscou na central de ajuda']),
        say(16.5, 'E qual eu sigo?'),
        bot(16, 'Vou chamar um analista para isso.'),
        ev(16, 'alert', 'Agent pediu ajuda · confiança 41%', 'Chamamos um analista para ajudar'),
      ],
    }),
    conv({
      id: 'c-diego',
      contactId: 'u-diego',
      status: 'agent',
      createdAt: ago(3),
      contactTypingUntil: now.getTime() + 6 * 3_600_000,
      messages: [
        say(3, 'Como instalo o Figma no notebook?'),
        bot(2.5, 'O Figma está no Portal da Empresa › Software. Clique em Instalar e aguarde uns 5 minutos.', ['buscou na central de ajuda']),
      ],
    }),
    conv({
      id: 'c-elisa',
      contactId: 'u-elisa',
      status: 'agent',
      createdAt: ago(6),
      ticketId: 'INC-20519',
      messages: [
        say(6, 'A impressora do 3º andar não imprime nada.'),
        bot(5.5, 'Encontrei na central de ajuda “Impressora não imprime”: remova a impressora em Configurações › Impressoras e adicione de novo pelo endereço \\\\print.nexo.local.', ['consultou seus chamados', 'buscou na central de ajuda']),
        say(4, 'Não resolveu.'),
        bot(2, `Chamado INC-20519 criado. Um analista responde até ${elisaDeadline}.`, ['criou o chamado']),
      ],
    }),
    conv({
      id: 'c-fabio',
      contactId: 'u-fabio',
      status: 'resolved',
      createdAt: ago(9),
      messages: [
        say(9, 'O Teams fecha sozinho quando entro numa reunião.'),
        bot(8, 'Tente limpar o cache: feche o Teams, apague a pasta %appdata%\\Microsoft\\Teams e abra de novo.', ['buscou na central de ajuda']),
        say(4, 'Isso resolveu, obrigado!'),
      ],
    }),
    conv({
      id: 'c-gabriela',
      contactId: 'u-gabriela',
      status: 'resolved',
      createdAt: at(daysAgo(1), 16, 38),
      messages: [
        mk('contact', at(daysAgo(1), 16, 38), { text: 'Qual a senha do Wi-Fi de visitantes?' }),
        mk('assistant', at(daysAgo(1), 16, 39), {
          blocks: [{ type: 'text', text: 'A senha do Wi-Fi foi enviada para o seu e-mail corporativo. Ela muda toda segunda-feira.' }],
          tools: ['consultou a central de ajuda'],
        }),
      ],
    }),
  ];

  return {
    version: SEED_VERSION,
    users,
    tickets,
    conversations,
    seq: { inc: 20520, req: 10443, draft: 381 },
    analystAvailable: true,
  };
}
