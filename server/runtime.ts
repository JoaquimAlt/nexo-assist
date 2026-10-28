import type { AgentInput, Block, Conversation, DB, Message, Ticket, TicketDraft } from '../src/data/types';
import { HANDOFF_HOURS } from '../src/lib/sla';
import { MESSAGE_LIMIT } from '../src/lib/limits';
import { uid } from '../src/lib/id';
import { countMessages } from '../src/store/selectors';
import { CONFIDENCE, QUEUE, runAgent, triggerOf, type AgentEffect, type AgentReply } from '../src/agent/engine';
import { readDB, updateDB } from './db';
import { env } from './env';
import { interpret } from './llm';
import { peekNextIds, ticketService, withRetry } from './tickets';

/** Tentativas no sistema de chamados antes de desistir. */
const ATTEMPTS = 3;

/** Com modelo local, essa confiança nas regras dispensa o modelo (assunto reconhecido, palavra-chave clara). */
const RULES_ARE_ENOUGH = CONFIDENCE.topic;

/** Resposta "pensando" há mais que isso foi interrompida (função encerrada, servidor reiniciado). */
const STALE_PENDING_MS = 60_000;

export const newMessage = (partial: Omit<Message, 'id' | 'at'>, at = new Date()): Message => ({ id: uid(), at: at.toISOString(), ...partial });

const findConv = (db: DB, id: string) => db.conversations.find((c) => c.id === id);
const draftBlock = (m: Message | undefined) => m?.blocks?.find((b): b is Extract<Block, { type: 'draft' }> => b.type === 'draft');
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Abre uma conversa nova, a menos que a mais recente ainda esteja ativa. */
export async function startConversation(contactId: string) {
  await updateDB((db) => {
    const latest = db.conversations.filter((c) => c.contactId === contactId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (latest && latest.status !== 'closed') return;
    db.conversations.push({ id: uid(), contactId, status: 'agent', createdAt: new Date().toISOString(), messages: [], agent: {} });
  });
}

/** Encerra a conversa atual (pelo colaborador) e abre outra. */
export async function restartConversation(convId: string) {
  const contactId = await updateDB((db) => {
    const c = findConv(db, convId);
    if (!c || c.status === 'closed') return c?.contactId;
    if (c.messages.length === 0) return undefined;
    c.status = 'closed';
    c.closedAt = new Date().toISOString();
    c.pending = undefined;
    c.messages.push(newMessage({ author: 'event', text: 'Conversa encerrada pelo colaborador', event: { icon: 'check', contactText: 'Conversa encerrada' } }));
    return c.contactId;
  });
  if (contactId) await startConversation(contactId);
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

function setPending(convId: string, pending: Conversation['pending']) {
  return updateDB((db) => {
    const c = findConv(db, convId);
    if (c) c.pending = pending;
  });
}

function retryNotice(convId: string) {
  return (attempt: number) =>
    void updateDB((db) => {
      const c = findConv(db, convId);
      if (c?.pending) c.pending.notice = `O sistema de chamados não respondeu. Tentando de novo (${attempt}/${ATTEMPTS})…`;
    });
}

/** Mensagem do colaborador: registra, e se o agent estiver atendendo, gera a resposta. */
export async function sendToConversation(convId: string, input: AgentInput, echo?: string) {
  const startedAt = new Date();

  const contactId = await updateDB((db) => {
    const c = findConv(db, convId);
    if (!c || c.status === 'closed' || countMessages(c) >= MESSAGE_LIMIT) return undefined;
    if (c.pending && Date.now() - Date.parse(c.pending.startedAt) > c.pending.durationMs + STALE_PENDING_MS) c.pending = undefined;
    if (echo) c.messages.push(newMessage({ author: 'contact', text: echo.slice(0, 1000) }, startedAt));
    if (input.type === 'choice') markChoice(c, input.value, input.messageId, input.blockIndex);
    if (input.type === 'pick-ticket') {
      const b = c.messages.find((m) => m.id === input.messageId)?.blocks?.find((x) => x.type === 'ticket-picker');
      if (b?.type === 'ticket-picker') b.selected = input.ticketId;
    }
    if (c.status === 'resolved') c.status = 'agent';
    c.contactTypingUntil = undefined;
    if (c.status !== 'agent' || c.pending) return undefined;
    // Enquanto consulta o sistema de chamados e o modelo, mostra o "digitando".
    c.pending = { tools: input.type === 'text' ? ['entendendo a mensagem'] : [], startedAt: startedAt.toISOString(), durationMs: 20_000 };
    return c.contactId;
  });

  if (!contactId) return;

  let tickets: Ticket[];
  let failures: number;
  try {
    ({ value: tickets, failures } = await withRetry(() => ticketService.listByRequester(contactId), retryNotice(convId), ATTEMPTS));
  } catch {
    await failReply(convId, input, 'consultar seus chamados');
    return;
  }

  const db = await readDB();
  const c = findConv(db, convId);
  const user = db.users.find((u) => u.id === contactId);
  if (!c || !user || c.status !== 'agent') {
    await setPending(convId, undefined);
    return;
  }

  const envFor = async (conversation: Conversation) => ({
    user,
    tickets,
    conversation,
    now: new Date(),
    nextIds: await peekNextIds(),
    nextDraftId: `D-${(await readDB()).seq.draft}`,
  });

  // Botões e confirmações já dizem o que a pessoa quer: só as regras. Texto passa pelo modelo;
  // com modelo local (lento), só quando as regras não entenderam com segurança.
  let result = runAgent(input, await envFor(c));
  if (input.type === 'text') {
    if (env.modelOnlyWhenRulesUnsure && result.decision.confidence >= RULES_ARE_ENOUGH) {
      result = { ...result, decision: { ...result.decision, source: { kind: 'regras', note: 'As regras entenderam com segurança; o modelo não foi necessário.' } } };
    } else {
      const { interpretation, source } = await interpret({ text: input.text, user, tickets, conversation: c, context: c.agent ?? {}, now: new Date() });
      const fresh = findConv(await readDB(), convId);
      if (!fresh || fresh.status !== 'agent') {
        await setPending(convId, undefined);
        return;
      }
      result = runAgent(input, { ...(await envFor(fresh)), interpretation, source });
    }
  }

  const now = new Date();

  // O tempo de "pensar" acompanha as ferramentas, que aparecem uma a uma na interface.
  const durationMs = 500 + result.tools.length * 450 + Math.round(Math.random() * 300);
  await setPending(convId, { tools: result.tools, startedAt: now.toISOString(), durationMs });
  await wait(durationMs);
  await commitReply(convId, input, result, failures);
}

/** O sistema de chamados não respondeu: avisa, não altera nada e oferece tentar de novo. */
function failReply(convId: string, input: AgentInput, what: string) {
  return updateDB((db) => {
    const c = findConv(db, convId);
    if (!c) return;
    c.pending = undefined;
    if (c.status !== 'agent') return;
    c.messages.push(
      newMessage({
        author: 'assistant',
        blocks: [{ type: 'text', text: `Não consegui ${what}: o sistema de chamados está fora do ar agora. Nada foi alterado. Tente de novo em alguns segundos.` }],
        tools: ['sistema de chamados indisponível'],
        retry: input,
        decision: {
          trigger: triggerOf(input),
          intent: 'Falha no sistema de chamados',
          understood: [],
          action: 'Avisou da falha e ofereceu tentar de novo',
          confidence: CONFIDENCE.explicit,
          reasons: [
            `O sistema de chamados não respondeu em ${ATTEMPTS} tentativas seguidas.`,
            'Melhor avisar do que fingir que deu certo: nenhum chamado foi criado ou alterado.',
          ],
        },
      }),
    );
  });
}

function commitTarget(effect: AgentEffect, c: Conversation) {
  switch (effect.type) {
    case 'create-ticket':
      return 'criar o chamado';
    case 'add-note':
      return `atualizar o ${effect.ticketId}`;
    case 'reopen':
      return `reabrir o ${effect.ticketId}`;
    default:
      return c.ticketId ? `atualizar o ${c.ticketId}` : 'atualizar o chamado';
  }
}

async function commitReply(convId: string, input: AgentInput, result: AgentReply, fetchFailures: number) {
  const db = await readDB();
  const conv = findConv(db, convId);
  // Um analista pode ter assumido enquanto o agent pensava.
  if (!conv || conv.status !== 'agent') {
    await setPending(convId, undefined);
    return;
  }
  const contact = db.users.find((u) => u.id === conv.contactId);
  const author = contact?.name ?? 'Colaborador';
  const onRetry = retryNotice(convId);

  // Primeiro o sistema de chamados; a conversa só muda se ele aceitar.
  let failures = fetchFailures;
  let createdId: string | undefined;
  let transferFailed = false;
  for (const effect of result.effects) {
    try {
      if (effect.type === 'create-ticket') {
        const block = draftBlock(conv.messages.find((m) => m.id === effect.messageId));
        if (!block || block.state !== 'pending') continue;
        const { kind, title, description, category, priority } = block.draft;
        const r = await withRetry(() => ticketService.create(conv.contactId, { kind, title, description, category, priority }), onRetry, ATTEMPTS);
        createdId = r.value.id;
        failures += r.failures;
      } else if (effect.type === 'add-note') {
        failures += (await withRetry(() => ticketService.addNote(conv.contactId, effect.ticketId, author, effect.text), onRetry, ATTEMPTS)).failures;
      } else if (effect.type === 'reopen') {
        failures += (await withRetry(() => ticketService.reopen(conv.contactId, effect.ticketId, author, effect.text), onRetry, ATTEMPTS)).failures;
      } else if (effect.type === 'handoff') {
        const ticketId = createdId ?? effect.ticketId;
        // O status do chamado é secundário: a conversa vai para o analista mesmo se o sistema falhar.
        if (ticketId && !createdId) {
          try {
            failures += (await withRetry(() => ticketService.transfer(conv.contactId, ticketId), onRetry, ATTEMPTS)).failures;
          } catch {
            transferFailed = true;
          }
        }
      }
    } catch {
      await failReply(convId, input, commitTarget(effect, conv));
      return;
    }
  }

  const now = new Date();
  await updateDB((db) => {
    const c = findConv(db, convId);
    if (!c) return;
    c.pending = undefined;
    if (c.status !== 'agent') return;

    const reasons = [...result.decision.reasons];
    if (failures > 0) reasons.push(`O sistema de chamados falhou ${failures === 1 ? '1 vez' : `${failures} vezes`}; deu certo na nova tentativa.`);
    if (transferFailed) reasons.push('Não conseguiu atualizar o status do chamado no sistema; a conversa foi transferida mesmo assim.');
    const tools = failures > 0 ? [...result.tools, 'tentou de novo no sistema de chamados'] : result.tools;

    const previousAssistant = c.messages.findLast((m) => m.author === 'assistant');
    c.messages.push(
      newMessage({ author: 'assistant', blocks: result.blocks, tools: tools.length ? tools : undefined, decision: { ...result.decision, reasons } }, now),
    );
    c.agent = result.context;
    if (result.blocks.some((b) => b.type === 'draft')) db.seq.draft++;
    for (const effect of result.effects) applyEffect(c, effect, now, createdId, previousAssistant);
  });
}

/** Efeitos na conversa. Os do sistema de chamados já foram aplicados pelo serviço. */
function applyEffect(c: Conversation, effect: AgentEffect, now: Date, createdId: string | undefined, previousAssistant?: Message) {
  switch (effect.type) {
    case 'handoff': {
      const ticketId = createdId ?? effect.ticketId;
      const help = effect.lowConfidence !== undefined;
      c.status = help ? 'help' : 'waiting';
      c.confidence = effect.lowConfidence;
      c.queue = QUEUE;
      c.waitingSince = now.toISOString();
      c.waitingDeadline = effect.dueAt ?? new Date(now.getTime() + HANDOFF_HOURS * 3_600_000).toISOString();
      c.handoff = effect.summary;
      if (ticketId) c.ticketId = ticketId;
      // O analista vê como não lidas as mensagens desde a penúltima resposta do agent.
      c.lastReadAt = previousAssistant?.at;
      c.messages.push(
        help
          ? newMessage(
              { author: 'event', text: `Agent pediu ajuda · confiança ${Math.round((effect.lowConfidence ?? 0) * 100)}%`, event: { icon: 'alert', contactText: 'Chamamos um analista para ajudar' } },
              now,
            )
          : newMessage({ author: 'event', text: `Transferida para ${QUEUE}`, event: { icon: 'transfer', contactText: `Transferida para o ${QUEUE}` } }, now),
      );
      break;
    }
    case 'create-ticket': {
      const block = draftBlock(c.messages.find((m) => m.id === effect.messageId));
      if (!block || block.state !== 'pending' || !createdId) return;
      block.state = 'confirmed';
      block.ticketId = createdId;
      c.ticketId = createdId;
      break;
    }
    case 'cancel-draft': {
      const block = draftBlock(c.messages.find((m) => m.id === effect.messageId));
      if (block) block.state = 'cancelled';
      break;
    }
    case 'reopen':
      c.ticketId = effect.ticketId;
      break;
    case 'add-note':
      break;
    case 'mark-choice':
      markChoice(c, effect.value);
      break;
    case 'resolve':
      c.status = 'resolved';
      break;
  }
}

/** Salva a edição do rascunho feita no cartão. */
export async function updateDraft(convId: string, messageId: string, draft: TicketDraft) {
  await updateDB((db) => {
    const c = findConv(db, convId);
    const block = draftBlock(c?.messages.find((m) => m.id === messageId));
    if (block && block.state === 'pending') block.draft = draft;
  });
}

const lastTypingSignal = new Map<string, number>();

/** Avisa o analista que o colaborador está digitando (com limite de frequência). */
export async function contactTyping(convId: string) {
  const now = Date.now();
  if (now - (lastTypingSignal.get(convId) ?? 0) < 2000) return;
  lastTypingSignal.set(convId, now);
  await updateDB((db) => {
    const c = findConv(db, convId);
    if (c) c.contactTypingUntil = now + 4000;
  });
}
