import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { ChevronRight, LogOut, MessageSquare, SquarePen, User as UserIcon } from 'lucide-react';
import { logout, useCurrentUser } from '../../store/auth';
import { useDB } from '../../store/store';
import { activeConversation, userById } from '../../store/selectors';
import { restartConversation } from '../../api/actions';
import { Avatar, LogoMark } from '../../components/ui';
import type { Conversation, DB } from '../../data/types';

function ConversationPill({ conv, db }: { conv: Conversation; db: DB }) {
  if (conv.status === 'waiting' || conv.status === 'help') return <span className="pill pill-amber"><span className="dot dot-amber" />Aguardando analista</span>;
  if (conv.status === 'human') {
    const analyst = userById(db, conv.assigneeId);
    return <span className="pill pill-green"><span className="dot dot-green" />{analyst ? `${analyst.name.split(' ')[0]} no atendimento` : 'Analista no atendimento'}</span>;
  }
  if (conv.status === 'closed') return <span className="pill pill-gray"><span className="dot dot-gray" />Atendimento encerrado</span>;
  return <span className="pill pill-green"><span className="dot dot-green" />Assistente online</span>;
}

export default function UserLayout() {
  const user = useCurrentUser()!;
  const db = useDB();
  const location = useLocation();
  const onChat = location.pathname.startsWith('/atendimento');
  const conv = activeConversation(db, user.id);

  const newConversation = () => {
    if (!conv) return;
    const waitingHuman = conv.status === 'waiting' || conv.status === 'help' || conv.status === 'human';
    if (waitingHuman && !window.confirm('Um analista está cuidando desta conversa. Começar uma nova vai encerrá-la. Continuar?')) return;
    restartConversation(conv.id);
  };

  return (
    <div className="ulayout">
      <aside className="usidebar">
        <div className="brand">
          <LogoMark className="brand-mark" />
          Nexo Assist
        </div>
        <nav className="unav">
          <NavLink to="/atendimento">
            <MessageSquare size={17} />
            Atendimento
          </NavLink>
          <NavLink to="/perfil">
            <UserIcon size={17} />
            Meu perfil
          </NavLink>
        </nav>
        <div className="usidebar-foot">
          <div className="me">
            <Avatar user={user} size={34} />
            <div className="me-text">
              <strong>{user.name}</strong>
              <span>{user.email}</span>
            </div>
          </div>
          <button className="unav-btn" onClick={logout}>
            <LogOut size={17} />
            Sair
          </button>
        </div>
      </aside>

      <main className="umain">
        <header className="utop">
          <nav className="crumbs" aria-label="Você está em">
            <span>Service desk de TI</span>
            <ChevronRight size={15} />
            <strong>{onChat ? 'Atendimento' : 'Meu perfil'}</strong>
          </nav>
          {onChat && conv && (
            <div className="utop-actions">
              {conv.messages.length > 0 && conv.status !== 'closed' && (
                <button className="btn btn-ghost btn-sm" onClick={newConversation}>
                  <SquarePen size={15} />
                  Nova conversa
                </button>
              )}
              <ConversationPill conv={conv} db={db} />
            </div>
          )}
        </header>
        <Outlet />
      </main>
    </div>
  );
}
