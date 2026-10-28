import type { Priority, Ticket } from '../data/types.js';
import { addBusinessDays, addBusinessHours } from './time.js';

/**
 * Prazos do service desk (Anexo A). O prazo vale para a primeira resposta e
 * para cada atualização; passado o prazo, o chamado está vencido.
 */
export const SLA: Record<Priority, { label: string; due: (from: Date) => Date }> = {
  critica: { label: '1 hora', due: (from) => new Date(from.getTime() + 3_600_000) },
  alta: { label: '4 horas úteis', due: (from) => addBusinessHours(from, 4) },
  media: { label: '3 dias úteis', due: (from) => addBusinessDays(from, 3) },
  baixa: { label: '5 dias úteis', due: (from) => addBusinessDays(from, 5) },
};

/** Prazo para um analista falar com o colaborador depois da transferência. */
export const HANDOFF_HOURS = 2;

/** Chamados resolvidos há até esse número de dias podem ser reabertos. */
export const REOPEN_DAYS = 7;

export function slaDeadline(priority: Priority, from: Date | string | number) {
  return SLA[priority].due(new Date(from));
}

export function isOverdue(ticket: Ticket, now: Date | number) {
  if (ticket.status === 'resolvido' || ticket.status === 'aprovado') return false;
  return new Date(now).getTime() > slaDeadline(ticket.priority, ticket.updatedAt).getTime();
}

export function canReopen(ticket: Ticket, now: Date | number) {
  if (ticket.status !== 'resolvido') return false;
  const resolved = Date.parse(ticket.resolvedAt ?? ticket.updatedAt);
  return new Date(now).getTime() - resolved <= REOPEN_DAYS * 86_400_000;
}
