import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { ArrowRight, Check, Eye, EyeOff, Lock, Mail, MailCheck } from 'lucide-react';
import { CORPORATE_DOMAIN, DEMO_PASSWORD, homeFor, login, useCurrentUser } from '../store/auth';
import { LogoMark } from '../components/ui';

const DEMO_ACCOUNTS = [
  { email: 'ana.souza@nexo.com.br', label: 'Ana Souza', role: 'colaboradora' },
  { email: 'rafael.lima@nexo.com.br', label: 'Rafael Lima', role: 'analista N2' },
];

export default function LoginPage() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'forgot'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);
  const [errors, setErrors] = useState<{ email?: string; password?: string; form?: string }>({});
  const [loading, setLoading] = useState(false);
  const [resetSentTo, setResetSentTo] = useState<string | null>(null);

  if (user) return <Navigate to={homeFor(user)} replace />;

  const validateEmail = () => {
    const value = email.trim().toLowerCase();
    if (!value) return 'Informe seu e-mail corporativo.';
    if (!/^[^\s@]+@[^\s@]+$/.test(value)) return 'Esse e-mail não parece válido.';
    if (!value.endsWith(CORPORATE_DOMAIN)) return `Use seu e-mail corporativo ${CORPORATE_DOMAIN}.`;
    return undefined;
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = { email: validateEmail(), password: password ? undefined : 'Informe sua senha.' };
    setErrors(next);
    if (next.email || next.password) return;
    setLoading(true);
    window.setTimeout(() => {
      const result = login(email, password, remember);
      setLoading(false);
      if (result.ok) navigate(homeFor(result.user), { replace: true });
      else setErrors({ form: result.error });
    }, 450);
  };

  const submitForgot = (e: FormEvent) => {
    e.preventDefault();
    const error = validateEmail();
    setErrors({ email: error });
    if (!error) setResetSentTo(email.trim().toLowerCase());
  };

  const fillDemo = (demoEmail: string) => {
    setMode('login');
    setEmail(demoEmail);
    setPassword(DEMO_PASSWORD);
    setErrors({});
  };

  return (
    <div className="login">
      <section className="login-hero">
        <div className="login-brand">
          <LogoMark size={24} />
          Nexo Assist
        </div>

        <div className="login-hero-body">
          <p className="login-kicker">Service desk de TI da Nexo</p>
          <h1>Seu problema de TI, resolvido em uma conversa.</h1>
          <p className="login-lead">
            Descreva o que está acontecendo. O assistente consulta seus chamados, busca na central de ajuda e chama um analista quando precisa.
          </p>

          <div className="login-preview" aria-hidden="true">
            <div className="lp-user">Meu notebook não conecta na VPN. Erro 809.</div>
            <div className="lp-head">
              <strong>Nexo Assist</strong> consultou seus chamados · criou um chamado
            </div>
            <div className="lp-bot">Pronto: abri o chamado com prioridade alta. Um analista fala com você em até 4 h úteis.</div>
            <div className="lp-ticket">
              <span className="dot dot-amber" />
              <strong>INC-20517</strong> Rede e VPN · Alta · em até 4 h
            </div>
          </div>
        </div>

        <dl className="login-stats">
          <div>
            <dt>8 s</dt>
            <dd>primeira resposta, em média</dd>
          </div>
          <div>
            <dt>72%</dt>
            <dd>resolvidos sem fila</dd>
          </div>
          <div>
            <dt>
              6 <span className="dot dot-green" />
            </dt>
            <dd>analistas online agora</dd>
          </div>
        </dl>
      </section>

      <section className="login-panel">
        <div className="login-help">
          Problema para entrar? <a href="tel:4000">Ligue no ramal 4000</a>
        </div>

        <div className="login-form-wrap">
          {mode === 'login' ? (
            <form className="login-form" onSubmit={submit} noValidate>
              <h2>Entrar</h2>
              <p className="muted">Use seu e-mail corporativo e a senha da rede Nexo.</p>

              {errors.form && (
                <div className="form-alert" role="alert">
                  {errors.form}
                </div>
              )}

              <label className="field">
                <span className="field-label">E-mail corporativo</span>
                <span className={`input-wrap ${errors.email ? 'has-error' : ''}`}>
                  <Mail size={17} />
                  <input
                    type="email"
                    autoComplete="username"
                    placeholder={`nome${CORPORATE_DOMAIN}`}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    aria-invalid={!!errors.email}
                    autoFocus
                  />
                </span>
                {errors.email && <span className="field-error">{errors.email}</span>}
              </label>

              <div className="field">
                <div className="field-row">
                  <label className="field-label" htmlFor="password">
                    Senha
                  </label>
                  <button type="button" className="link" onClick={() => { setMode('forgot'); setErrors({}); setResetSentTo(null); }}>
                    Esqueci minha senha
                  </button>
                </div>
                <span className={`input-wrap ${errors.password ? 'has-error' : ''}`}>
                  <Lock size={17} />
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-invalid={!!errors.password}
                  />
                  <button type="button" className="icon-btn" onClick={() => setShowPassword((s) => !s)} aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}>
                    {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </span>
                {errors.password && <span className="field-error">{errors.password}</span>}
              </div>

              <label className="checkbox">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                <span className="checkbox-box">
                  <Check size={12} strokeWidth={3} />
                </span>
                Manter conectado neste computador
              </label>

              <button className="btn btn-primary btn-lg btn-block" disabled={loading}>
                {loading ? 'Entrando…' : 'Entrar'}
                {!loading && <ArrowRight size={17} />}
              </button>
            </form>
          ) : (
            <form className="login-form" onSubmit={submitForgot} noValidate>
              <h2>Redefinir senha</h2>
              {resetSentTo ? (
                <div className="form-success" role="status">
                  <MailCheck size={18} />
                  <span>
                    Se <strong>{resetSentTo}</strong> estiver cadastrado, enviamos um link de redefinição. Ele vale por 30 minutos.
                  </span>
                </div>
              ) : (
                <>
                  <p className="muted">Enviamos um link de redefinição para o seu e-mail corporativo.</p>
                  <label className="field">
                    <span className="field-label">E-mail corporativo</span>
                    <span className={`input-wrap ${errors.email ? 'has-error' : ''}`}>
                      <Mail size={17} />
                      <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus aria-invalid={!!errors.email} />
                    </span>
                    {errors.email && <span className="field-error">{errors.email}</span>}
                  </label>
                  <button className="btn btn-primary btn-lg btn-block">Enviar link</button>
                </>
              )}
              <button type="button" className="link back-link" onClick={() => { setMode('login'); setErrors({}); }}>
                Voltar para o login
              </button>
            </form>
          )}

          <div className="login-demo">
            <span className="muted small">Contas de demonstração · senha {DEMO_PASSWORD}</span>
            <div className="login-demo-list">
              {DEMO_ACCOUNTS.map((a) => (
                <button key={a.email} type="button" className="demo-chip" onClick={() => fillDemo(a.email)}>
                  {a.label} <span className="muted">· {a.role}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <footer className="login-foot">
          <span>© 2026 Nexo · Service desk de TI</span>
          <a href="#privacidade" onClick={(e) => e.preventDefault()}>
            Privacidade e uso de dados
          </a>
        </footer>
      </section>
    </div>
  );
}
