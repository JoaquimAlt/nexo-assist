import { useEffect, useState } from 'react';
import { ArrowLeftRight, ArrowUpRight, Bot, ChevronRight, Headphones, X } from 'lucide-react';
import type { Conversation, DB, Ticket } from '../../data/types';
import { PRIORITY, TICKET_STATUS, type Tone } from '../../data/labels';
import { userById } from '../../store/selectors';
import { isOverdue } from '../../lib/sla';
import { dayMonth, dayMonthTime, hhmm } from '../../lib/time';
import { Dot, StatusLabel } from '../../components/ui';

const ticketLine = (t: Ticket) => `${t.id} · ${t.status === 'resolvido' ? `Resolvido em ${dayMonth(t.resolvedAt ?? t.updatedAt)}` : TICKET_STATUS[t.status].label}`;

function TicketDetails({ t, now }: { t: Ticket; now: number }) {
  const p = PRIORITY[t.priority];
  return (
    <div className="tp-details">
      <p>{t.description}</p>
      <dl>
        <dt>Prioridade</dt>
        <dd>
          <Dot tone={p.tone} /> {p.label}
        </dd>
        <dt>Aberto em</dt>
        <dd>{dayMonthTime(t.openedAt)}</dd>
        <dt>Atualizado</dt>
        <dd>
          {dayMonthTime(t.updatedAt)}
          {isOverdue(t, now) && <span className="tone-amber-text"> · prazo vencido</span>}
        </dd>
        {t.assignee && (
          <>
            <dt>Responsável</dt>
            <dd>{t.assignee}</dd>
          </>
        )}
      </dl>
      {t.notes.length > 0 && (
        <ul className="tp-notes">
          {t.notes.map((n, i) => (
            <li key={i}>
              <span className="muted small">
                {n.author} · {dayMonthTime(n.at)}
              </span>
              {n.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TicketPanel({ conv, db, now, onClose }: { conv: Conversation; db: DB; now: number; onClose: () => void }) {
  const contact = userById(db, conv.contactId)!;
  const first = contact.name.split(' ')[0];
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!showAll) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setShowAll(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showAll]);

  const tickets = db.tickets.filter((t) => t.requesterId === contact.id).sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  const open = tickets.filter((t) => t.status !== 'resolvido');
  const current = tickets.find((t) => t.id === conv.ticketId);
  const others = tickets.filter((t) => t !== current).sort((a, b) => Number(a.status === 'resolvido') - Number(b.status === 'resolvido'));

  // O status do cartão reflete a conversa, não só o chamado.
  let currentStatus: { tone: Tone; label: string } | undefined;
  let currentFoot: { icon: typeof Bot; text: string; at?: string } | undefined;
  if (current) {
    if (conv.status === 'waiting' || conv.status === 'help') {
      currentStatus = { tone: 'amber', label: 'Aguardando analista' };
      currentFoot = { icon: ArrowLeftRight, text: 'Transferido para um analista', at: conv.waitingSince };
    } else if (conv.status === 'human') {
      currentStatus = { tone: 'blue', label: 'Em atendimento' };
      currentFoot = { icon: Headphones, text: `Assumido por ${userById(db, conv.assigneeId)?.name ?? 'analista'}`, at: conv.assignedAt };
    } else {
      currentStatus = TICKET_STATUS[current.status];
      currentFoot = { icon: Bot, text: 'Aberto pelo Nexo Assist', at: current.openedAt };
    }
  }

  return (
    <aside className="tpanel" aria-label={`Chamados de ${first}`}>
      <header className="tp-head">
        <div>
          <h2>Chamados de {first}</h2>
          <span className="muted small">
            {open.length} {open.length === 1 ? 'aberto' : 'abertos'} · {tickets.length - open.length} {tickets.length - open.length === 1 ? 'encerrado' : 'encerrados'}
          </span>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Fechar painel">
          <X size={18} />
        </button>
      </header>

      <div className="tp-scroll">
        <h3 className="tp-section">Desta conversa</h3>
        {current && currentStatus && currentFoot ? (
          <div className="tp-current">
            <div className="tp-current-top">
              <span className="muted small">{current.id}</span>
              <StatusLabel tone={currentStatus.tone} className="small">
                {currentStatus.label}
              </StatusLabel>
            </div>
            <strong className="tp-current-title">{current.shortTitle ?? current.title}</strong>
            <span className="muted small">
              {current.category.split(' › ')[0]} · prioridade {PRIORITY[current.priority].label.toLowerCase()}
            </span>
            <div className="tp-current-foot">
              <currentFoot.icon size={15} />
              <span>{currentFoot.text}</span>
              {currentFoot.at && <span className="muted">{hhmm(currentFoot.at)}</span>}
            </div>
          </div>
        ) : (
          <div className="tp-current tp-none muted small">Nenhum chamado vinculado a esta conversa.</div>
        )}

        {others.length > 0 && (
          <>
            <h3 className="tp-section">Outros chamados</h3>
            <ul className="tp-list">
              {others.map((t) => {
                const st = TICKET_STATUS[t.status];
                const isOpen = expanded === t.id;
                return (
                  <li key={t.id}>
                    <button className="tp-item" onClick={() => setExpanded(isOpen ? null : t.id)} aria-expanded={isOpen}>
                      <Dot tone={st.tone === 'gray' ? 'gray' : st.tone} />
                      <span className="tp-item-body">
                        <span className="tp-item-title">{t.shortTitle ?? t.title}</span>
                        <span className="muted small">{ticketLine(t)}</span>
                      </span>
                      <ChevronRight size={17} className={`chev ${isOpen ? 'is-open' : ''}`} />
                    </button>
                    {isOpen && <TicketDetails t={t} now={now} />}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      <footer className="tp-foot">
        <button className="btn btn-block" onClick={() => setShowAll(true)}>
          Ver todos os chamados de {first} <ArrowUpRight size={15} />
        </button>
      </footer>

      {showAll && (
        <div className="modal-backdrop" onClick={() => setShowAll(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-label={`Chamados de ${contact.name}`} onClick={(e) => e.stopPropagation()}>
            <header className="modal-head">
              <div>
                <h2>Chamados de {contact.name}</h2>
                <span className="muted small">
                  {contact.department} · {contact.email}
                </span>
              </div>
              <button className="icon-btn" onClick={() => setShowAll(false)} aria-label="Fechar">
                <X size={18} />
              </button>
            </header>
            <div className="modal-body">
              <table className="table">
                <thead>
                  <tr>
                    <th>Chamado</th>
                    <th>Título</th>
                    <th>Categoria</th>
                    <th>Prioridade</th>
                    <th>Status</th>
                    <th>Aberto em</th>
                  </tr>
                </thead>
                <tbody>
                  {tickets.map((t) => (
                    <tr key={t.id}>
                      <td className="mono">{t.id}</td>
                      <td>{t.title}</td>
                      <td>{t.category}</td>
                      <td>
                        <Dot tone={PRIORITY[t.priority].tone} /> {PRIORITY[t.priority].label}
                      </td>
                      <td>
                        <StatusLabel tone={TICKET_STATUS[t.status].tone}>{TICKET_STATUS[t.status].label}</StatusLabel>
                      </td>
                      <td>{dayMonth(t.openedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
