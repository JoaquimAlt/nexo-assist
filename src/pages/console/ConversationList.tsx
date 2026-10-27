import { CheckCheck, Search } from 'lucide-react';
import type { Conversation, DB, User } from '../../data/types';
import type { Tone } from '../../data/labels';
import { setAvailability } from '../../store/consoleActions';
import { messageText, unreadCount, userById } from '../../store/selectors';
import { listTime } from '../../lib/time';
import { Avatar, StatusLabel } from '../../components/ui';

export type Filter = 'todas' | 'para_voce' | 'agent' | 'minhas';

const FILTERS: { key: Filter; label: string; showCount: boolean }[] = [
  { key: 'todas', label: 'Todas', showCount: false },
  { key: 'para_voce', label: 'Para você', showCount: true },
  { key: 'agent', label: 'Com o agent', showCount: true },
  { key: 'minhas', label: 'Minhas', showCount: true },
];

/** Linha de status da conversa na lista. */
export function conversationStatus(c: Conversation, me: User, db: DB, now: number): { tone: Tone; label: string } {
  switch (c.status) {
    case 'waiting': {
      if (c.ticketId) return { tone: 'red', label: `Transferida · ${c.ticketId}` };
      const min = c.waitingDeadline ? Math.round((Date.parse(c.waitingDeadline) - now) / 60_000) : undefined;
      if (min === undefined) return { tone: 'red', label: 'Transferida' };
      return { tone: 'red', label: min >= 0 ? `Transferida · contato em ${min} min` : `Transferida · atrasada ${-min} min` };
    }
    case 'help':
      return { tone: 'amber', label: `Agent pediu ajuda · confiança ${Math.round((c.confidence ?? 0) * 100)}%` };
    case 'human':
      return c.assigneeId === me.id
        ? { tone: 'blue', label: 'Você está atendendo' }
        : { tone: 'blue', label: `${userById(db, c.assigneeId)?.name ?? 'Analista'} atendendo` };
    case 'agent':
      return { tone: 'green', label: 'Agent atendendo' };
    case 'resolved':
      return { tone: 'gray', label: 'Resolvida pelo agent' };
    case 'closed':
      return { tone: 'gray', label: 'Encerrada' };
  }
}

export function ConversationList(props: {
  db: DB;
  me: User;
  now: number;
  conversations: Conversation[];
  counts: Record<Filter, number>;
  filter: Filter;
  onFilter: (f: Filter) => void;
  query: string;
  onQuery: (q: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { db, me, now, conversations, counts, filter, query, selectedId } = props;

  return (
    <section className="clist" aria-label="Conversas">
      <header className="clist-head">
        <h1>Conversas</h1>
        <button
          className={`pill ${db.analystAvailable ? 'pill-green' : 'pill-gray'} pill-btn`}
          onClick={() => setAvailability(!db.analystAvailable)}
          title="Alterar disponibilidade"
        >
          <span className={`dot ${db.analystAvailable ? 'dot-green' : 'dot-gray'}`} />
          {db.analystAvailable ? 'Disponível' : 'Ausente'}
        </button>
      </header>

      <label className="search">
        <Search size={16} />
        <input value={query} onChange={(e) => props.onQuery(e.target.value)} placeholder="Pesquisar conversa ou chamado" />
      </label>

      <div className="filters" role="tablist">
        {FILTERS.map((f) => (
          <button key={f.key} role="tab" aria-selected={filter === f.key} className={`filter ${filter === f.key ? 'is-active' : ''}`} onClick={() => props.onFilter(f.key)}>
            {f.label}
            {f.showCount && <span className="filter-count">{counts[f.key]}</span>}
          </button>
        ))}
      </div>

      <ul className="clist-items">
        {conversations.length === 0 && <li className="clist-empty muted">Nenhuma conversa aqui.</li>}
        {conversations.map((c) => {
          const contact = userById(db, c.contactId);
          if (!contact) return null;
          const last = c.messages.findLast((m) => m.author !== 'event');
          const unread = c.id === selectedId ? 0 : unreadCount(c);
          const typing = (c.contactTypingUntil ?? 0) > now;
          const status = conversationStatus(c, me, db, now);
          const time = typing ? 'agora' : listTime(last?.at ?? c.createdAt, now);

          return (
            <li key={c.id}>
              <button className={`citem ${c.id === selectedId ? 'is-active' : ''}`} onClick={() => props.onSelect(c.id)}>
                <Avatar user={contact} size={44} online={contact.online} />
                <span className="citem-body">
                  <span className="citem-row">
                    <span className="citem-name">{contact.name}</span>
                    <span className={`citem-time ${unread > 0 ? 'is-unread' : ''}`}>{time}</span>
                  </span>
                  <span className="citem-row">
                    <span className="citem-preview">
                      {typing ? (
                        <em className="typing-text">digitando…</em>
                      ) : last?.author === 'assistant' ? (
                        <>
                          <CheckCheck size={15} className="ticks" />
                          Nexo: {messageText(last)}
                        </>
                      ) : last?.author === 'analyst' ? (
                        <>Você: {last.text}</>
                      ) : (
                        last?.text
                      )}
                    </span>
                    {unread > 0 && <span className="unread">{unread}</span>}
                  </span>
                  <StatusLabel tone={status.tone} className="citem-status">
                    {status.label}
                  </StatusLabel>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
