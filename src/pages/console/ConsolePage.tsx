import { useEffect, useMemo, useState } from 'react';
import { LogOut, MessageCircle, RotateCcw } from 'lucide-react';
import type { Conversation } from '../../data/types';
import { logout, useCurrentUser } from '../../store/auth';
import { resetDB, useDB } from '../../store/store';
import { lastActivity, messageText, needsHuman, unreadCount, userById } from '../../store/selectors';
import { markRead } from '../../api/actions';
import { Avatar, LogoMark, Menu } from '../../components/ui';
import { useNow } from '../../lib/useNow';
import { ConversationList, type Filter } from './ConversationList';
import { ConversationPane } from './ConversationPane';
import { TicketPanel } from './TicketPanel';

const rank = (c: Conversation, me: string) => (needsHuman(c, me) ? 0 : c.status === 'agent' ? 1 : 2);

export default function ConsolePage() {
  const me = useCurrentUser()!;
  const db = useDB();
  const now = useNow(5000);
  const [filter, setFilter] = useState<Filter>('todas');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Abaixo de 1280px o painel vira sobreposição, então começa fechado.
  const [panelOpen, setPanelOpen] = useState(() => window.matchMedia('(min-width: 1281px)').matches);
  const [mobileChat, setMobileChat] = useState(false);

  const all = useMemo(
    () =>
      db.conversations
        .filter((c) => c.messages.length > 0)
        .sort((a, b) => rank(a, me.id) - rank(b, me.id) || lastActivity(b).localeCompare(lastActivity(a))),
    [db.conversations, me.id],
  );

  const counts: Record<Filter, number> = {
    todas: all.length,
    para_voce: all.filter((c) => needsHuman(c, me.id)).length,
    agent: all.filter((c) => c.status === 'agent').length,
    minhas: all.filter((c) => c.status === 'human' && c.assigneeId === me.id).length,
  };

  const visible = all.filter((c) => {
    if (filter === 'para_voce' && !needsHuman(c, me.id)) return false;
    if (filter === 'agent' && c.status !== 'agent') return false;
    if (filter === 'minhas' && !(c.status === 'human' && c.assigneeId === me.id)) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const contact = userById(db, c.contactId);
    return (
      contact?.name.toLowerCase().includes(q) ||
      c.ticketId?.toLowerCase().includes(q) ||
      c.messages.some((m) => messageText(m).toLowerCase().includes(q))
    );
  });

  const selected = all.find((c) => c.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId && all[0]) setSelectedId(all[0].id);
  }, [selectedId, all]);

  // Conversa aberta na tela conta como lida.
  const unreadSelected = selected ? unreadCount(selected) : 0;
  useEffect(() => {
    if (selected && unreadSelected > 0) markRead(selected.id);
  }, [selected, unreadSelected]);

  const attention = all.filter((c) => c.status === 'waiting' || c.status === 'help').length + all.reduce((n, c) => n + (c.id === selectedId ? 0 : unreadCount(c)), 0);

  return (
    <div className={`console ${panelOpen && selected ? 'with-panel' : ''} ${mobileChat ? 'mobile-chat' : ''}`}>
      <nav className="rail" aria-label="Navegação">
        <LogoMark size={22} className="rail-logo" />
        <button className="rail-btn is-active" aria-label="Conversas">
          <MessageCircle size={20} />
          {attention > 0 && <span className="rail-badge">{attention}</span>}
        </button>
        <div className="rail-spacer" />
        <Menu
          align="left"
          placement="above"
          trigger={(p) => (
            <button className="rail-me" aria-label="Sua conta" {...p}>
              <Avatar user={me} size={34} />
              <span className={`rail-presence ${db.analystAvailable ? 'is-on' : ''}`} />
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="menu-head">
                <strong>{me.name}</strong>
                <span className="muted small">
                  {me.team} · {me.email}
                </span>
              </div>
              <button className="menu-item" onClick={() => { close(); if (window.confirm('Restaurar as conversas e chamados de demonstração?')) resetDB(); }}>
                <RotateCcw size={15} /> Restaurar dados de demonstração
              </button>
              <button className="menu-item" onClick={logout}>
                <LogOut size={15} /> Sair
              </button>
            </>
          )}
        </Menu>
      </nav>

      <ConversationList
        db={db}
        me={me}
        now={now}
        conversations={visible}
        counts={counts}
        filter={filter}
        onFilter={setFilter}
        query={query}
        onQuery={setQuery}
        selectedId={selectedId}
        onSelect={(id) => {
          setSelectedId(id);
          setMobileChat(true);
        }}
      />

      {selected ? (
        <ConversationPane
          key={selected.id}
          conv={selected}
          db={db}
          me={me}
          panelOpen={panelOpen}
          onTogglePanel={() => setPanelOpen((o) => !o)}
          onBack={() => setMobileChat(false)}
        />
      ) : (
        <section className="pane pane-empty">
          <p className="muted">Selecione uma conversa.</p>
        </section>
      )}

      {selected && panelOpen && <TicketPanel conv={selected} db={db} now={now} onClose={() => setPanelOpen(false)} />}
    </div>
  );
}
