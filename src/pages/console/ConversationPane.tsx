import { Fragment, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertCircle, ArrowLeft, ArrowLeftRight, Bot, CheckCheck, CircleCheck, CircleCheckBig, FileText, Hand, Headphones, ListChecks, MoreVertical, Search, SendHorizontal, X,
} from 'lucide-react';
import type { Block, Conversation, DB, EventIcon, Message, User } from '../../data/types';
import { TICKET_STATUS } from '../../data/labels';
import { analystTyping, assume, closeConversation, markUnread, returnToAgent, sendAsAnalyst } from '../../store/consoleActions';
import { messageText, ticketById, userById } from '../../store/selectors';
import { dayLabel, hhmm } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import { Avatar, Menu } from '../../components/ui';
import { DecisionDetails } from '../../components/DecisionDetails';

const EVENT_ICONS: Record<EventIcon, typeof Bot> = {
  transfer: ArrowLeftRight,
  headset: Headphones,
  bot: Bot,
  check: CircleCheck,
  alert: AlertCircle,
};

export function ConversationPane({ conv, db, me, panelOpen, onTogglePanel, onBack }: {
  conv: Conversation;
  db: DB;
  me: User;
  panelOpen: boolean;
  onTogglePanel: () => void;
  onBack: () => void;
}) {
  const now = useNow(1000);
  const contact = userById(db, conv.contactId)!;
  const first = contact.name.split(' ')[0];
  const scrollRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState('');

  const mine = conv.status === 'human' && conv.assigneeId === me.id;
  const typing = (conv.contactTypingUntil ?? 0) > now;
  const q = search.trim().toLowerCase();
  const hits = q ? conv.messages.filter((m) => messageText(m).toLowerCase().includes(q)).length : 0;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conv.messages.length, typing]);

  const send = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !mine) return;
    sendAsAnalyst(conv.id, me, text);
    setDraft('');
  };

  const sub = [contact.online ? 'online' : 'offline', contact.department, conv.ticketId].filter(Boolean).join(' · ');

  return (
    <section className="pane" aria-label={`Conversa com ${contact.name}`}>
      <header className="pane-head">
        <button className="icon-btn pane-back" onClick={onBack} aria-label="Voltar para a lista">
          <ArrowLeft size={18} />
        </button>
        <Avatar user={contact} size={40} />
        <div className="pane-who">
          <strong>{contact.name}</strong>
          <span className="muted small">{sub}</span>
        </div>

        <div className="pane-actions">
          {mine ? (
            <>
              <button className="btn btn-sm" onClick={() => returnToAgent(conv.id)}>
                <Bot size={15} /> Devolver ao agent
              </button>
              <button className="btn btn-sm btn-danger-soft" onClick={() => closeConversation(conv.id, me)}>
                <CircleCheckBig size={15} /> Encerrar atendimento
              </button>
            </>
          ) : conv.status === 'waiting' ? (
            <span className="pill pill-amber"><Bot size={14} /> Aguardando atendente</span>
          ) : conv.status === 'help' ? (
            <span className="pill pill-amber"><AlertCircle size={14} /> Agent pediu ajuda</span>
          ) : conv.status === 'agent' ? (
            <span className="pill pill-green"><Bot size={14} /> Agent atendendo</span>
          ) : conv.status === 'human' ? (
            <span className="pill pill-blue"><Headphones size={14} /> {userById(db, conv.assigneeId)?.name}</span>
          ) : (
            <span className="pill pill-gray"><CircleCheck size={14} /> Encerrada</span>
          )}
          <button className={`icon-btn ${searching ? 'is-on' : ''}`} onClick={() => { setSearching((s) => !s); setSearch(''); }} aria-label="Buscar na conversa">
            <Search size={18} />
          </button>
          <Menu
            trigger={(p) => (
              <button className="icon-btn" aria-label="Mais opções" {...p}>
                <MoreVertical size={18} />
              </button>
            )}
          >
            {(close) => (
              <>
                <button className="menu-item" onClick={() => { markUnread(conv.id); close(); }}>
                  Marcar como não lida
                </button>
                <button className="menu-item" onClick={() => { onTogglePanel(); close(); }}>
                  {panelOpen ? 'Ocultar chamados' : `Mostrar chamados de ${first}`}
                </button>
              </>
            )}
          </Menu>
        </div>
      </header>

      {searching && (
        <div className="pane-search">
          <Search size={15} />
          <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar nesta conversa" />
          {q && <span className="muted small">{hits} {hits === 1 ? 'resultado' : 'resultados'}</span>}
          <button className="icon-btn" onClick={() => { setSearching(false); setSearch(''); }} aria-label="Fechar busca">
            <X size={16} />
          </button>
        </div>
      )}

      <div className="pane-scroll" ref={scrollRef}>
        <div className="pane-msgs">
          {conv.messages.map((m, i) => {
            const prev = conv.messages[i - 1];
            const newDay = !prev || dayLabel(prev.at, now) !== dayLabel(m.at, now);
            const match = !q || messageText(m).toLowerCase().includes(q);
            return (
              <Fragment key={m.id}>
                {newDay && <div className="day-sep">{dayLabel(m.at, now)}</div>}
                <ConsoleMessage m={m} db={db} dim={!match} hit={!!q && match} />
              </Fragment>
            );
          })}
          {typing && (
            <div className="c-msg c-in">
              <div className="c-bubble c-typing">
                <span className="typing-dots"><i /><i /><i /></span>
              </div>
            </div>
          )}
        </div>
      </div>

      <footer className="pane-foot">
        {(conv.status === 'waiting' || conv.status === 'help') && (
          <div className="handoff">
            <span className="handoff-icon">{conv.status === 'help' ? <AlertCircle size={18} /> : <Hand size={18} />}</span>
            <div className="handoff-text">
              <strong>{conv.status === 'help' ? 'O agent pediu ajuda' : `${first} espera um atendente`}</strong>
              <span className="muted small">
                {conv.status === 'help'
                  ? `Confiança ${Math.round((conv.confidence ?? 0) * 100)}% · agent pausado${conv.waitingDeadline ? ` · até ${hhmm(conv.waitingDeadline)}` : ''}`
                  : `Agent pausado${conv.waitingDeadline ? ` · até ${hhmm(conv.waitingDeadline)}` : ''}`}
              </span>
            </div>
            <div className="handoff-actions">
              <button className="btn" onClick={() => returnToAgent(conv.id)}>
                <Bot size={16} /> Devolver ao agent
              </button>
              <button className="btn btn-primary" onClick={() => assume(conv.id, me)}>
                <Headphones size={16} /> Assumir atendimento
              </button>
            </div>
          </div>
        )}

        {conv.status === 'agent' && (
          <div className="handoff">
            <span className="handoff-icon handoff-green"><Bot size={18} /></span>
            <div className="handoff-text">
              <strong>Nexo Assist está atendendo</strong>
              <span className="muted small">Assuma se quiser intervir na conversa.</span>
            </div>
            <div className="handoff-actions">
              <button className="btn" onClick={() => assume(conv.id, me)}>
                <Headphones size={16} /> Assumir atendimento
              </button>
            </div>
          </div>
        )}

        {(conv.status === 'resolved' || conv.status === 'closed') && (
          <div className="handoff">
            <span className="handoff-icon handoff-gray"><CircleCheck size={18} /></span>
            <div className="handoff-text">
              <strong>Conversa encerrada</strong>
              <span className="muted small">
                {conv.status === 'resolved' ? 'Resolvida pelo agent' : `Encerrada às ${hhmm(conv.closedAt ?? conv.createdAt)}`}
              </span>
            </div>
          </div>
        )}

        <form className="pane-composer" onSubmit={send}>
          <input
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              analystTyping(conv.id);
            }}
            disabled={!mine}
            placeholder={mine ? `Responder ${first}…` : conv.status === 'human' ? 'Outro analista está atendendo' : 'Assuma o atendimento para responder'}
            aria-label="Resposta"
          />
          {mine && (
            <button className="send-btn" disabled={!draft.trim()} aria-label="Enviar">
              <SendHorizontal size={19} />
            </button>
          )}
        </form>
      </footer>
    </section>
  );
}

function BlockAttachment({ block, db }: { block: Block; db: DB }) {
  if (block.type === 'ticket') {
    const t = ticketById(db, block.ticketId);
    return (
      <div className="c-attach">
        <FileText size={15} />
        <span>
          Cartão do chamado <strong>{block.ticketId}</strong>
          {t && ` · ${TICKET_STATUS[t.status].label}`}
        </span>
      </div>
    );
  }
  if (block.type === 'ticket-picker') {
    return (
      <div className="c-attach">
        <ListChecks size={15} />
        <span>
          Lista com {block.ticketIds.length} chamados{block.selected && ` · escolheu ${block.selected}`}
        </span>
      </div>
    );
  }
  if (block.type === 'draft') {
    const state = block.state === 'confirmed' ? `criado ${block.ticketId}` : block.state === 'cancelled' ? 'descartado' : 'aguardando confirmação';
    return (
      <div className="c-attach">
        <FileText size={15} />
        <span>
          Rascunho {block.draft.id} · <strong>{block.draft.title}</strong> · {state}
        </span>
      </div>
    );
  }
  return null;
}

function ConsoleMessage({ m, db, dim, hit }: { m: Message; db: DB; dim: boolean; hit: boolean }) {
  const cls = `${dim ? 'is-dim' : ''} ${hit ? 'is-hit' : ''}`;

  if (m.author === 'event') {
    const Icon = EVENT_ICONS[m.event?.icon ?? 'bot'];
    return (
      <div className={`c-event ${cls}`}>
        <span>
          <Icon size={14} /> {m.text} · {hhmm(m.at)}
        </span>
      </div>
    );
  }

  if (m.author === 'contact') {
    return (
      <div className={`c-msg c-in ${cls}`}>
        <div className="c-bubble">
          {m.text}
          <span className="c-meta">{hhmm(m.at)}</span>
        </div>
      </div>
    );
  }

  const isBot = m.author === 'assistant';

  return (
    <div className={`c-msg c-out ${cls}`}>
      <div className="c-label">
        {isBot ? 'Nexo Assist' : m.analyst?.name}
        <span className={`tag ${isBot ? 'tag-blue' : 'tag-green'}`}>{isBot ? 'IA' : m.analyst?.team}</span>
      </div>
      <div className={`c-bubble ${isBot ? 'c-bot' : 'c-human'}`}>
        {isBot ? (
          m.blocks?.map((b, i) =>
            b.type === 'text' ? (
              <p key={i} className="pre">
                {b.text}
                {b.question && ` ${b.question}`}
                {b.chosen && <span className="c-chosen"> → {b.choices?.find((c) => c.value === b.chosen)?.label}</span>}
              </p>
            ) : (
              <BlockAttachment key={i} block={b} db={db} />
            ),
          )
        ) : (
          m.text
        )}
        <span className="c-meta">
          {hhmm(m.at)} <CheckCheck size={14} />
        </span>
      </div>
      {m.decision && <DecisionDetails decision={m.decision} />}
    </div>
  );
}
