import type { Affected, AgentContext, Block, Choice, Conversation, Priority, ProblemInfo, Ticket, TicketDraft, User } from '../data/types';
import { PRIORITY, TICKET_STATUS } from '../data/labels';
import { HANDOFF_HOURS, UPDATE_SLA_DAYS, isOverdue, responseDeadline } from '../lib/sla';
import { calendarDaysBetween, dayMonth, ddmm, hhmm, hourLabel, plural, relDays } from '../lib/time';

/**
 * Motor do Nexo Assist. Função pura: recebe a entrada do colaborador e o
 * contexto, devolve as ferramentas usadas, os blocos da resposta e os
 * efeitos a aplicar (transferir, criar chamado...). Quem aplica é o runtime.
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
}

export const QUEUE = 'Suporte N2';

export const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

const firstName = (u: User) => u.name.split(' ')[0];

function reply(blocks: Block[], context: AgentContext, extra: Partial<Pick<AgentReply, 'tools' | 'effects'>> = {}): AgentReply {
  return { tools: [], effects: [], ...extra, blocks, context };
}

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

function greet(env: AgentEnv): AgentReply {
  return reply(
    [text(`Olá, ${firstName(env.user)}! Posso consultar seus chamados, abrir um novo ou chamar um analista. O que está acontecendo?`, undefined, START)],
    {},
  );
}

function fallback(ctx: AgentContext): AgentReply {
  return reply([text('Não entendi bem. Posso consultar seus chamados, abrir um novo ou chamar um analista.', undefined, START)], ctx);
}

function handoff(env: AgentEnv, ctx: AgentContext): AgentReply {
  const ticketId = ctx.focusTicketId ?? env.conversation.ticketId;
  return reply(
    [text(`Encaminhei para o ${QUEUE}. Um analista vai falar com você em até ${HANDOFF_HOURS} h úteis.`)],
    { focusTicketId: ticketId },
    { effects: [{ type: 'handoff', ticketId }] },
  );
}

function listTickets(env: AgentEnv): AgentReply {
  const open = env.tickets.filter((t) => t.status !== 'resolvido').sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  const tools = ['consultou seus chamados'];
  if (open.length === 0) {
    return reply([text('Você não tem chamados abertos. Quer relatar um problema?', undefined, START.slice(1))], {}, { tools });
  }
  if (open.length === 1) {
    const r = ticketStatus(open[0], env);
    return { ...r, tools: [...tools, ...r.tools] };
  }
  return reply(
    [text(`Você tem ${open.length} chamados abertos. Sobre qual deles quer saber?`), { type: 'ticket-picker', ticketIds: open.map((t) => t.id) }],
    {},
    { tools },
  );
}

const TK_ANALYST: Choice = { value: 'tk:analista', label: 'Falar com um analista' };
const TK_INFO: Choice = { value: 'tk:info', label: 'Adicionar informação' };
const TK_NO: Choice = { value: 'tk:nao', label: 'Não, obrigado' };

function ticketStatus(t: Ticket, env: AgentEnv): AgentReply {
  const tools = [`consultou o ${t.id}`, 'calculou o prazo'];
  const days = calendarDaysBetween(t.updatedAt, env.now);
  const sla = UPDATE_SLA_DAYS[t.priority];
  const priority = PRIORITY[t.priority].label.toLowerCase();

  let tail: Block;
  if (t.status === 'resolvido') {
    tail = text(
      `Esse chamado foi resolvido em ${dayMonth(t.resolvedAt ?? t.updatedAt)}. Se o problema voltou, posso chamar um analista.`,
      undefined,
      [TK_ANALYST, { value: 'tk:nao', label: 'Está tudo certo' }],
    );
  } else if (t.status === 'aprovado') {
    tail = text('Sua solicitação foi aprovada. A equipe de suprimentos entra em contato para combinar a entrega.', undefined, [TK_INFO, TK_NO]);
  } else if (isOverdue(t, env.now)) {
    tail = text(
      `Está sem atualização há ${days} dias, acima do prazo de ${sla} ${plural(sla, 'dia útil', 'dias úteis')} para prioridade ${priority}. Quer que eu chame um analista?`,
      undefined,
      [TK_ANALYST, TK_INFO, TK_NO],
    );
  } else {
    const where = t.status === 'aguardando_analista' ? `Está na fila do ${QUEUE}` : 'Um analista está cuidando dele';
    tail = text(`${where}, dentro do prazo — última atualização ${relDays(days)}. Quer acrescentar alguma informação?`, undefined, [TK_INFO, TK_ANALYST, TK_NO]);
  }

  return reply([{ type: 'ticket', ticketId: t.id }, tail], { focusTicketId: t.id }, { tools });
}

function addNote(ticketId: string, raw: string): AgentReply {
  return reply(
    [text(`Adicionei ao ${ticketId}. Quer que eu chame um analista também?`, undefined, [{ value: 'tk:analista', label: 'Sim, chamar analista' }, { value: 'tk:nao', label: 'Não precisa' }])],
    { focusTicketId: ticketId },
    { tools: [`atualizou o ${ticketId}`], effects: [{ type: 'add-note', ticketId, text: raw.trim() }] },
  );
}

function problem(raw: string, env: AgentEnv, skipExisting: boolean): AgentReply {
  const n = normalize(raw);
  const topic = detectTopic(n);
  const info: ProblemInfo = { text: raw.trim(), topic: topic.key };

  if (!skipExisting && topic !== OTHER) {
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
        { tools: ['consultou seus chamados'] },
      );
    }
  }

  const tools = skipExisting ? ['buscou na central de ajuda'] : ['consultou seus chamados', 'buscou na central de ajuda'];
  const kb = topic.kb?.(n, errorCode(n));
  const os = env.user.os;

  if (kb && (!kb.os || kb.os === os)) {
    const steps = kb.steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
    return reply(
      [text(`Encontrei na central de ajuda “${kb.title}”:\n${steps}`, 'Isso resolveu?', [{ value: 'kb:ok', label: 'Resolveu' }, { value: 'kb:no', label: 'Não resolveu' }])],
      { problem: info, awaiting: 'kb' },
      { tools },
    );
  }

  const kbNote = kb ? `o artigo ${kb.ref} vale só para ${kb.os} — o seu é ${os}` : 'não encontrei solução na central de ajuda para esse caso';
  const lead = skipExisting
    ? `Entendi, é outro problema. ${kbNote[0].toUpperCase()}${kbNote.slice(1)}.`
    : `Não há chamado aberto sobre ${topic.label}, e ${kbNote}.`;

  return reply([text(`${lead} Vou abrir um chamado.`, 'Quem está sendo afetado?', AFFECTED_CHOICES)], { problem: info, awaiting: 'affected' }, { tools });
}

export function buildDraft(p: ProblemInfo, affected: Affected, env: AgentEnv): AgentReply {
  const n = normalize(p.text);
  const full = normalize(`${p.text} ${p.extra ?? ''}`);
  const topic = topicByKey(p.topic);

  let priority: Priority = 'media';
  let reason = '';
  if (affected === 'empresa') {
    priority = 'critica';
    reason = 'porque afeta a empresa toda';
  } else {
    if (affected === 'equipe') {
      priority = 'alta';
      reason = 'porque afeta sua equipe';
    }
    const urgency = URGENCY.find((u) => u.re.test(full));
    if (urgency) {
      priority = 'alta';
      reason = urgency.reason;
    }
  }

  const deadline = responseDeadline(priority, env.now);
  const limit = extractTime(full, env.now);
  const sla = limit && deadline <= limit ? `a resposta chega antes das ${hourLabel(limit)}` : `resposta até ${hhmm(deadline)}`;

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
      text(`Coloquei prioridade ${PRIORITY[priority].label.toLowerCase()}${reason ? ` ${reason}` : ''} — ${sla}.\nConfira antes de eu criar:`),
      { type: 'draft', draft, state: 'pending' },
    ],
    { problem: p },
    { tools: ['classificou a prioridade', 'consultou o SLA', 'montou o rascunho'], effects: [{ type: 'mark-choice', value: `aff:${affected}` }] },
  );
}

// ---------------------------------------------------------------------------
// Entradas

const isAnalystIntent = (n: string) => /\b(analista|atendente|humano|tecnico|pessoa de verdade|falar com alguem)\b/.test(n);

function onText(raw: string, env: AgentEnv, ctx: AgentContext): AgentReply {
  const n = normalize(raw);

  if (ctx.awaiting === 'note' && ctx.focusTicketId) return addNote(ctx.focusTicketId, raw);

  const id = n.match(/\b(inc|req)-?\s?(\d{4,6})\b/);
  if (id) {
    const ticketId = `${id[1].toUpperCase()}-${id[2]}`;
    const t = env.tickets.find((x) => x.id === ticketId);
    if (t) return ticketStatus(t, env);
    const r = listTickets(env);
    return { ...r, blocks: [text(`Não encontrei o ${ticketId} entre os seus chamados.`), ...r.blocks] };
  }

  if (ctx.awaiting === 'affected' && ctx.problem) {
    const affected = detectAffected(n);
    const p: ProblemInfo = { ...ctx.problem, extra: [ctx.problem.extra, raw.trim()].filter(Boolean).join(' ') };
    if (affected) return buildDraft(p, affected, env);
    if (!isAnalystIntent(n)) {
      return reply([text('Anotado. Só pra classificar a prioridade:', 'Quem está sendo afetado?', AFFECTED_CHOICES)], { ...ctx, problem: p });
    }
  }

  if (isAnalystIntent(n)) return handoff(env, ctx);
  if (/\b(status|andamento|situacao)\b|\bmeus? chamados?\b|\bchamados? abertos?\b/.test(n)) return listTickets(env);
  if (/^(obrigad|valeu|vlw|brigad|resolveu|deu certo|funcionou|perfeito)/.test(n)) {
    return reply([text(`Por nada, ${firstName(env.user)}! Se precisar, é só escrever.`)], {});
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
      { tools: ['buscou na central de ajuda'] },
    );
  }
  if (n.split(/\s+/).length >= 3) return problem(raw, env, false);
  return fallback(ctx);
}

function onChoice(value: string, env: AgentEnv, ctx: AgentContext): AgentReply {
  const [kind, arg] = value.split(':');

  if (kind === 'start') {
    if (arg === 'status') return listTickets(env);
    if (arg === 'analista') return handoff(env, ctx);
    return reply([text('Claro. Descreva o que está acontecendo — se aparecer um código de erro, inclua ele.')], {});
  }

  if (kind === 'aff' && ctx.problem) return buildDraft(ctx.problem, arg as Affected, env);

  if (kind === 'kb' && ctx.problem) {
    if (arg === 'ok') {
      return reply([text('Que bom que resolveu! Vou encerrar por aqui — se voltar a acontecer, é só escrever.')], {}, { effects: [{ type: 'resolve' }] });
    }
    return reply([text('Entendi. Vou abrir um chamado então.', 'Quem está sendo afetado?', AFFECTED_CHOICES)], { ...ctx, awaiting: 'affected' });
  }

  if (kind === 'tk') {
    const id = ctx.focusTicketId;
    if (arg === 'analista') return handoff(env, ctx);
    if (arg === 'info' && id) return reply([text(`Claro. O que quer acrescentar ao ${id}?`)], { focusTicketId: id, awaiting: 'note' });
    if (arg === 'add' && id && ctx.problem) return addNote(id, ctx.problem.text);
    if (arg === 'novo' && ctx.problem) return problem(ctx.problem.text, env, true);
    if (arg === 'nao') return reply([text('Certo! Se precisar de mais alguma coisa, é só escrever.')], {});
  }

  return fallback(ctx);
}

function onDraft(input: Extract<AgentInput, { type: 'draft' }>, env: AgentEnv, ctx: AgentContext): AgentReply {
  const msg = env.conversation.messages.find((m) => m.id === input.messageId);
  const block = msg?.blocks?.find((b): b is Extract<Block, { type: 'draft' }> => b.type === 'draft');
  if (!block || block.state !== 'pending') return fallback(ctx);

  if (input.action === 'cancel') {
    return reply([text('Tudo bem, descartei o rascunho. Se mudar de ideia, é só descrever o problema de novo.')], {}, {
      effects: [{ type: 'cancel-draft', messageId: input.messageId }],
    });
  }

  const d = block.draft;
  const id = env.nextTicketId;
  return reply(
    [text(`Pronto: abri o ${id} com prioridade ${PRIORITY[d.priority].label.toLowerCase()}. Um analista responde até ${hhmm(responseDeadline(d.priority, env.now))} — você acompanha tudo por aqui.`)],
    { focusTicketId: id },
    { tools: ['criou o chamado'], effects: [{ type: 'create-ticket', messageId: input.messageId, ticketId: id }] },
  );
}

export function runAgent(input: AgentInput, env: AgentEnv): AgentReply {
  const ctx = env.conversation.agent ?? {};
  switch (input.type) {
    case 'text':
      return onText(input.text, env, ctx);
    case 'choice':
      return onChoice(input.value, env, ctx);
    case 'pick-ticket': {
      const t = env.tickets.find((x) => x.id === input.ticketId);
      return t ? ticketStatus(t, env) : fallback(ctx);
    }
    case 'draft':
      return onDraft(input, env, ctx);
  }
}
