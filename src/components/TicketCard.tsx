import type { Ticket } from '../data/types';
import { PRIORITY, TICKET_STATUS } from '../data/labels';
import { isOverdue } from '../lib/sla';
import { calendarDaysBetween, dayMonthTime, hhmm, relDays } from '../lib/time';
import { Dot, StatusLabel } from './ui';

/** Cartão completo de um chamado, usado na conversa do colaborador. */
export function TicketCard({ ticket, now }: { ticket: Ticket; now: number }) {
  const status = TICKET_STATUS[ticket.status];
  const priority = PRIORITY[ticket.priority];
  const overdue = isOverdue(ticket, now);
  const updated = relDays(calendarDaysBetween(ticket.updatedAt, now));

  return (
    <article className="card tcard">
      <div className="tcard-top">
        <span className="muted">
          Chamado <span className="sep">·</span> {ticket.id}
        </span>
        <StatusLabel tone={status.tone}>{status.label}</StatusLabel>
      </div>
      <h3 className="tcard-title">{ticket.title}</h3>
      <p className="tcard-desc">{ticket.description}</p>
      <dl className="tcard-grid cols-4">
        <div>
          <dt>Categoria</dt>
          <dd>{ticket.category}</dd>
        </div>
        <div>
          <dt>Prioridade</dt>
          <dd>
            <Dot tone={priority.tone} /> {priority.label}
          </dd>
        </div>
        <div>
          <dt>Aberto em</dt>
          <dd>{dayMonthTime(ticket.openedAt)}</dd>
        </div>
        <div>
          <dt>Última atualização</dt>
          <dd>
            {overdue ? (
              <>
                <span className="tone-amber-text">{updated}</span> <span className="muted small">· prazo vencido</span>
              </>
            ) : (
              updated
            )}
          </dd>
        </div>
      </dl>
      {ticket.notes.length > 0 && (
        <ul className="tcard-notes">
          {ticket.notes.map((n, i) => (
            <li key={i}>
              <span className="muted small">
                {n.author} · {hhmm(n.at)}
              </span>
              {n.text}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
