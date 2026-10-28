import { useSyncExternalStore } from 'react';
import type { User } from '../data/types';
import { CORPORATE_DOMAIN } from '../lib/limits';
import { ApiError, api, getSession, onSessionChange, setSession } from '../api/client';
import { useDB } from './store';

export { CORPORATE_DOMAIN };

/** Senha sugerida nos atalhos de demonstração; o servidor aceita qualquer senha. */
export const DEMO_PASSWORD = 'nexo2026';

const subscribeSession = (l: () => void) => onSessionChange(l);

export function useCurrentUser(): User | null {
  const session = useSyncExternalStore(subscribeSession, getSession);
  const db = useDB();
  return session ? (db.users.find((u) => u.id === session.userId) ?? null) : null;
}

/** Há sessão, mesmo que o estado ainda esteja carregando. */
export const useHasSession = () => !!useSyncExternalStore(subscribeSession, getSession);

export type LoginResult = { ok: true; user: User } | { ok: false; error: string };

export async function login(email: string, password: string, remember: boolean): Promise<LoginResult> {
  try {
    const { token, user } = await api<{ token: string; user: User }>('/login', { email, password });
    setSession({ token, userId: user.id }, remember);
    return { ok: true, user };
  } catch (err) {
    return { ok: false, error: err instanceof ApiError ? err.message : 'Não foi possível entrar.' };
  }
}

export function logout() {
  api('/logout', {}).catch(() => undefined);
  setSession(null);
}

export const homeFor = (u: User) => (u.role === 'analista' ? '/console' : '/atendimento');
