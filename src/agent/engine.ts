import type {
  Affected, AgentContext, Block, Choice, Conversation, Decision, DecisionFact, Priority, ProblemInfo, Ticket, TicketDraft, User,
} from '../data/types';
import { AFFECTED, PRIORITY, TICKET_STATUS } from '../data/labels';
import { HANDOFF_HOURS, RESPONSE_HOURS, UPDATE_SLA_DAYS, isOverdue, responseDeadline } from '../lib/sla';
import { businessDaysBetween, calendarDaysBetween, dayMonth, ddmm, hhmm, hourLabel, plural, relDays } from '../lib/time';

/**
 * Motor do Nexo Assist. Função pura: recebe a entrada do colaborador e o
 * contexto, devolve as ferramentas usadas, os blocos da resposta, os
 * efeitos a aplicar (transferir, criar chamado...) e a decisão que explica
 * a resposta. Quem aplica os efeitos é o runtime.
 */

export type AgentInput =
  | { type: 'text'; text: string }
  | { type: 'choice'; messageId: string; blockIndex: number; value: string; label: string }
  | { type: 'pick-ticket'; messageId: string; ticketId: string }
  | { type: 'draft'; messageId: string; action: 'confirm' | 'cancel' };

export type AgentEffect =
  | { type: 'handoff'; ticketId?: string }
  | { type: 'create-ticket'; messageId: string; ticketId: string }
  | { type: 'cancel-draft'; messageId: string }
  | { type: 'add-note'; ticketId: string; text: string }
  | { type: 'mark-choice'; value: string }
  | { type: 'resolve' };

export interface AgentEnv {
  user: User;
  /** Chamados do colaborador. */
  tickets: Ticket[];
  conversation: Conversation;
  now: Date;
  nextTicketId: string;
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
            steps: ['Abra o Editor do Registro.', 'Crie a chave AssumeUDPEncapsulationContextOnSendRule com valor 2.', 'Reinicie o notebook.'],
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
    category: 'Impressão',
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
    category: 'E-mail e colaboração',
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
  { key: 'acesso', label: 'acesso', category: 'Acessos', re: /acesso|permiss|\bpasta\b|sharepoint|\bsap\b/ },
  { key: 'perifericos', label: 'periféricos', category: 'Periféricos', re: /monitor|mouse|teclado|headset|\bfone\b|webcam|\bdock\b/ },
  {
    key: 'notebook',
    label: 'o notebook',
    category: 'Hardware › Notebook',
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

const URGENCY: { re: RegExp; reason: string }[] = [
  { re: /reuniao/, reason: 'por causa da reunião' },
  { re: /apresentacao/, reason: 'por causa da apresentação' },
  { re: /cliente/, reason: 'por causa do cliente' },
  { re: /urgente|urgencia/, reason: 'pela urgência' },
  { re: /\bhoje\b|prazo/, reason: 'pelo prazo de hoje' },
  { re: /(nao consigo|impossivel) trabalhar/, reason: 'porque seu trabalho está parado' },
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

function fallback(ctx: AgentContext, why: string): Turn {
  return reply(
    [text('Não entendi bem. Posso consultar seus chamados, abrir um novo ou chamar um analista.', undefined, START)],
    ctx,
    decide('Não identificada', 'Pediu para reformular e ofereceu opções', CONFIDENCE.none, [why, 'Na dúvida, pergunta em vez de agir.']),
  );
}

function handoff(env: AgentEnv, ctx: AgentContext, confidence: number, why?: string): Turn {
  const ticketId = ctx.focusTicketId ?? env.conversation.ticketId;
  return reply(
    [text(`Encaminhei para o ${QUEUE}. Um analista vai falar com você em até ${HANDOFF_HOURS} h úteis.`)],
    { focusTicketId: ticketId },
    decide(
      'Falar com um analista',
      `Transferiu a conversa para o ${QUEUE}`,
      confidence,
      [
        why,
        'Regra do service desk: quando o colaborador pede, a conversa vai para um analista.',
        ticketId ? `O ${ticketId} segue junto, para o analista não precisar perguntar tudo de novo.` : 'Não havia chamado em foco; o analista recebe o histórico da conversa.',
        'O agent fica pausado até o analista devolver a conversa.',
      ],
      [fact('Chamado em foco', ticketId), fact('Fila', QUEUE), fact('Prazo de retorno', `${HANDOFF_HOURS} h úteis`)],
    ),
    { effects: [{ type: 'handoff', ticketId }] },
  );
}

function listTickets(env: AgentEnv, confidence: number, why?: string): Turn {
  const open = env.tickets.filter((t) => t.status !== 'resolvido').sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  const tools = ['consultou seus chamados'];
  const found = `Encontrou ${open.length} ${plural(open.length, 'chamado aberto', 'chamados abertos')}; os resolvidos não entram na lista.`;
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

function ticketStatus(t: Ticket, env: AgentEnv, confidence: number, why?: string): Turn {
  const tools = [`consultou o ${t.id}`, 'calculou o prazo'];
  const days = calendarDaysBetween(t.updatedAt, env.now);
  const business = businessDaysBetween(t.updatedAt, env.now);
  const sla = UPDATE_SLA_DAYS[t.priority];
  const priority = PRIORITY[t.priority].label.toLowerCase();
  const slaText = `${sla} ${plural(sla, 'dia útil', 'dias úteis')}`;

  let tail: Block;
  let action: string;
  let rule: string[];
  if (t.status === 'resolvido') {
    tail = text(
      `Esse chamado foi resolvido em ${dayMonth(t.resolvedAt ?? t.updatedAt)}. Se o problema voltou, posso chamar um analista.`,
      undefined,
      [TK_ANALYST, { value: 'tk:nao', label: 'Está tudo certo' }],
    );
    action = 'Mostrou que o chamado está resolvido';
    rule = ['Chamado resolvido não tem prazo correndo.', 'Se o problema voltou, oferece um analista.'];
  } else if (t.status === 'aprovado') {
    tail = text('Sua solicitação foi aprovada. A equipe de suprimentos entra em contato para combinar a entrega.', undefined, [TK_INFO, TK_NO]);
    action = 'Mostrou que a solicitação foi aprovada';
    rule = ['Solicitação aprovada aguarda a entrega, sem prazo de atualização.'];
  } else if (isOverdue(t, env.now)) {
    tail = text(
      `Está sem atualização há ${days} dias, acima do prazo de ${slaText} para prioridade ${priority}. Quer que eu chame um analista?`,
      undefined,
      [TK_ANALYST, TK_INFO, TK_NO],
    );
    action = 'Apontou o prazo vencido e ofereceu um analista';
    rule = [
      `Sem atualização há ${business} ${plural(business, 'dia útil', 'dias úteis')}; o prazo para prioridade ${priority} é ${slaText}. Está vencido.`,
      'Chamado vencido justifica oferecer um analista.',
    ];
  } else {
    const where = t.status === 'aguardando_analista' ? `Está na fila do ${QUEUE}` : 'Um analista está cuidando dele';
    tail = text(`${where}, dentro do prazo — última atualização ${relDays(days)}. Quer acrescentar alguma informação?`, undefined, [TK_INFO, TK_ANALYST, TK_NO]);
    action = 'Mostrou o status, dentro do prazo';
    rule = [`Sem atualização há ${business} ${plural(business, 'dia útil', 'dias úteis')}; o prazo para prioridade ${priority} é ${slaText}. Está em dia.`];
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
  const skipped = skipExisting ? 'Você disse que é outro problema, então não comparou com os chamados abertos.' : undefined;

  if (!skipExisting && known) {
    const existing = env.tickets.find((t) => t.status !== 'resolvido' && t.category === topic.category);
    if (existing) {
      return reply(
        [
          { type: 'ticket', ticketId: existing.id },
          text(
            `Você já tem o ${existing.id} sobre isso, ${TICKET_STATUS[existing.status].label.toLowerCase()}. Quer que eu acrescente essa informação a ele?`,
            undefined,
            [
              { value: 'tk:add', label: 'Acrescentar ao chamado' },
              TK_ANALYST,
              { value: 'tk:novo', label: 'É outro problema' },
            ],
          ),
        ],
        { problem: info, focusTicketId: existing.id },
        decide(
          'Relatar um problema',
          `Sugeriu acrescentar ao ${existing.id} em vez de abrir outro`,
          confidence,
          [classified, `O ${existing.id} (${TICKET_STATUS[existing.status].label.toLowerCase()}) é da mesma categoria.`, 'Para não duplicar, pergunta antes de abrir outro.'],
          [...understood, fact('Chamado parecido', `${existing.id} · ${existing.title}`)],
        ),
        { tools: ['consultou seus chamados'] },
      );
    }
  }

  const tools = skipExisting ? ['buscou na central de ajuda'] : ['consultou seus chamados', 'buscou na central de ajuda'];
  const kb = topic.kb?.(n, code);
  const os = env.user.os;
  const noDuplicate = skipExisting || !known ? undefined : `Não há chamado aberto na categoria ${topic.category}.`;

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

  let priority: Priority = 'media';
  let reason = '';
  let rule = 'Afeta só uma pessoa e não há urgência → prioridade média.';
  let urgencyWord: string | undefined;
  if (affected === 'empresa') {
    priority = 'critica';
    reason = 'porque afeta a empresa toda';
    rule = 'Afeta a empresa toda → prioridade crítica.';
  } else {
    if (affected === 'equipe') {
      priority = 'alta';
      reason = 'porque afeta sua equipe';
      rule = 'Afeta a equipe → prioridade alta.';
    }
    const urgency = URGENCY.find((u) => u.re.test(full));
    if (urgency) {
      priority = 'alta';
      reason = urgency.reason;
      urgencyWord = full.match(urgency.re)?.[0];
      rule = `A mensagem cita “${urgencyWord}”, um compromisso em risco → prioridade alta.`;
    }
  }

  const deadline = responseDeadline(priority, env.now);
  const limit = extractTime(full, env.now);
  const sla = limit && deadline <= limit ? `a resposta chega antes das ${hourLabel(limit)}` : `resposta até ${hhmm(deadline)}`;
  const priorityLabel = PRIORITY[priority].label.toLowerCase();

  const draft: TicketDraft = {
    id: env.nextDraftId,
    title: topic.title?.(n, errorCode(n)) ?? titleFromText(p.text),
    description: describe(p, env.now),
    category: topic.category,
    priority,
    affected,
    createdAt: env.now.toISOString(),
  };

  return reply(
    [
      text(`Coloquei prioridade ${priorityLabel}${reason ? ` ${reason}` : ''} — ${sla}.\nConfira antes de eu criar:`),
      { type: 'draft', draft, state: 'pending' },
    ],
    { problem: p },
    decide(
      'Abrir um chamado',
      'Montou o rascunho do chamado para você conferir',
      confidence,
      [
        why,
        rule,
        `Prazo de primeira resposta para prioridade ${priorityLabel}: ${RESPONSE_HOURS[priority]} h → até ${hhmm(deadline)}.`,
        limit ? `${deadline <= limit ? 'Chega' : 'Não chega'} antes do horário que você citou (${hourLabel(limit)}).` : undefined,
        'Só cria o chamado depois da sua confirmação.',
      ],
      [
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
  if (n.split(/\s+/).length >= 3) return problem(raw, env, false);
  return fallback(ctx, 'Nenhuma regra reconheceu um pedido, e a mensagem é curta demais para ser um relato de problema.');
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
    if (arg === 'analista') return handoff(env, ctx, sure);
    if (arg === 'info' && id) {
      return reply(
        [text(`Claro. O que quer acrescentar ao ${id}?`)],
        { focusTicketId: id, awaiting: 'note' },
        decide('Complementar um chamado', 'Perguntou o que acrescentar', sure, ['A próxima mensagem vai como informação no chamado.'], [fact('Chamado', id)]),
      );
    }
    if (arg === 'add' && id && ctx.problem) return addNote(id, ctx.problem.text, sure);
    if (arg === 'novo' && ctx.problem) return problem(ctx.problem.text, env, true);
    if (arg === 'nao') {
      return reply([text('Certo! Se precisar de mais alguma coisa, é só escrever.')], {}, decide('Encerrar o assunto', 'Encerrou o assunto', sure, ['Você não precisa de mais nada agora.']));
    }
  }

  return fallback(ctx, 'A opção escolhida não vale mais neste ponto da conversa.');
}

function onDraft(input: Extract<AgentInput, { type: 'draft' }>, env: AgentEnv, ctx: AgentContext): Turn {
  const msg = env.conversation.messages.find((m) => m.id === input.messageId);
  const block = msg?.blocks?.find((b): b is Extract<Block, { type: 'draft' }> => b.type === 'draft');
  if (!block || block.state !== 'pending') return fallback(ctx, 'O rascunho já foi confirmado ou descartado.');

  const d = block.draft;
  const understood = [fact('Rascunho', `${d.id} · ${d.title}`), fact('Categoria', d.category), fact('Prioridade', PRIORITY[d.priority].label)];

  if (input.action === 'cancel') {
    return reply(
      [text('Tudo bem, descartei o rascunho. Se mudar de ideia, é só descrever o problema de novo.')],
      {},
      decide('Abrir um chamado', 'Descartou o rascunho', CONFIDENCE.explicit, ['Você cancelou; nenhum chamado foi criado.'], understood),
      { effects: [{ type: 'cancel-draft', messageId: input.messageId }] },
    );
  }

  const id = env.nextTicketId;
  const deadline = responseDeadline(d.priority, env.now);
  return reply(
    [text(`Pronto: abri o ${id} com prioridade ${PRIORITY[d.priority].label.toLowerCase()}. Um analista responde até ${hhmm(deadline)} — você acompanha tudo por aqui.`)],
    { focusTicketId: id },
    decide(
      'Abrir um chamado',
      `Criou o ${id}`,
      CONFIDENCE.explicit,
      ['Você confirmou o rascunho, com as edições que fez.', `Prazo de primeira resposta: ${RESPONSE_HOURS[d.priority]} h → até ${hhmm(deadline)}.`],
      understood,
    ),
    { tools: ['criou o chamado'], effects: [{ type: 'create-ticket', messageId: input.messageId, ticketId: id }] },
  );
}

function triggerOf(input: AgentInput) {
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
      return t ? ticketStatus(t, env, CONFIDENCE.explicit) : fallback(ctx, 'O chamado escolhido não está entre os seus.');
    }
    case 'draft':
      return onDraft(input, env, ctx);
  }
}

export function runAgent(input: AgentInput, env: AgentEnv): AgentReply {
  const turn = route(input, env, env.conversation.agent ?? {});
  return { ...turn, decision: { trigger: triggerOf(input), ...turn.decision } };
}
