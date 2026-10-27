import { useSyncExternalStore } from 'react';
import type { User } from '../data/types';
import { getDB, useDB } from './store';

/**
 * A sessão vive no sessionStorage (por aba), para que seja possível abrir
 * a colaboradora e o analista lado a lado. "Manter conectado" também grava
 * no localStorage, que é lido quando uma aba nova é aberta.
 */
const KEY = 'nexo-assist:session';
export const DEMO_PASSWORD = 'nexo2026';
export const CORPORATE_DOMAIN = '@nexo.com.br';

function read() {
  try {
    return sessionStorage.getItem(KEY) ?? localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

let current = read();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useCurrentUser(): User | null {
  const id = useSyncExternalStore(subscribe, () => current);
  const db = useDB();
  return id ? (db.users.find((u) => u.id === id) ?? null) : null;
}

export type LoginResult = { ok: true; user: User } | { ok: false; error: string };

export function login(email: string, password: string, remember: boolean): LoginResult {
  const user = getDB().users.find((u) => u.email.toLowerCase() === email.trim().toLowerCase());
  if (!user || password !== DEMO_PASSWORD) return { ok: false, error: 'E-mail ou senha incorretos.' };
  try {
    sessionStorage.setItem(KEY, user.id);
    if (remember) localStorage.setItem(KEY, user.id);
    else localStorage.removeItem(KEY);
  } catch {
    // sem armazenamento: a sessão fica só em memória
  }
  current = user.id;
  emit();
  return { ok: true, user };
}

export function logout() {
  try {
    sessionStorage.removeItem(KEY);
    if (localStorage.getItem(KEY) === current) localStorage.removeItem(KEY);
  } catch {
    // ignora
  }
  current = null;
  emit();
}

export const homeFor = (u: User) => (u.role === 'analista' ? '/console' : '/atendimento');
