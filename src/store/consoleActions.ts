import type { DB, User } from '../data/types';
import { newMessage } from '../agent/runtime';
import { updateDB } from './store';

const findConv = (db: DB, id: string) => db.conversations.find((c) => c.id === id);
const firstName = (name: string) => name.split(' ')[0];

/** O analista assume: o agent pausa e o colaborador é avisado. */
export function assume(convId: string, analyst: User) {
  const now = new Date();
  updateDB((db) => {
    const c = findConv(db, convId);
    if (!c || c.status === 'closed') return;
    c.status = 'human';
    c.assigneeId = analyst.id;
    c.assignedAt = now.toISOString();
    c.lastReadAt = now.toISOString();
    c.pending = undefined;
    c.messages.push(
      newMessage({ author: 'event', text: `${analyst.name} assumiu · agent pausado`, event: { icon: 'headset', contactText: `${analyst.name} entrou na conversa` } }, now),
    );
    const t = db.tickets.find((x) => x.id === c.ticketId);
    if (t && t.status !== 'resolvido') {
      t.status = 'em_atendimento';
      t.assignee = analyst.name;
      t.assignedAt = now.toISOString();
    }
  });
}

/** Devolve ao Nexo Assist, que retoma a conversa. */
export function returnToAgent(convId: string) {
  const now = new Date();
  updateDB((db) => {
    const c = findConv(db, convId);
    if (!c || c.status === 'closed') return;
    const contact = db.users.find((u) => u.id === c.contactId);
    c.status = 'agent';
    c.assigneeId = undefined;
    c.assignedAt = undefined;
    c.confidence = undefined;
    c.handoff = undefined;
    c.waitingDeadline = undefined;
    c.agent = {};
    c.messages.push(newMessage({ author: 'event', text: 'Devolvida ao Nexo Assist', event: { icon: 'bot', contactText: 'O Nexo Assist voltou a atender' } }, now));
    c.messages.push(
      newMessage(
        {
          author: 'assistant',
          blocks: [
            {
              type: 'text',
              text: `Voltei por aqui${contact ? `, ${firstName(contact.name)}` : ''}. Posso ajudar com mais alguma coisa?`,
              choices: [
                { value: 'start:status', label: 'Ver meus chamados' },
                { value: 'start:problema', label: 'Relatar um problema' },
              ],
            },
          ],
        },
        now,
      ),
    );
    const t = db.tickets.find((x) => x.id === c.ticketId);
    if (t?.status === 'em_atendimento') t.status = 'em_andamento';
  });
}

export function closeConversation(convId: string, analyst: User) {
  const now = new Date();
  updateDB((db) => {
    const c = findConv(db, convId);
    if (!c || c.status === 'closed') return;
    c.status = 'closed';
    c.closedAt = now.toISOString();
    c.messages.push(
      newMessage({ author: 'event', text: `Atendimento encerrado por ${analyst.name}`, event: { icon: 'check', contactText: `${analyst.name} encerrou o atendimento` } }, now),
    );
    const t = db.tickets.find((x) => x.id === c.ticketId);
    if (t?.status === 'em_atendimento') t.status = 'em_andamento';
  });
}

export function sendAsAnalyst(convId: string, analyst: User, text: string) {
  const now = new Date();
  updateDB((db) => {
    const c = findConv(db, convId);
    if (!c || c.status !== 'human') return;
    c.messages.push(newMessage({ author: 'analyst', text, analyst: { name: analyst.name, team: analyst.team ?? 'Suporte' } }, now));
    c.analystTypingUntil = undefined;
    c.lastReadAt = now.toISOString();
    const t = db.tickets.find((x) => x.id === c.ticketId);
    if (t) t.updatedAt = now.toISOString();
  });
}

export function markRead(convId: string) {
  updateDB((db) => {
    const c = findConv(db, convId);
    if (c) c.lastReadAt = new Date().toISOString();
  });
}

export function markUnread(convId: string) {
  updateDB((db) => {
    const c = findConv(db, convId);
    const last = c?.messages.findLast((m) => m.author === 'contact');
    if (c && last) c.lastReadAt = new Date(Date.parse(last.at) - 1).toISOString();
  });
}

export function setAvailability(available: boolean) {
  updateDB((db) => {
    db.analystAvailable = available;
  });
}

let lastSignal = 0;
export function analystTyping(convId: string) {
  const now = Date.now();
  if (now - lastSignal < 2000) return;
  lastSignal = now;
  updateDB((db) => {
    const c = findConv(db, convId);
    if (c) c.analystTypingUntil = now + 4000;
  });
}
