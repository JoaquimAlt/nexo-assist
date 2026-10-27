import type { Block, Conversation, DB, Message, TicketDraft } from '../data/types';
import { getDB, updateDB } from '../store/store';
import { HANDOFF_HOURS } from '../lib/sla';
import { uid } from '../lib/id';
import { QUEUE, runAgent, type AgentEffect, type AgentInput, type AgentReply } from './engine';

/** Limite de mensagens por conversa (colaborador + respostas). */
export const MESSAGE_LIMIT = 30;

export const newMessage = (partial: Omit<Message, 'id' | 'at'>, at = new Date()): Message => ({ id: uid(), at: at.toISOString(), ...partial });

const findConv = (db: DB, id: string) => db.conversations.find((c) => c.id === id);
const draftBlock = (m: Message | undefined) => m?.blocks?.find((b): b is Extract<Block, { type: 'draft' }> => b.type === 'draft');

/** Abre uma conversa nova, a menos que a mais recente ainda esteja ativa. */
export function startConversation(contactId: string) {
  updateDB((db) => {
    const latest = db.conversations.filter((c) => c.contactId === contactId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (latest && latest.status !== 'closed') return;
    db.conversations.push({ id: uid(), contactId, status: 'agent', createdAt: new Date().toISOString(), messages: [], agent: {} });
  });
}

/** Encerra a conversa atual (pelo colaborador) e abre outra. */
export function restartConversation(convId: string) {
  updateDB((db) => {
    const c = findConv(db, convId);
    if (!c || c.status === 'closed') return;
    if (c.messages.length === 0) return;
    c.status = 'closed';
    c.closedAt = new Date().toISOString();
    c.pending = undefined;
    c.messages.push(newMessage({ author: 'event', text: 'Conversa encerrada pelo colaborador', event: { icon: 'check', contactText: 'Conversa encerrada' } }));
  });
  const c = findConv(getDB(), convId);
  if (c) startConversation(c.contactId);
}

function nextTicketId(db: DB) {
  let n = db.seq.inc;
  while (db.tickets.some((t) => t.id === `INC-${n}`)) n++;
  return `INC-${n}`;
}

function markChoice(c: Conversation, value: string, messageId?: string, blockIndex?: number) {
  if (messageId !== undefined && blockIndex !== undefined) {
    const b = c.messages.find((m) => m.id === messageId)?.blocks?.[blockIndex];
    if (b?.type === 'text' && !b.chosen) b.chosen = value;
    return;
  }
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const b = c.messages[i].blocks?.find((x) => x.type === 'text' && x.choices?.some((ch) => ch.value === value));
    if (b?.type === 'text') {
      b.chosen ??= value;
      return;
    }
  }
}

/** Mensagem do colaborador: registra, e se o agent estiver atendendo, gera a resposta. */
export function sendToConversation(convId: string, input: AgentInput, echo?: string) {
  const now = new Date();
  let agentTurn = false as boolean;

  updateDB((db) => {
    const c = findConv(db, convId);
    if (!c || c.status === 'closed') return;
    if (echo) c.messages.push(newMessage({ author: 'contact', text: echo }, now));
    if (input.type === 'choice') markChoice(c, input.value, input.messageId, input.blockIndex);
    if (input.type === 'pick-ticket') {
      const b = c.messages.find((m) => m.id === input.messageId)?.blocks?.find((x) => x.type === 'ticket-picker');
      if (b?.type === 'ticket-picker') b.selected = input.ticketId;
    }
    if (c.status === 'resolved') c.status = 'agent';
    c.contactTypingUntil = undefined;
    agentTurn = c.status === 'agent' && !c.pending;
  });

  if (!agentTurn) return;

  const db = getDB();
  const c = findConv(db, convId)!;
  const user = db.users.find((u) => u.id === c.contactId)!;
  const result = runAgent(input, {
    user,
    tickets: db.tickets.filter((t) => t.requesterId === user.id),
    conversation: c,
    now,
    nextTicketId: nextTicketId(db),
    nextDraftId: `D-${db.seq.draft}`,
  });

  // O tempo de "pensar" acompanha as ferramentas, que aparecem uma a uma na interface.
  const durationMs = 700 + result.tools.length * 650 + Math.round(Math.random() * 400);
  updateDB((db) => {
    const conv = findConv(db, convId);
    if (conv) conv.pending = { tools: result.tools, startedAt: now.toISOString(), durationMs };
  });
  window.setTimeout(() => commitReply(convId, result), durationMs);
}

function commitReply(convId: string, result: AgentReply) {
  const now = new Date();
  updateDB((db) => {
    const c = findConv(db, convId);
    if (!c) return;
    c.pending = undefined;
    // Um analista pode ter assumido enquanto o agent pensava.
    if (c.status !== 'agent') return;

    const previousAssistant = c.messages.findLast((m) => m.author === 'assistant');
    c.messages.push(
      newMessage({ author: 'assistant', blocks: result.blocks, tools: result.tools.length ? result.tools : undefined, decision: result.decision }, now),
    );
    c.agent = result.context;
    if (result.blocks.some((b) => b.type === 'draft')) db.seq.draft++;
    for (const effect of result.effects) applyEffect(db, c, effect, now, previousAssistant);
  });
}

function applyEffect(db: DB, c: Conversation, effect: AgentEffect, now: Date, previousAssistant?: Message) {
  const contact = db.users.find((u) => u.id === c.contactId);

  switch (effect.type) {
    case 'handoff': {
      c.status = 'waiting';
      c.queue = QUEUE;
      c.waitingSince = now.toISOString();
      c.waitingDeadline = new Date(now.getTime() + HANDOFF_HOURS * 3_600_000).toISOString();
      if (effect.ticketId) c.ticketId = effect.ticketId;
      // O analista vê como não lidas as mensagens desde a penúltima resposta do agent.
      c.lastReadAt = previousAssistant?.at;
      c.messages.push(newMessage({ author: 'event', text: `Transferida para ${QUEUE}`, event: { icon: 'transfer', contactText: `Transferida para o ${QUEUE}` } }, now));
      const t = db.tickets.find((x) => x.id === effect.ticketId);
      if (t && t.status !== 'resolvido' && t.status !== 'aprovado') t.status = 'aguardando_analista';
      break;
    }
    case 'create-ticket': {
      const block = draftBlock(c.messages.find((m) => m.id === effect.messageId));
      if (!block || block.state !== 'pending') return;
      const id = db.tickets.some((t) => t.id === effect.ticketId) ? nextTicketId(db) : effect.ticketId;
      const d = block.draft;
      db.tickets.push({
        id,
        title: d.title,
        description: d.description,
        category: d.category,
        priority: d.priority,
        status: 'aguardando_analista',
        requesterId: c.contactId,
        openedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        notes: [],
      });
      db.seq.inc = Number(id.split('-')[1]) + 1;
      block.state = 'confirmed';
      block.ticketId = id;
      c.ticketId = id;
      break;
    }
    case 'cancel-draft': {
      const block = draftBlock(c.messages.find((m) => m.id === effect.messageId));
      if (block) block.state = 'cancelled';
      break;
    }
    case 'add-note': {
      const t = db.tickets.find((x) => x.id === effect.ticketId);
      t?.notes.push({ at: now.toISOString(), author: contact?.name ?? 'Colaborador', text: effect.text });
      break;
    }
    case 'mark-choice':
      markChoice(c, effect.value);
      break;
    case 'resolve':
      c.status = 'resolved';
      break;
  }
}

/** Salva a edição do rascunho feita no cartão. */
export function updateDraft(convId: string, messageId: string, draft: TicketDraft) {
  updateDB((db) => {
    const c = findConv(db, convId);
    const block = draftBlock(c?.messages.find((m) => m.id === messageId));
    if (block && block.state === 'pending') block.draft = draft;
  });
}

/** Resposta que ficou pendente quando a aba foi fechada no meio do "pensar". */
export function recoverStale(convId: string) {
  const c = findConv(getDB(), convId);
  if (!c?.pending) return;
  if (Date.now() - Date.parse(c.pending.startedAt) < c.pending.durationMs + 3000) return;
  updateDB((db) => {
    const conv = findConv(db, convId);
    if (conv) conv.pending = undefined;
  });
}

const lastTypingSignal = new Map<string, number>();

/** Avisa o analista que o colaborador está digitando (com limite de frequência). */
export function contactTyping(convId: string) {
  const now = Date.now();
  if (now - (lastTypingSignal.get(convId) ?? 0) < 2000) return;
  lastTypingSignal.set(convId, now);
  updateDB((db) => {
    const c = findConv(db, convId);
    if (c) c.contactTypingUntil = now + 4000;
  });
}
