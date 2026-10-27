import type { Conversation, DB, Message } from '../data/types';

export const userById = (db: DB, id: string | undefined) => db.users.find((u) => u.id === id);
export const ticketById = (db: DB, id: string | undefined) => db.tickets.find((t) => t.id === id);

/** Conversa mais recente do colaborador. */
export function activeConversation(db: DB, contactId: string) {
  return db.conversations
    .filter((c) => c.contactId === contactId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export const lastActivity = (c: Conversation) => c.messages.at(-1)?.at ?? c.createdAt;

export const isPausedForHuman = (c: Conversation) => c.status === 'waiting' || c.status === 'help' || c.status === 'human';

export function unreadCount(c: Conversation) {
  if (!isPausedForHuman(c)) return 0;
  const since = c.lastReadAt ?? '';
  return c.messages.filter((m) => m.author === 'contact' && m.at > since).length;
}

/** Conversas que pedem ação do analista: na fila, com pedido de ajuda ou assumidas por ele. */
export const needsHuman = (c: Conversation, analystId: string) =>
  c.status === 'waiting' || c.status === 'help' || (c.status === 'human' && c.assigneeId === analystId);

/** Mensagens que contam para o limite da sessão (eventos não contam). */
export const countMessages = (c: Conversation) => c.messages.filter((m) => m.author !== 'event').length;

/** Texto corrido de uma mensagem, para prévia e busca. */
export function messageText(m: Message): string {
  if (m.text) return m.text;
  return (m.blocks ?? [])
    .map((b) => {
      if (b.type === 'text') return [b.text, b.question].filter(Boolean).join(' ');
      if (b.type === 'draft') return `Rascunho ${b.draft.id}: ${b.draft.title}`;
      if (b.type === 'ticket') return `Chamado ${b.ticketId}`;
      return '';
    })
    .filter(Boolean)
    .join(' ');
}
