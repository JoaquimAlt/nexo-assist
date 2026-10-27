import type {
  Affected, AgentContext, AgentInput, Block, Choice, Conversation, Decision, DecisionFact, HandoffSummary, Priority, ProblemInfo, Ticket, TicketDraft, TicketKind, User,
} from '../data/types';
import { AFFECTED, PRIORITY, TICKET_KIND, TICKET_STATUS } from '../data/labels';
import { HANDOFF_HOURS, REOPEN_DAYS, SLA, canReopen, isOverdue, slaDeadline } from '../lib/sla';
import { calendarDaysBetween, dayMonth, ddmm, dueLabel, hhmm, hourLabel, relDays } from '../lib/time';

/**
 * Motor do Nexo Assist. Função pura: recebe a entrada do colaborador e o
 * contexto, devolve as ferramentas usadas, os blocos da resposta, os
 * efeitos a aplicar (transferir, criar chamado...) e a decisão que explica
 * a resposta. Quem aplica os efeitos é o runtime.
 */

export type { AgentInput };

export type AgentEffect =
  | { type: 'handoff'; ticketId?: string; summary: HandoffSummary; /** Presente quando o agent transfere por falta de segurança. */ lowConfidence?: number; dueAt?: string }
  | { type: 'create-ticket'; messageId: string; ticketId: string }
  | { type: 'cancel-draft'; messageId: string }
  | { type: 'add-note'; ticketId: string; text: string }
  | { type: 'reopen'; ticketId: string; text: string }
  | { type: 'mark-choice'; value: string }
  | { type: 'resolve' };

export interface AgentEnv {
  user: User;
  /** Chamados do colaborador. */
  tickets: Ticket[];
  conversation: Conversation;
  now: Date;
  /** Próximo número livre de cada tipo de chamado. */
  nextIds: Record<TicketKind, string>;
  nextDraftId: string;
}

export interface AgentReply {
  tools: string[];
  blocks: Block[];
  effects: AgentEffect[];
  context: AgentContext;
  decision: Decision;
}

/** Decisão sem o gatilho, que o runAgent preenche a partir da entrada. */
type Reasoning = Omit<Decision, 'trigger'>;
type Turn = Omit<AgentReply, 'decision'> & { decision: Reasoning };

export const QUEUE = 'Suporte N2';

/** Graus de segurança atribuídos pelas regras. */
export const CONFIDENCE = {
  /** Botão, chamado escolhido ou rascunho: não há o que interpretar. */
  explicit: 0.98,
  /** Pedido reconhecido por palavra-chave clara ("analista", "status"). */
  keyword: 0.9,
  /** Problema com assunto reconhecido. */
  topic: 0.8,
  /** Tratado como problema, mas sem assunto reconhecido. */
  vague: 0.55,
  /** Nenhuma regra se aplicou. */
  none: 0.2,
} as const;

/** Respostas seguidas sem entender o pedido antes de chamar um analista. */
export const MAX_MISSES = 2;

export const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

const firstName = (u: User) => u.name.split(' ')[0];

function reply(blocks: Block[], context: AgentContext, decision: Reasoning, extra: Partial<Pick<Turn, 'tools' | 'effects'>> = {}): Turn {
  return { tools: [], effects: [], ...extra, blocks, context, decision };
}

function decide(intent: string, action: string, confidence: number, reasons: (string | undefined)[], understood: (DecisionFact | undefined)[] = []): Reasoning {
  return {
    intent,
    action,
    confidence,
    reasons: reasons.filter((r): r is string => !!r),
    understood: understood.filter((f): f is DecisionFact => !!f),
  };
}

const fact = (label: string, value: string | undefined): DecisionFact | undefined => (value ? { label, value } : undefined);

const text = (t: string, question?: string, choices?: Choice[]): Block => ({ type: 'text', text: t, question, choices });

const START: Choice[] = [
  { value: 'start:status', label: 'Ver meus chamados' },
  { value: 'start:problema', label: 'Relatar um problema' },
  { value: 'start:analista', label: 'Falar com um analista' },
];

const AFFECTED_CHOICES: Choice[] = [
  { value: 'aff:eu', label: 'Só eu' },
  { value: 'aff:equipe', label: 'Minha equipe' },
  { value: 'aff:empresa', label: 'Toda a empresa' },
  { value: 'aff:nao_sei', label: 'Não sei' },
];

// ---------------------------------------------------------------------------
// Classificação do problema

interface KbArticle {
  /** Como o artigo é citado: "do erro 809". */
  ref: string;
  title: string;
  steps: string[];
  /** Sistema operacional a que o artigo se aplica, quando é específico. */
  os?: string;
}

interface Topic {
  key: string;
  /** Como o assunto é citado: "Não há chamado aberto sobre VPN". */
  label: string;
  category: string;
  re: RegExp;
  title?: (n: string, code?: string) => string;
  kb?: (n: string, code?: string) => KbArticle | undefined;
}

const TOPICS: Topic[] = [
  {
    key: 'vpn',
    label: 'VPN',
    category: 'Rede e VPN',
    re: /\bvpn\b/,
    title: (n, code) => `VPN não conecta${/notebook|laptop/.test(n) ? ' no notebook' : ''}${code ? ` — erro ${code}` : ''}`,
    kb: (_n, code) =>
      code === '809'
        ? {
            ref: 'do erro 809',
            title: 'VPN: erro 809 no Windows 10',
            os: 'Windows 10',
            steps: ['Reinstale o cliente de VPN pelo Portal da Empresa › Software.', 'Reinicie o computador.'],
          }
        : code
          ? undefined
          : {
              ref: 'de VPN',
              title: 'VPN não conecta',
              steps: ['Confira se a internet funciona sem a VPN.', 'Feche o cliente da VPN e abra de novo.', 'Entre com o e-mail corporativo e a senha da rede.'],
            },
  },
  {
    key: 'impressao',
    label: 'impressão',
    category: 'Hardware',
    re: /impressora|imprimi|impressao/,
    title: () => 'Impressora não imprime',
    kb: () => ({
      ref: 'de impressão',
      title: 'Impressora não imprime',
      steps: ['Abra Configurações › Bluetooth e dispositivos › Impressoras.', 'Remova a impressora do seu andar.', 'Adicione de novo pelo endereço \\\\print.nexo.local.'],
    }),
  },
  {
    key: 'email',
    label: 'e-mail',
    category: 'E-mail',
    re: /outlook|e-?mail|caixa de entrada|\bteams\b/,
    title: (n) => (/\bteams\b/.test(n) ? 'Problema no Teams' : 'Problema no Outlook'),
  },
  {
    key: 'rede',
    label: 'rede',
    category: 'Rede e VPN',
    re: /wi-?fi|internet|\brede\b|sem conexao/,
    title: () => 'Sem conexão com a rede',
    kb: () => ({
      ref: 'de Wi-Fi',
      title: 'Sem conexão no Wi-Fi corporativo',
      steps: ['Esqueça a rede Nexo-Corp nas configurações de Wi-Fi.', 'Conecte de novo com o e-mail corporativo e a senha da rede.'],
    }),
  },
  { key: 'acesso', label: 'acesso', category: 'Acesso', re: /acesso|permiss|\bpasta\b|sharepoint|\bsap\b/ },
  {
    key: 'software',
    label: 'software',
    category: 'Software',
    re: /\binstal|software|programa\b|aplicativo|licenca|power ?bi|excel|figma|adobe|\bword\b/,
    kb: (n) =>
      /\binstal|baixar/.test(n)
        ? {
            ref: 'de instalação',
            title: 'Instalar programas pelo Portal da Empresa',
            steps: ['Abra o Portal da Empresa › Software.', 'Procure o programa e clique em Instalar.', 'Aguarde uns 5 minutos e reinicie se for pedido.'],
          }
        : undefined,
  },
  { key: 'perifericos', label: 'periféricos', category: 'Hardware', re: /monitor|mouse|teclado|headset|\bfone\b|webcam|\bdock\b/ },
  {
    key: 'notebook',
    label: 'o notebook',
    category: 'Hardware',
    re: /\blent|travand|\btrava|congel|notebook|computador|\bpc\b|tela azul|nao liga|bateria/,
    title: (n) => (/\blent|trav|congel/.test(n) ? 'Notebook lento' : 'Problema no notebook'),
  },
];

const OTHER: Topic = { key: 'outros', label: 'esse assunto', category: 'Outros', re: /$^/ };

export const detectTopic = (n: string) => TOPICS.find((t) => t.re.test(n)) ?? OTHER;
const topicByKey = (key: string) => TOPICS.find((t) => t.key === key) ?? OTHER;

const errorCode = (n: string) => n.match(/\berro\s*(?:n[o°]?\s*)?(\d{2,5})\b/)?.[1];

export function detectAffected(n: string): Affected | undefined {
  if (/\bnao sei\b/.test(n)) return 'nao_sei';
  if (/\b(so|somente|apenas) (eu|comigo|o meu|no meu)\b|^eu\b/.test(n)) return 'eu';
  if (/\b(equipe|time|setor|departamento|colegas)\b/.test(n)) return 'equipe';
  if (/\b(empresa|todo mundo|todos)\b/.test(n)) return 'empresa';
  return undefined;
}

const REQUEST_RE = /\b(preciso de|gostaria|queria|solicit|quero (um|uma|o|a|acesso|instalar)|pedido|instalar|instalacao|liberar|liberacao|permissao|licenca|novo|nova|segundo|adicional)/;
const FAILURE_RE = /\b(nao (funciona|conecta|abre|liga|imprime|sincroniza|carrega|atualiza|entra|consigo)|erro|parou|trava|lent|caiu|bloque|quebr|sem conexao|expirou|sumiu|fora do ar)/;

/** Pedido de algo novo é requisição; algo que parou ou não funciona é incidente. */
export const detectKind = (n: string): TicketKind => (REQUEST_RE.test(n) && !FAILURE_RE.test(n) ? 'requisicao' : 'incidente');

const URGENCY: { re: RegExp; reason: string }[] = [
  { re: /reuniao/, reason: 'por causa da reunião' },
  { re: /apresentacao/, reason: 'por causa da apresentação' },
  { re: /cliente/, reason: 'por causa do cliente' },
  { re: /urgente|urgencia/, reason: 'pela urgência' },
  { re: /\bhoje\b|prazo/, reason: 'pelo prazo de hoje' },
  { re: /(nao consigo|impossivel) trabalhar/, reason: 'porque seu trabalho está parado' },
];

/** Assuntos fora de TI e para onde encaminhar (Anexo A: escopo). */
const OUT_OF_SCOPE: { area: string; re: RegExp; where: string }[] = [
  {
    area: 'RH',
    re: /ferias|salario|holerite|contracheque|beneficio|plano de saude|vale[- ]?(refeicao|alimentacao|transporte)|banco de horas|folha de pagamento|\brh\b|recursos humanos|atestado/,
    where: 'o Portal de Pessoas ou o e-mail pessoas@nexo.com.br',
  },
  {
    area: 'Financeiro',
    re: /reembolso|nota fiscal|adiantamento|prestacao de contas|pagamento de fornecedor/,
    where: 'o Contas a Pagar, pelo e-mail financeiro@nexo.com.br',
  },
  {
    area: 'Facilities',
    re: /ar[- ]condicionado|limpeza|cadeira|\bmesa\b|estacionamento|cracha|lampada|\bcopa\b|manutencao predial/,
    where: 'Facilities, pelo ramal 4000',
  },
];

/** "reunião às 14h" → hoje, 14:00. */
function extractTime(n: string, now: Date) {
  const m = n.match(/\b(?:as|ate as|ate|antes das)\s+(\d{1,2})(?::(\d{2})|h(\d{2})?)/);
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2] ?? m[3] ?? 0);
  if (h > 23 || min > 59) return undefined;
  const d = new Date(now);
  d.setHours(h, min, 0, 0);
  return d > now ? d : undefined;
}

function sentence(s: string) {
  const t = s.trim().replace(/\s+/g, ' ');
  if (!t) return '';
  const cap = t[0].toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(cap) ? cap : `${cap}.`;
}

function titleFromText(raw: string) {
  const first = raw.split(/[.!?\n]/)[0].trim();
  const cut = first.length > 70 ? `${first.slice(0, 70).replace(/\s+\S*$/, '')}…` : first;
  return cut ? cut[0].toUpperCase() + cut.slice(1) : 'Novo chamado';
}

function describe(p: ProblemInfo, now: Date) {
  const yesterday = ddmm(new Date(now.getTime() - 86_400_000));
  const clean = (s: string) =>
    sentence(
      s
        .replace(/desde ontem/gi, `desde ${yesterday}`)
        .replace(/^(s[oó] eu|somente eu|apenas eu|minha equipe|toda a empresa|n[aã]o sei)[.,!]?\s*/i, ''),
    );
  return [p.text, p.extra]
    .filter((s): s is string => !!s)
    .map(clean)
    .filter(Boolean)
    .join(' ');
}

// ---------------------------------------------------------------------------
// Chamados parecidos

const STOP = new Set(['para', 'desde', 'esta', 'estou', 'minha', 'meus', 'minhas', 'apos', 'sobre', 'mais', 'muito', 'ainda', 'aqui', 'quando', 'porque', 'depois', 'continua', 'nada']);

/** Radicais (5 letras) das palavras relevantes. */
const stems = (n: string) => new Set(n.split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)).map((w) => w.slice(0, 5)));

const ticketText = (t: Ticket) => normalize(`${t.title} ${t.description}`);

/**
 * Chamado sobre o mesmo problema: do mesmo assunto, aberto ou resolvido há
 * até 7 dias. Entre vários, vence o que tem mais palavras em comum com a
 * mensagem; no empate, o aberto. Um resolvido só conta se tiver palavras em comum.
 */
function findRelated(n: string, topic: Topic, env: AgentEnv): Ticket | undefined {
  if (topic === OTHER) return undefined;
  const mine = stems(n);
  return env.tickets
    .filter((t) => (t.status !== 'resolvido' || canReopen(t, env.now)) && detectTopic(ticketText(t)).key === topic.key)
    .map((t) => ({ t, score: [...stems(ticketText(t))].filter((w) => mine.has(w)).length }))
    .filter(({ t, score }) => t.status !== 'resolvido' || score > 0)
    .sort((a, b) => b.score - a.score || Number(a.t.status === 'resolvido') - Number(b.t.status === 'resolvido'))[0]?.t;
}

// ---------------------------------------------------------------------------
// Transferência

const ticketLine = (t: Ticket, now: Date) => `${t.id} · ${t.title} · ${TICKET_STATUS[t.status].label}${isOverdue(t, now) ? ' · prazo vencido' : ''}`;

function summarize(env: AgentEnv, ctx: AgentContext, reason: string, ticketId?: string): HandoffSummary {
  const t = env.tickets.find((x) => x.id === ticketId);
  const msgs = env.conversation.messages;
  const buttons = new Set(msgs.flatMap((m) => m.blocks ?? []).flatMap((b) => (b.type === 'text' ? (b.choices ?? []).map((c) => c.label) : [])));
  const said = msgs.filter((m) => m.author === 'contact' && m.text && !buttons.has(m.text)).map((m) => m.text!);
  const report = ctx.problem ? [ctx.problem.text, ctx.problem.extra].filter(Boolean).join(' ') : said.slice(-3).join(' / ');
  return {
    reason,
    ticket: t ? ticketLine(t, env.now) : ticketId,
    report: report || undefined,
    tried: [...new Set(msgs.flatMap((m) => m.tools ?? []))],
  };
}

type HandoffMode = 'pedido' | 'inseguro';

function handoff(env: AgentEnv, ctx: AgentContext, confidence: number, why?: string, mode: HandoffMode = 'pedido'): Turn {
  const ticketId = ctx.focusTicketId ?? env.conversation.ticketId;
  const t = env.tickets.find((x) => x.id === ticketId);
  const overdue = !!t && isOverdue(t, env.now);
  const pct = Math.round(confidence * 100);

  const reason =
    mode === 'inseguro'
      ? `O agent não entendeu o pedido depois de ${MAX_MISSES} tentativas (confiança ${pct}%).`
      : overdue
        ? `O ${t.id} está com o prazo vencido e o colaborador quer falar com um analista.`
        : 'O colaborador pediu para falar com um analista.';
  const rule =
    mode === 'inseguro'
      ? 'Regra do service desk: quando o agent não tem segurança sobre o que fazer, a conversa vai para um analista.'
      : overdue
        ? 'Regra do service desk: chamado vencido vai para um analista.'
        : 'Regra do service desk: quando o colaborador pede, a conversa vai para um analista.';
  const message =
    mode === 'inseguro'
      ? `Não consegui entender o que você precisa. Para não te deixar sem resposta, chamei um analista do ${QUEUE} — ele fala com você em até ${HANDOFF_HOURS} h úteis.`
      : `Encaminhei para o ${QUEUE}. Um analista vai falar com você em até ${HANDOFF_HOURS} h úteis.`;

  return reply(
    [text(message)],
    { focusTicketId: ticketId },
    decide(
      mode === 'inseguro' ? 'Não identificada' : 'Falar com um analista',
      `Transferiu a conversa para o ${QUEUE}`,
      confidence,
      [
        why,
        rule,
        ticketId ? `O ${ticketId} segue junto, para o analista não precisar perguntar tudo de novo.` : 'Não havia chamado em foco; o analista recebe um resumo da conversa.',
        'O agent fica pausado até o analista devolver a conversa.',
      ],
      [fact('Chamado em foco', ticketId), fact('Fila', QUEUE), fact('Prazo de retorno', `${HANDOFF_HOURS} h úteis`)],
    ),
    {
      tools: ['resumiu o caso'],
      effects: [{ type: 'handoff', ticketId, summary: summarize(env, ctx, reason, ticketId), lowConfidence: mode === 'inseguro' ? confidence : undefined }],
    },
  );
}

// ---------------------------------------------------------------------------
// Respostas

function greet(env: AgentEnv): Turn {
  return reply(
    [text(`Olá, ${firstName(env.user)}! Posso consultar seus chamados, abrir um novo ou chamar um analista. O que está acontecendo?`, undefined, START)],
    {},
    decide('Cumprimento', 'Cumprimentou e ofereceu as opções de atendimento', CONFIDENCE.keyword, [
      'A mensagem é uma saudação curta, sem pedido.',
      'Sem um pedido, apresenta o que pode fazer.',
    ]),
  );
}

/** Não entendeu: pergunta de novo; na segunda vez seguida, chama um analista. */
function fallback(env: AgentEnv, ctx: AgentContext, why: string): Turn {
  const misses = (ctx.misses ?? 0) + 1;
  if (misses >= MAX_MISSES) {
    return handoff(env, { ...ctx, misses }, CONFIDENCE.none, `${why} É a ${misses}ª resposta seguida sem entender o pedido.`, 'inseguro');
  }
  return reply(
    [text('Não entendi bem. Posso consultar seus chamados, abrir um novo ou chamar um analista.', undefined, START)],
    { ...ctx, misses },
    decide('Não identificada', 'Pediu para reformular e ofereceu opções', CONFIDENCE.none, [
      why,
      'Na dúvida, pergunta em vez de agir.',
      `Se não entender de novo, chama um analista.`,
    ]),
  );
}

function listTickets(env: AgentEnv, confidence: number, why?: string): Turn {
  const open = env.tickets.filter((t) => t.status !== 'resolvido').sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  const tools = ['consultou seus chamados'];
  const found = `Encontrou ${open.length} ${open.length === 1 ? 'chamado aberto' : 'chamados abertos'}; os resolvidos não entram na lista.`;
  const understood = [fact('Chamados abertos', open.map((t) => t.id).join(', ') || 'nenhum')];

  if (open.length === 0) {
    return reply(
      [text('Você não tem chamados abertos. Quer relatar um problema?', undefined, START.slice(1))],
      {},
      decide('Consultar chamados', 'Informou que não há chamados abertos', confidence, [why, found, 'Ofereceu relatar um problema.'], understood),
      { tools },
    );
  }
  if (open.length === 1) {
    const r = ticketStatus(open[0], env, confidence);
    return {
      ...r,
      tools: [...tools, ...r.tools],
      decision: { ...r.decision, reasons: [why, found, 'Com um só chamado, mostra o status direto.', ...r.decision.reasons].filter((x): x is string => !!x) },
    };
  }
  return reply(
    [text(`Você tem ${open.length} chamados abertos. Sobre qual deles quer saber?`), { type: 'ticket-picker', ticketIds: open.map((t) => t.id) }],
    {},
    decide('Consultar chamados', 'Pediu para escolher o chamado na lista', confidence, [why, found, 'Com mais de um, pede para escolher em vez de adivinhar.'], understood),
    { tools },
  );
}

const TK_ANALYST: Choice = { value: 'tk:analista', label: 'Falar com um analista' };
const TK_INFO: Choice = { value: 'tk:info', label: 'Adicionar informação' };
const TK_NO: Choice = { value: 'tk:nao', label: 'Não, obrigado' };
const TK_REOPEN: Choice = { value: 'tk:reabrir', label: 'Reabrir o chamado' };

function ticketStatus(t: Ticket, env: AgentEnv, confidence: number, why?: string): Turn {
  const tools = [`consultou o ${t.id}`, 'calculou o prazo'];
  const days = calendarDaysBetween(t.updatedAt, env.now);
  const sla = SLA[t.priority].label;
  const due = slaDeadline(t.priority, t.updatedAt);
  const priority = PRIORITY[t.priority].label.toLowerCase();

  let tail: Block;
  let action: string;
  let rule: string[];
  if (t.status === 'resolvido') {
    const reopen = canReopen(t, env.now);
    tail = reopen
      ? text(`Esse chamado foi resolvido em ${dayMonth(t.resolvedAt ?? t.updatedAt)}. Se o problema voltou, posso reabrir — faz menos de ${REOPEN_DAYS} dias.`, undefined, [
          TK_REOPEN,
          TK_ANALYST,
          { value: 'tk:nao', label: 'Está tudo certo' },
        ])
      : text(`Esse chamado foi resolvido em ${dayMonth(t.resolvedAt ?? t.updatedAt)}. Se o problema voltou, posso chamar um analista.`, undefined, [
          TK_ANALYST,
          { value: 'tk:nao', label: 'Está tudo certo' },
        ]);
    action = reopen ? 'Mostrou que o chamado está resolvido e ofereceu reabrir' : 'Mostrou que o chamado está resolvido';
    rule = [
      'Chamado resolvido não tem prazo correndo.',
      reopen ? `Resolvido há menos de ${REOPEN_DAYS} dias: pode ser reaberto.` : `Resolvido há mais de ${REOPEN_DAYS} dias: não pode ser reaberto; se voltou, oferece um analista.`,
    ];
  } else if (t.status === 'aprovado') {
    tail = text('Sua solicitação foi aprovada. A equipe de suprimentos entra em contato para combinar a entrega.', undefined, [TK_INFO, TK_NO]);
    action = 'Mostrou que a solicitação foi aprovada';
    rule = ['Solicitação aprovada aguarda a entrega, sem prazo de atualização.'];
  } else if (isOverdue(t, env.now)) {
    tail = text(
      `Está sem atualização há ${days} dias, acima do prazo de ${sla} para prioridade ${priority}. Quer que eu chame um analista?`,
      undefined,
      [TK_ANALYST, TK_INFO, TK_NO],
    );
    action = 'Apontou o prazo vencido e ofereceu um analista';
    rule = [
      `O prazo para prioridade ${priority} é ${sla} a partir da última atualização; venceu em ${dueLabel(due, env.now)}.`,
      'Chamado vencido vai para um analista; pergunta antes de transferir.',
    ];
  } else {
    const where = t.status === 'aguardando_analista' ? `Está na fila do ${QUEUE}` : 'Um analista está cuidando dele';
    tail = text(`${where}, dentro do prazo — última atualização ${relDays(days)}. Quer acrescentar alguma informação?`, undefined, [TK_INFO, TK_ANALYST, TK_NO]);
    action = 'Mostrou o status, dentro do prazo';
    rule = [`O prazo para prioridade ${priority} é ${sla} a partir da última atualização; vence ${dueLabel(due, env.now)}.`];
  }

  return reply(
    [{ type: 'ticket', ticketId: t.id }, tail],
    { focusTicketId: t.id },
    decide('Consultar um chamado', action, confidence, [why, ...rule], [
      fact('Chamado', `${t.id} · ${t.title}`),
      fact('Status', TICKET_STATUS[t.status].label),
      fact('Prioridade', PRIORITY[t.priority].label),
      fact('Última atualização', relDays(days)),
    ]),
    { tools },
  );
}

function addNote(ticketId: string, raw: string, confidence: number, why?: string): Turn {
  return reply(
    [text(`Adicionei ao ${ticketId}. Quer que eu chame um analista também?`, undefined, [{ value: 'tk:analista', label: 'Sim, chamar analista' }, { value: 'tk:nao', label: 'Não precisa' }])],
    { focusTicketId: ticketId },
    decide(
      'Complementar um chamado',
      `Acrescentou a informação ao ${ticketId}`,
      confidence,
      [why, 'Complementa o chamado existente em vez de abrir outro (regra de não duplicar).'],
      [fact('Chamado', ticketId), fact('Informação', raw.trim())],
    ),
    { tools: [`atualizou o ${ticketId}`], effects: [{ type: 'add-note', ticketId, text: raw.trim() }] },
  );
}

function reopen(t: Ticket, raw: string, env: AgentEnv): Turn {
  const due = slaDeadline(t.priority, env.now);
  return reply(
    [text(`Reabri o ${t.id}. Ele volta para a fila do ${QUEUE}, e um analista responde até ${dueLabel(due, env.now)}.`)],
    { focusTicketId: t.id },
    decide(
      'Reabrir um chamado',
      `Reabriu o ${t.id}`,
      CONFIDENCE.explicit,
      [
        `O ${t.id} foi resolvido em ${dayMonth(t.resolvedAt ?? t.updatedAt)}, há menos de ${REOPEN_DAYS} dias: pode ser reaberto.`,
        'Reabrir mantém o histórico do atendimento em vez de duplicar o chamado.',
        `Prazo de resposta para prioridade ${PRIORITY[t.priority].label.toLowerCase()}: ${SLA[t.priority].label}.`,
      ],
      [fact('Chamado', `${t.id} · ${t.title}`), fact('Informação', raw.trim())],
    ),
    { tools: [`reabriu o ${t.id}`], effects: [{ type: 'reopen', ticketId: t.id, text: raw.trim() }] },
  );
}

function outOfScope(area: string, where: string): Turn {
  return reply(
    [text(`Esse assunto é do ${area}, não de TI — por aqui eu só consigo ajudar com tecnologia. Procure ${where}.`, undefined, START.slice(0, 2))],
    {},
    decide('Fora do escopo de TI', `Encaminhou para ${area}`, CONFIDENCE.keyword, [
      `A mensagem fala de um assunto de ${area} e não cita nenhum assunto de TI.`,
      'Regra do service desk: só assuntos de TI; os outros são redirecionados, sem abrir chamado.',
    ], [fact('Área', area)]),
  );
}

function problem(raw: string, env: AgentEnv, skipExisting: boolean): Turn {
  const n = normalize(raw);
  const topic = detectTopic(n);
  const code = errorCode(n);
  const info: ProblemInfo = { text: raw.trim(), topic: topic.key };
  const known = topic !== OTHER;
  const confidence = known ? CONFIDENCE.topic : CONFIDENCE.vague;
  const classified = known
    ? `Palavras da mensagem indicam ${topic.label} → categoria ${topic.category}.`
    : 'Nenhum assunto conhecido na mensagem → categoria Outros.';
  const understood = [fact('Categoria', known ? topic.category : 'Outros (assunto não reconhecido)'), fact('Código de erro', code)];
  const skipped = skipExisting ? 'Você disse que é outro problema, então não comparou com os seus chamados.' : undefined;

  const related = skipExisting ? undefined : findRelated(n, topic, env);
  if (related?.status === 'resolvido') {
    return reply(
      [
        { type: 'ticket', ticketId: related.id },
        text(
          `Você teve o ${related.id} sobre isso, resolvido em ${dayMonth(related.resolvedAt ?? related.updatedAt)}. Como faz menos de ${REOPEN_DAYS} dias, posso reabrir ele em vez de abrir outro.`,
          'Quer reabrir?',
          [TK_REOPEN, { value: 'tk:novo', label: 'É outro problema' }],
        ),
      ],
      { problem: info, focusTicketId: related.id },
      decide(
        'Relatar um problema',
        `Sugeriu reabrir o ${related.id}`,
        confidence,
        [
          classified,
          `O ${related.id} (“${related.title}”) é do mesmo assunto e tem palavras em comum com a mensagem.`,
          `Foi resolvido há menos de ${REOPEN_DAYS} dias: a regra permite reabrir em vez de duplicar.`,
          'Só reabre depois da sua confirmação.',
        ],
        [...understood, fact('Chamado parecido', `${related.id} · ${related.title} (resolvido)`)],
      ),
      { tools: ['consultou seus chamados'] },
    );
  }
  if (related) {
    return reply(
      [
        { type: 'ticket', ticketId: related.id },
        text(
          `Você já tem o ${related.id} sobre isso, ${TICKET_STATUS[related.status].label.toLowerCase()}. Quer que eu acrescente essa informação a ele?`,
          undefined,
          [{ value: 'tk:add', label: 'Acrescentar ao chamado' }, TK_ANALYST, { value: 'tk:novo', label: 'É outro problema' }],
        ),
      ],
      { problem: info, focusTicketId: related.id },
      decide(
        'Relatar um problema',
        `Sugeriu acrescentar ao ${related.id} em vez de abrir outro`,
        confidence,
        [classified, `O ${related.id} (${TICKET_STATUS[related.status].label.toLowerCase()}) é sobre o mesmo assunto.`, 'Para não duplicar, pergunta antes de abrir outro.'],
        [...understood, fact('Chamado parecido', `${related.id} · ${related.title}`)],
      ),
      { tools: ['consultou seus chamados'] },
    );
  }

  const tools = skipExisting ? ['buscou na central de ajuda'] : ['consultou seus chamados', 'buscou na central de ajuda'];
  const kb = topic.kb?.(n, code);
  const os = env.user.os;
  const noDuplicate = skipExisting || !known ? undefined : `Não há chamado aberto (nem resolvido há menos de ${REOPEN_DAYS} dias) sobre ${topic.label}.`;

  if (kb && (!kb.os || kb.os === os)) {
    const steps = kb.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
    return reply(
      [text(`Encontrei na central de ajuda “${kb.title}”:\n${steps}`, 'Isso resolveu?', [{ value: 'kb:ok', label: 'Resolveu' }, { value: 'kb:no', label: 'Não resolveu' }])],
      { problem: info, awaiting: 'kb' },
      decide(
        'Relatar um problema',
        'Sugeriu a solução da central de ajuda',
        confidence,
        [
          skipped,
          classified,
          noDuplicate,
          `O artigo “${kb.title}” se aplica${kb.os ? ` (vale para ${kb.os}, o mesmo do seu computador)` : ''}.`,
          'Tentar a solução da central evita abrir chamado para algo que se resolve no chat.',
        ],
        [...understood, fact('Artigo', kb.title)],
      ),
      { tools },
    );
  }

  const kbNote = kb ? `o artigo ${kb.ref} vale só para ${kb.os} — o seu é ${os}` : 'não encontrei solução na central de ajuda para esse caso';
  const lead = skipExisting
    ? `Entendi, é outro problema. ${kbNote[0].toUpperCase()}${kbNote.slice(1)}.`
    : `Não há chamado aberto sobre ${topic.label}, e ${kbNote}.`;

  return reply(
    [text(`${lead} Vou abrir um chamado.`, 'Quem está sendo afetado?', AFFECTED_CHOICES)],
    { problem: info, awaiting: 'affected' },
    decide(
      'Relatar um problema',
      'Começou a abrir um chamado e perguntou quem é afetado',
      confidence,
      [
        skipped,
        classified,
        noDuplicate,
        kb ? `O artigo “${kb.title}” vale só para ${kb.os}; o seu computador é ${os}.` : 'A central de ajuda não tem artigo para esse caso.',
        'Para definir a prioridade, falta saber quem é afetado.',
      ],
      [...understood, fact('Sistema', kb?.os ? os : undefined)],
    ),
    { tools },
  );
}

export function buildDraft(p: ProblemInfo, affected: Affected, env: AgentEnv, confidence: number, why?: string): Turn {
  const n = normalize(p.text);
  const full = normalize(`${p.text} ${p.extra ?? ''}`);
  const topic = topicByKey(p.topic);
  const kind = detectKind(full);
  const urgency = URGENCY.find((u) => u.re.test(full));
  const urgencyWord = urgency && full.match(urgency.re)?.[0];

  // Prioridade = impacto (quantos são afetados) + urgência (compromisso em risco).
  let priority: Priority;
  let reason = '';
  let rule: string;
  if (kind === 'incidente' && (affected === 'empresa' || affected === 'equipe')) {
    priority = 'critica';
    reason = affected === 'empresa' ? 'porque afeta a empresa toda' : 'porque afeta sua equipe';
    rule = `Algo parado para ${affected === 'empresa' ? 'a empresa' : 'uma equipe'} → prioridade crítica.`;
  } else if (urgency) {
    priority = 'alta';
    reason = urgency.reason;
    rule = `A mensagem cita “${urgencyWord}”, um compromisso em risco → prioridade alta.`;
  } else if (kind === 'requisicao') {
    priority = 'baixa';
    rule = 'Pedido sem urgência → prioridade baixa.';
  } else {
    priority = 'media';
    rule = 'Atrapalha, mas não há urgência nem outras pessoas afetadas → prioridade média.';
  }

  const deadline = slaDeadline(priority, env.now);
  const limit = extractTime(full, env.now);
  const beforeLimit = !!limit && deadline <= limit;
  const sla = beforeLimit ? `a resposta chega antes das ${hourLabel(limit)}` : `resposta até ${dueLabel(deadline, env.now)}`;
  const priorityLabel = PRIORITY[priority].label.toLowerCase();
  const late = limit && !beforeLimit ? `\nEsse prazo passa do seu horário das ${hourLabel(limit)}. Se não puder esperar, chamo um analista agora.` : '';

  const draft: TicketDraft = {
    id: env.nextDraftId,
    kind,
    title: topic.title?.(n, errorCode(n)) ?? titleFromText(p.text),
    description: describe(p, env.now),
    category: topic.category,
    priority,
    affected,
    createdAt: env.now.toISOString(),
  };

  return reply(
    [
      text(
        `Coloquei prioridade ${priorityLabel}${reason ? ` ${reason}` : ''} — ${sla}.${late}\nConfira antes de eu criar:`,
        undefined,
        late ? [{ value: 'tk:analista', label: 'Chamar um analista agora' }] : undefined,
      ),
      { type: 'draft', draft, state: 'pending' },
    ],
    { problem: p },
    decide(
      'Abrir um chamado',
      'Montou o rascunho do chamado para você conferir',
      confidence,
      [
        why,
        kind === 'requisicao' ? 'É um pedido de acesso, equipamento ou software → requisição (REQ).' : 'Algo parou ou não funciona → incidente (INC).',
        rule,
        `Prazo de resposta para prioridade ${priorityLabel}: ${SLA[priority].label} → até ${dueLabel(deadline, env.now)}.`,
        limit ? `${beforeLimit ? 'Chega' : 'Não chega'} antes do horário que você citou (${hourLabel(limit)}).` : undefined,
        'Só cria o chamado depois da sua confirmação.',
      ],
      [
        fact('Tipo', TICKET_KIND[kind].label),
        fact('Afetados', AFFECTED[affected]),
        fact('Urgência', urgencyWord ? `“${urgencyWord}”` : 'nenhuma citada'),
        fact('Horário citado', limit ? hourLabel(limit) : undefined),
        fact('Categoria', topic.category),
        fact('Prioridade', PRIORITY[priority].label),
      ],
    ),
    { tools: ['classificou a prioridade', 'consultou o SLA', 'montou o rascunho'], effects: [{ type: 'mark-choice', value: `aff:${affected}` }] },
  );
}

// ---------------------------------------------------------------------------
// Entradas

const analystWord = (n: string) => n.match(/\b(analista|atendente|humano|tecnico|pessoa de verdade|falar com alguem)\b/)?.[0];

function onText(raw: string, env: AgentEnv, ctx: AgentContext): Turn {
  const n = normalize(raw);

  if (ctx.awaiting === 'note' && ctx.focusTicketId) {
    return addNote(ctx.focusTicketId, raw, CONFIDENCE.keyword, `Você estava respondendo o que acrescentar ao ${ctx.focusTicketId}.`);
  }

  const id = n.match(/\b(inc|req)-?\s?(\d{4,6})\b/);
  if (id) {
    const ticketId = `${id[1].toUpperCase()}-${id[2]}`;
    const t = env.tickets.find((x) => x.id === ticketId);
    if (t) return ticketStatus(t, env, CONFIDENCE.explicit, `A mensagem cita o ${ticketId}, que é seu.`);
    const r = listTickets(env, CONFIDENCE.keyword, `A mensagem cita o ${ticketId}, mas ele não está entre os seus chamados; por privacidade, só mostra chamados de quem os abriu.`);
    return { ...r, blocks: [text(`Não encontrei o ${ticketId} entre os seus chamados.`), ...r.blocks] };
  }

  const word = analystWord(n);

  if (ctx.awaiting === 'affected' && ctx.problem) {
    const affected = detectAffected(n);
    const p: ProblemInfo = { ...ctx.problem, extra: [ctx.problem.extra, raw.trim()].filter(Boolean).join(' ') };
    if (affected) return buildDraft(p, affected, env, CONFIDENCE.keyword, `Resposta à pergunta “Quem está sendo afetado?”: ${AFFECTED[affected].toLowerCase()}.`);
    if (!word) {
      return reply(
        [text('Anotado. Só pra classificar a prioridade:', 'Quem está sendo afetado?', AFFECTED_CHOICES)],
        { ...ctx, problem: p },
        decide('Complementar o relato', 'Guardou a informação e perguntou de novo quem é afetado', CONFIDENCE.vague, [
          'A mensagem não diz quem é afetado.',
          'Sem isso não dá para definir a prioridade; o texto entra na descrição do chamado.',
        ]),
      );
    }
  }

  if (word) return handoff(env, ctx, CONFIDENCE.keyword, `A mensagem pede um atendente (“${word}”).`);
  if (/\b(status|andamento|situacao)\b|\bmeus? chamados?\b|\bchamados? abertos?\b/.test(n)) {
    return listTickets(env, CONFIDENCE.keyword, 'A mensagem pergunta sobre seus chamados, sem citar um número.');
  }
  if (/^(obrigad|valeu|vlw|brigad|resolveu|deu certo|funcionou|perfeito)/.test(n)) {
    return reply(
      [text(`Por nada, ${firstName(env.user)}! Se precisar, é só escrever.`)],
      {},
      decide('Agradecimento', 'Encerrou o assunto', CONFIDENCE.keyword, ['A mensagem é um agradecimento, sem pedido novo.']),
    );
  }
  if (/^(oi|ola|bom dia|boa tarde|boa noite|e ai|opa)\b/.test(n) && n.length < 30) return greet(env);
  if (/\bhorario\b|que horas .*(suporte|service desk|ti)\b|\bplantao\b/.test(n)) {
    return reply(
      [text('O service desk atende de segunda a sexta, das 8h às 18h. Chamados críticos têm plantão 24 horas.')],
      {},
      decide('Dúvida', 'Respondeu com o artigo da central de ajuda', CONFIDENCE.keyword, [
        'A mensagem pergunta sobre o horário de atendimento.',
        'A central de ajuda responde; não precisa de chamado.',
      ], [fact('Artigo', 'Horário do service desk')]),
      { tools: ['buscou na central de ajuda'] },
    );
  }
  if (/\bsenha\b/.test(n) && !/vpn|wi-?fi|\bsap\b|sistema/.test(n)) {
    return reply(
      [
        text(
          'Para trocar a senha da rede, use Meu perfil › Redefinir senha — enviamos um link para o seu e-mail corporativo. Se a conta estiver bloqueada, posso chamar um analista.',
          undefined,
          [{ value: 'start:analista', label: 'Falar com um analista' }],
        ),
      ],
      {},
      decide('Dúvida sobre senha', 'Respondeu com a orientação da central de ajuda', CONFIDENCE.topic, [
        'A mensagem fala de senha sem citar VPN, Wi-Fi, SAP ou outro sistema → senha da rede.',
        'A troca de senha é feita pelo próprio colaborador, sem chamado.',
      ]),
      { tools: ['buscou na central de ajuda'] },
    );
  }
  if (detectTopic(n) === OTHER) {
    const scope = OUT_OF_SCOPE.find((s) => s.re.test(n));
    if (scope) return outOfScope(scope.area, scope.where);
  }
  if (n.split(/\s+/).length >= 3) return problem(raw, env, false);
  return fallback(env, ctx, 'Nenhuma regra reconheceu um pedido, e a mensagem é curta demais para ser um relato de problema.');
}

function onChoice(value: string, env: AgentEnv, ctx: AgentContext): Turn {
  const [kind, arg] = value.split(':');
  const sure = CONFIDENCE.explicit;

  if (kind === 'start') {
    if (arg === 'status') return listTickets(env, sure);
    if (arg === 'analista') return handoff(env, ctx, sure);
    return reply(
      [text('Claro. Descreva o que está acontecendo — se aparecer um código de erro, inclua ele.')],
      {},
      decide('Relatar um problema', 'Pediu a descrição do problema', sure, ['Precisa da descrição, e do código de erro se houver, para classificar.']),
    );
  }

  if (kind === 'aff' && ctx.problem) return buildDraft(ctx.problem, arg as Affected, env, sure);

  if (kind === 'kb' && ctx.problem) {
    if (arg === 'ok') {
      return reply(
        [text('Que bom que resolveu! Vou encerrar por aqui — se voltar a acontecer, é só escrever.')],
        {},
        decide('Confirmar a solução', 'Encerrou como resolvido pela central de ajuda', sure, ['Resolvido no chat, sem abrir chamado.']),
        { effects: [{ type: 'resolve' }] },
      );
    }
    return reply(
      [text('Entendi. Vou abrir um chamado então.', 'Quem está sendo afetado?', AFFECTED_CHOICES)],
      { ...ctx, awaiting: 'affected' },
      decide('Abrir um chamado', 'Seguiu para a abertura do chamado', sure, ['O artigo não resolveu.', 'Para definir a prioridade, falta saber quem é afetado.']),
    );
  }

  if (kind === 'tk') {
    const id = ctx.focusTicketId;
    const t = env.tickets.find((x) => x.id === id);
    if (arg === 'analista') return handoff(env, ctx, sure);
    if (arg === 'info' && id) {
      return reply(
        [text(`Claro. O que quer acrescentar ao ${id}?`)],
        { focusTicketId: id, awaiting: 'note' },
        decide('Complementar um chamado', 'Perguntou o que acrescentar', sure, ['A próxima mensagem vai como informação no chamado.'], [fact('Chamado', id)]),
      );
    }
    if (arg === 'add' && id && ctx.problem) return addNote(id, ctx.problem.text, sure);
    if (arg === 'reabrir' && t && canReopen(t, env.now)) return reopen(t, ctx.problem?.text ?? 'O problema voltou.', env);
    if (arg === 'novo' && ctx.problem) return problem(ctx.problem.text, env, true);
    if (arg === 'nao') {
      return reply([text('Certo! Se precisar de mais alguma coisa, é só escrever.')], {}, decide('Encerrar o assunto', 'Encerrou o assunto', sure, ['Você não precisa de mais nada agora.']));
    }
  }

  return fallback(env, ctx, 'A opção escolhida não vale mais neste ponto da conversa.');
}

function onDraft(input: Extract<AgentInput, { type: 'draft' }>, env: AgentEnv, ctx: AgentContext): Turn {
  const msg = env.conversation.messages.find((m) => m.id === input.messageId);
  const block = msg?.blocks?.find((b): b is Extract<Block, { type: 'draft' }> => b.type === 'draft');
  if (!block || block.state !== 'pending') return fallback(env, ctx, 'O rascunho já foi confirmado ou descartado.');

  const d = block.draft;
  const understood = [
    fact('Rascunho', `${d.id} · ${d.title}`),
    fact('Tipo', TICKET_KIND[d.kind].label),
    fact('Categoria', d.category),
    fact('Prioridade', PRIORITY[d.priority].label),
  ];

  if (input.action === 'cancel') {
    return reply(
      [text('Tudo bem, descartei o rascunho. Se mudar de ideia, é só descrever o problema de novo.')],
      {},
      decide('Abrir um chamado', 'Descartou o rascunho', CONFIDENCE.explicit, ['Você cancelou; nenhum chamado foi criado.'], understood),
      { effects: [{ type: 'cancel-draft', messageId: input.messageId }] },
    );
  }

  const id = env.nextIds[d.kind];
  const due = slaDeadline(d.priority, env.now);
  const critical = d.priority === 'critica';
  const tried = [...new Set(env.conversation.messages.flatMap((m) => m.tools ?? []))];

  return reply(
    [
      text(
        `Pronto: abri o ${id} com prioridade ${PRIORITY[d.priority].label.toLowerCase()}. ` +
          (critical
            ? `Como é crítico, já chamei um analista do ${QUEUE} — ele fala com você até ${hhmm(due)}.`
            : `Um analista responde até ${dueLabel(due, env.now)} — você acompanha tudo por aqui.`),
      ),
    ],
    { focusTicketId: id },
    decide(
      'Abrir um chamado',
      critical ? `Criou o ${id} e transferiu para o ${QUEUE}` : `Criou o ${id}`,
      CONFIDENCE.explicit,
      [
        'Você confirmou o rascunho, com as edições que fez.',
        `${TICKET_KIND[d.kind].label} → número ${TICKET_KIND[d.kind].prefix}.`,
        `Prazo de resposta: ${SLA[d.priority].label} → até ${dueLabel(due, env.now)}.`,
        critical ? 'Regra do service desk: caso crítico vai direto para um analista, com um resumo do caso.' : undefined,
      ],
      understood,
    ),
    {
      tools: critical ? ['criou o chamado', 'resumiu o caso'] : ['criou o chamado'],
      effects: [
        { type: 'create-ticket', messageId: input.messageId, ticketId: id },
        ...(critical
          ? [
              {
                type: 'handoff' as const,
                ticketId: id,
                dueAt: due.toISOString(),
                summary: {
                  reason: `Chamado crítico: afeta ${AFFECTED[d.affected].toLowerCase()}.`,
                  ticket: `${id} · ${d.title} · Aguardando analista`,
                  report: d.description,
                  tried,
                },
              },
            ]
          : []),
      ],
    },
  );
}

export function triggerOf(input: AgentInput) {
  switch (input.type) {
    case 'text':
      return 'Mensagem de texto';
    case 'choice':
      return `Botão “${input.label}”`;
    case 'pick-ticket':
      return `Escolheu o ${input.ticketId} na lista`;
    case 'draft':
      return input.action === 'confirm' ? 'Confirmou o rascunho' : 'Cancelou o rascunho';
  }
}

function route(input: AgentInput, env: AgentEnv, ctx: AgentContext): Turn {
  switch (input.type) {
    case 'text':
      return onText(input.text, env, ctx);
    case 'choice':
      return onChoice(input.value, env, ctx);
    case 'pick-ticket': {
      const t = env.tickets.find((x) => x.id === input.ticketId);
      return t ? ticketStatus(t, env, CONFIDENCE.explicit) : fallback(env, ctx, 'O chamado escolhido não está entre os seus.');
    }
    case 'draft':
      return onDraft(input, env, ctx);
  }
}

export function runAgent(input: AgentInput, env: AgentEnv): AgentReply {
  const turn = route(input, env, env.conversation.agent ?? {});
  return { ...turn, decision: { trigger: triggerOf(input), ...turn.decision } };
}
