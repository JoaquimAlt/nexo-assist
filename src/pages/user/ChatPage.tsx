import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, ArrowLeftRight, ArrowUp, Bot, Check, CircleCheck, Clock, Headphones, Loader2 } from 'lucide-react';
import type { Block, Conversation, DB, EventIcon, Message, TicketDraft, User } from '../../data/types';
import { AFFECTED, CATEGORIES, PRIORITY, TICKET_STATUS } from '../../data/labels';
import { useCurrentUser } from '../../store/auth';
import { useDB } from '../../store/store';
import { activeConversation, countMessages, ticketById, userById } from '../../store/selectors';
import { MESSAGE_LIMIT, contactTyping, recoverStale, restartConversation, sendToConversation, startConversation, updateDraft } from '../../agent/runtime';
import { responseDeadline } from '../../lib/sla';
import { dayMonth, hhmm } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import { TicketCard } from '../../components/TicketCard';
import { Dot, StatusLabel } from '../../components/ui';

const SUGGESTIONS = ['Qual o status do meu chamado?', 'Meu notebook não conecta na VPN desde ontem. Aparece o erro 809.', 'A impressora do meu andar não imprime.'];

export default function ChatPage() {
  const user = useCurrentUser()!;
  const db = useDB();
  const conv = activeConversation(db, user.id);

  useEffect(() => {
    if (!conv) startConversation(user.id);
  }, [conv, user.id]);

  const convId = conv?.id;
  useEffect(() => {
    if (convId) recoverStale(convId);
  }, [convId]);

  if (!conv) return null;
  return <ChatView key={conv.id} conv={conv} user={user} db={db} />;
}

function ChatView({ conv, user, db }: { conv: Conversation; user: User; db: DB }) {
  const now = useNow(1000);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');

  const count = countMessages(conv);
  const limitReached = count >= MESSAGE_LIMIT;
  const agentMode = conv.status === 'agent' || conv.status === 'resolved';
  const busy = !!conv.pending;
  const closed = conv.status === 'closed';
  const analyst = userById(db, conv.assigneeId);
  const analystTyping = (conv.analystTypingUntil ?? 0) > now;
  const lastAssistantId = conv.messages.findLast((m) => m.author === 'assistant')?.id;
  const interactive = (messageId: string) => agentMode && !busy && !limitReached && messageId === lastAssistantId;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conv.messages.length, busy, analystTyping]);

  const send = (value: string) => {
    const t = value.trim();
    if (!t || busy || limitReached || closed) return;
    setText('');
    sendToConversation(conv.id, { type: 'text', text: t }, t);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send(text);
  };

  const placeholder = agentMode
    ? 'Escreva para o Nexo...'
    : conv.status === 'human'
      ? `Escreva para ${analyst?.name.split(' ')[0] ?? 'o analista'}...`
      : `Escreva para o ${conv.queue ?? 'Suporte'}...`;

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-col">
          {conv.messages.length === 0 && (
            <div className="welcome">
              <h2>Olá, {user.name.split(' ')[0]}. Como posso ajudar?</h2>
              <p className="muted">Descreva o problema com suas palavras. Eu consulto seus chamados, busco na central de ajuda e chamo um analista quando precisa.</p>
              <div className="welcome-list">
                {SUGGESTIONS.map((s) => (
                  <button key={s} className="welcome-item" onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {conv.messages.map((m) => (
            <MessageView key={m.id} m={m} conv={conv} db={db} now={now} active={interactive(m.id)} />
          ))}

          {busy && conv.pending && <PendingTurn pending={conv.pending} />}
          {analystTyping && (
            <div className="typing-line">
              <span className="typing-dots"><i /><i /><i /></span>
              {analyst?.name.split(' ')[0] ?? 'O analista'} está digitando…
            </div>
          )}
        </div>
      </div>

      <div className="chat-bottom">
        <div className="chat-col">
          {(conv.status === 'waiting' || conv.status === 'help') && (
            <div className="chat-banner banner-amber">
              <Clock size={16} />
              <span>
                Você está na fila do {conv.queue ?? 'Suporte N2'}
                {conv.waitingDeadline && <> · um analista responde até <strong>{hhmm(conv.waitingDeadline)}</strong></>}. Pode continuar escrevendo por aqui.
              </span>
            </div>
          )}
          {conv.status === 'human' && analyst && (
            <div className="chat-banner banner-green">
              <Headphones size={16} />
              <span>
                <strong>{analyst.name}</strong> ({analyst.team}) está no seu atendimento.
              </span>
            </div>
          )}

          {closed || limitReached ? (
            <div className="chat-ended">
              <span>{closed ? 'Este atendimento foi encerrado.' : `Você chegou ao limite de ${MESSAGE_LIMIT} mensagens desta sessão.`}</span>
              <button className="btn btn-primary btn-sm" onClick={() => restartConversation(conv.id)}>
                Nova conversa
              </button>
            </div>
          ) : (
            <form className="composer" onSubmit={onSubmit}>
              <input
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  if (!agentMode) contactTyping(conv.id);
                }}
                placeholder={placeholder}
                aria-label="Mensagem"
                maxLength={1000}
              />
              <button className="btn btn-primary" disabled={!text.trim() || busy}>
                <ArrowUp size={16} />
                Enviar
              </button>
            </form>
          )}
          <div className="chat-meta">
            {count}/{MESSAGE_LIMIT} mensagens nesta sessão
          </div>
        </div>
      </div>
    </div>
  );
}

const EVENT_ICONS: Record<EventIcon, typeof Bot> = {
  transfer: ArrowLeftRight,
  headset: Headphones,
  bot: Bot,
  check: CircleCheck,
  alert: AlertCircle,
};

function MessageView({ m, conv, db, now, active }: { m: Message; conv: Conversation; db: DB; now: number; active: boolean }) {
  if (m.author === 'contact') {
    return (
      <div className="u-msg" title={hhmm(m.at)}>
        {m.text}
      </div>
    );
  }

  if (m.author === 'event') {
    const Icon = EVENT_ICONS[m.event?.icon ?? 'bot'];
    return (
      <div className="u-event">
        <Icon size={14} />
        {m.event?.contactText ?? m.text} · {hhmm(m.at)}
      </div>
    );
  }

  if (m.author === 'analyst') {
    return (
      <div className="turn">
        <div className="turn-head">
          <strong>{m.analyst?.name}</strong>
          <span className="tag tag-green">{m.analyst?.team}</span>
          <span className="muted small">{hhmm(m.at)}</span>
        </div>
        <div className="a-bubble a-bubble-human">{m.text}</div>
      </div>
    );
  }

  return (
    <div className="turn">
      <div className="turn-head">
        <strong>Nexo Assist</strong>
        {m.tools?.map((t) => (
          <span key={t} className="tool">
            <Check size={13} />
            {t}
          </span>
        ))}
      </div>
      {m.blocks?.map((b, i) => <BlockView key={i} block={b} index={i} message={m} conv={conv} db={db} now={now} active={active} />)}
    </div>
  );
}

function BlockView({ block, index, message, conv, db, now, active }: {
  block: Block;
  index: number;
  message: Message;
  conv: Conversation;
  db: DB;
  now: number;
  active: boolean;
}) {
  switch (block.type) {
    case 'text':
      return (
        <div className="a-bubble">
          <p className="pre">{block.text}</p>
          {block.question && <p className="a-question">{block.question}</p>}
          {block.choices && (
            <div className="chips">
              {block.choices.map((c) => (
                <button
                  key={c.value}
                  className={`chip ${block.chosen === c.value ? 'chip-on' : ''}`}
                  disabled={!active || !!block.chosen}
                  onClick={() => sendToConversation(conv.id, { type: 'choice', messageId: message.id, blockIndex: index, value: c.value, label: c.label }, c.label)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}
        </div>
      );

    case 'ticket-picker':
      return (
        <div className="card picker" role="radiogroup" aria-label="Seus chamados abertos">
          {block.ticketIds.map((id) => {
            const t = ticketById(db, id);
            if (!t) return null;
            const st = TICKET_STATUS[t.status];
            const selected = block.selected === id;
            return (
              <button
                key={id}
                role="radio"
                aria-checked={selected}
                className={`picker-row ${selected ? 'is-selected' : ''}`}
                disabled={!active || !!block.selected}
                onClick={() => sendToConversation(conv.id, { type: 'pick-ticket', messageId: message.id, ticketId: id }, `${id} · ${t.shortTitle ?? t.title}`)}
              >
                <span className="radio" />
                <span className="picker-id">{id}</span>
                <span className="picker-title">{t.title}</span>
                <StatusLabel tone={st.tone} className="picker-status">
                  {st.label}
                </StatusLabel>
                <span className="picker-date">{dayMonth(t.openedAt)}</span>
              </button>
            );
          })}
        </div>
      );

    case 'ticket': {
      const t = ticketById(db, block.ticketId);
      return t ? <TicketCard ticket={t} now={now} /> : null;
    }

    case 'draft':
      return <DraftCard block={block} messageId={message.id} convId={conv.id} active={active} now={now} />;
  }
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function DraftCard({ block, messageId, convId, active, now }: {
  block: Extract<Block, { type: 'draft' }>;
  messageId: string;
  convId: string;
  active: boolean;
  now: number;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<TicketDraft>(block.draft);
  const d = block.draft;
  const pending = block.state === 'pending';
  const canAct = pending && active;

  const confirm = () => sendToConversation(convId, { type: 'draft', messageId, action: 'confirm' });
  const cancel = () => sendToConversation(convId, { type: 'draft', messageId, action: 'cancel' });

  useEffect(() => {
    if (!canAct || editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        sendToConversation(convId, { type: 'draft', messageId, action: 'confirm' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canAct, editing, convId, messageId]);

  const save = () => {
    updateDraft(convId, messageId, { ...form, title: form.title.trim() || d.title, description: form.description.trim() || d.description });
    setEditing(false);
  };

  const priority = PRIORITY[d.priority];
  const deadline = responseDeadline(d.priority, new Date(now));

  const status =
    block.state === 'confirmed' ? (
      <StatusLabel tone="green">Criado · {block.ticketId}</StatusLabel>
    ) : block.state === 'cancelled' ? (
      <StatusLabel tone="gray">Descartado</StatusLabel>
    ) : active ? (
      <StatusLabel tone="amber">Aguardando confirmação</StatusLabel>
    ) : (
      <StatusLabel tone="gray">Não confirmado</StatusLabel>
    );

  return (
    <article className={`card tcard draft ${block.state === 'cancelled' ? 'is-muted' : ''}`}>
      <div className="tcard-body">
        <div className="tcard-top">
          <span className="muted">
            Novo chamado <span className="sep">·</span> Rascunho {d.id}
          </span>
          {status}
        </div>

        {editing ? (
          <div className="draft-form">
            <label className="field">
              <span className="field-label">Título</span>
              <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={90} autoFocus />
            </label>
            <label className="field">
              <span className="field-label">Descrição</span>
              <textarea className="input" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </label>
            <div className="draft-form-row">
              <label className="field">
                <span className="field-label">Categoria</span>
                <select className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                  {CATEGORIES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Prioridade</span>
                <select className="input" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as TicketDraft['priority'] })}>
                  {Object.entries(PRIORITY).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Afetados</span>
                <select className="input" value={form.affected} onChange={(e) => setForm({ ...form, affected: e.target.value as TicketDraft['affected'] })}>
                  {Object.entries(AFFECTED).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        ) : (
          <>
            <h3 className="tcard-title">{d.title}</h3>
            <p className="tcard-desc">{d.description}</p>
            <dl className="tcard-grid cols-3">
              <div>
                <dt>Categoria</dt>
                <dd>{d.category}</dd>
              </div>
              <div>
                <dt>Prioridade</dt>
                <dd>
                  <Dot tone={priority.tone} /> {priority.label}
                  {pending && <span className="muted small"> · resposta até {hhmm(deadline)}</span>}
                </dd>
              </div>
              <div>
                <dt>Afetados</dt>
                <dd>{AFFECTED[d.affected]}</dd>
              </div>
            </dl>
          </>
        )}
      </div>

      {canAct && (
        <div className="tcard-foot">
          {editing ? (
            <>
              <button className="btn btn-primary" onClick={save}>
                Salvar alterações
              </button>
              <button className="btn btn-ghost" onClick={() => { setForm(d); setEditing(false); }}>
                Descartar
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-primary" onClick={confirm}>
                Confirmar <kbd>{isMac ? '⌘↵' : 'Ctrl ↵'}</kbd>
              </button>
              <button className="btn" onClick={() => { setForm(d); setEditing(true); }}>
                Editar
              </button>
              <button className="btn btn-ghost" onClick={cancel}>
                Cancelar
              </button>
            </>
          )}
        </div>
      )}
    </article>
  );
}

function PendingTurn({ pending }: { pending: NonNullable<Conversation['pending']> }) {
  const now = useNow(150);
  const elapsed = now - Date.parse(pending.startedAt);
  const step = pending.durationMs / (pending.tools.length + 1);
  const done = Math.min(pending.tools.length, Math.floor(elapsed / step));

  return (
    <div className="turn" aria-live="polite">
      <div className="turn-head">
        <strong>Nexo Assist</strong>
        {pending.tools.slice(0, done).map((t) => (
          <span key={t} className="tool">
            <Check size={13} />
            {t}
          </span>
        ))}
        {done < pending.tools.length && (
          <span className="tool tool-running">
            <Loader2 size={13} className="spin" />
            {pending.tools[done]}
          </span>
        )}
      </div>
      <div className="a-bubble a-typing">
        <span className="typing-dots"><i /><i /><i /></span>
      </div>
    </div>
  );
}
