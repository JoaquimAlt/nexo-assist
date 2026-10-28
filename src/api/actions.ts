import type { AgentInput, TicketDraft, User } from '../data/types';
import { fire } from './client';

/**
 * Ações da interface. Todas vão para o servidor, que valida quem está pedindo
 * e devolve o resultado pelos eventos de mudança.
 */

// Colaborador

export const startConversation = () => fire('/conversations/start');

export const sendToConversation = (convId: string, input: AgentInput, echo?: string) => fire(`/conversations/${convId}/messages`, { input, echo });

export const restartConversation = (convId: string) => fire(`/conversations/${convId}/restart`);

export const updateDraft = (convId: string, messageId: string, draft: TicketDraft) => fire(`/conversations/${convId}/draft`, { messageId, draft });

const lastTyping = new Map<string, number>();

/** Avisa que a pessoa está digitando, no máximo a cada 2 s. */
function throttled(key: string, send: () => void) {
  const now = Date.now();
  if (now - (lastTyping.get(key) ?? 0) < 2000) return;
  lastTyping.set(key, now);
  send();
}

export const contactTyping = (convId: string) => throttled(`c:${convId}`, () => fire(`/conversations/${convId}/typing`));

// Analista (quem age é a pessoa da sessão; o parâmetro fica por clareza na chamada)

export const assume = (convId: string, _analyst: User) => fire(`/console/${convId}/assume`);
export const returnToAgent = (convId: string) => fire(`/console/${convId}/return`);
export const closeConversation = (convId: string, _analyst: User) => fire(`/console/${convId}/close`);
export const sendAsAnalyst = (convId: string, _analyst: User, text: string) => fire(`/console/${convId}/send`, { text });
export const markRead = (convId: string) => fire(`/console/${convId}/read`);
export const markUnread = (convId: string) => fire(`/console/${convId}/unread`);
export const setAvailability = (available: boolean) => fire('/console/availability', { available });
export const analystTyping = (convId: string) => throttled(`a:${convId}`, () => fire(`/console/${convId}/typing`));
