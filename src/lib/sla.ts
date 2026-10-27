import type { Priority, Ticket } from '../data/types';
import { businessDaysBetween } from './time';

/** Prazo de primeira resposta de um chamado novo, em horas. */
export const RESPONSE_HOURS: Record<Priority, number> = { critica: 1, alta: 2, media: 4, baixa: 8 };

/** Prazo máximo sem atualização de um chamado aberto, em dias úteis. */
export const UPDATE_SLA_DAYS: Record<Priority, number> = { critica: 1, alta: 2, media: 3, baixa: 5 };

/** Prazo para um analista falar com o colaborador depois da transferência. */
export const HANDOFF_HOURS = 2;

export function responseDeadline(priority: Priority, from: Date) {
  return new Date(from.getTime() + RESPONSE_HOURS[priority] * 3_600_000);
}

export function isOverdue(ticket: Ticket, now: Date | number) {
  if (ticket.status === 'resolvido' || ticket.status === 'aprovado') return false;
  return businessDaysBetween(ticket.updatedAt, now) > UPDATE_SLA_DAYS[ticket.priority];
}
