import { useState } from 'react';
import { KeyRound, Lock, Mail, RotateCcw } from 'lucide-react';
import { useCurrentUser } from '../../store/auth';
import { calendarDaysBetween, relDays } from '../../lib/time';
import { useNow } from '../../lib/useNow';

const RESEND_COOLDOWN_S = 60;

export default function ProfilePage() {
  const user = useCurrentUser()!;
  const now = useNow(1000);
  const [sentAt, setSentAt] = useState<number | null>(null);

  const days = calendarDaysBetween(user.passwordChangedAt, now);
  // `now` pode estar até 1 s atrás do clique, daí o limite superior.
  const wait = sentAt ? Math.min(RESEND_COOLDOWN_S, Math.max(0, RESEND_COOLDOWN_S - Math.floor((now - sentAt) / 1000))) : 0;

  return (
    <div className="page">
      <div className="page-col">
        <h1 className="page-title">Meu perfil</h1>
        <p className="muted page-sub">Seus dados de acesso ao service desk de TI.</p>

        <section className="card profile-card">
          <div className="profile-row">
            <span className="profile-key">Nome</span>
            <span className="profile-val">{user.name}</span>
          </div>
          <div className="profile-row">
            <span className="profile-key">E-mail corporativo</span>
            <span className="profile-val">{user.email}</span>
            <span className="profile-lock">
              <Lock size={14} />
              Gerenciado pela TI
            </span>
          </div>
        </section>

        <section className="card profile-card">
          <div className="profile-pass">
            <span className="profile-icon">
              <KeyRound size={18} />
            </span>
            <div className="profile-pass-text">
              <strong>Senha</strong>
              <span className="muted">Alterada {relDays(days)}</span>
            </div>
            <button className="btn" onClick={() => setSentAt(Date.now())} disabled={wait > 0}>
              <RotateCcw size={15} />
              {wait > 0 ? `Reenviar em ${wait} s` : sentAt ? 'Reenviar link' : 'Redefinir senha'}
            </button>
          </div>
          <div className="profile-note" role="status">
            <Mail size={15} />
            {sentAt ? (
              <span>
                Link de redefinição enviado para <strong>{user.email}</strong>. Ele vale por 30 minutos.
              </span>
            ) : (
              <span>Enviaremos um link de redefinição para {user.email}.</span>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
