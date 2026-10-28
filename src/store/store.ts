import { useSyncExternalStore } from 'react';
import type { DB } from '../data/types';
import { SEED_VERSION } from '../data/seed';
import { api, fire, getSession, onSessionChange, reportError } from '../api/client';

/**
 * Cópia local do que o servidor deixa esta pessoa ver. O servidor avisa cada
 * mudança por eventos (SSE) e a cópia é buscada de novo; por isso colaborador
 * e analista conversam ao vivo, em abas ou máquinas diferentes.
 */
const EMPTY: DB = { version: SEED_VERSION, users: [], tickets: [], conversations: [], seq: { inc: 0, req: 0, draft: 0 }, analystAvailable: true };

let state: DB = EMPTY;
let loaded = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const getDB = () => state;
export const isLoaded = () => loaded;

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let inFlight: Promise<void> | null = null;
let again = false;

/** Busca o estado; pedidos que chegam durante a busca viram uma busca só, logo depois. */
export function refresh(): Promise<void> {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = api<DB>('/state')
    .then((db) => {
      state = db;
      loaded = true;
      reportError(null);
      emit();
    })
    .catch((err: unknown) => {
      if (getSession()) reportError(err instanceof Error ? err.message : 'Sem conexão com o servidor.');
    })
    .finally(() => {
      inFlight = null;
      if (again) {
        again = false;
        void refresh();
      }
    });
  return inFlight;
}

let source: EventSource | null = null;

function connect() {
  source?.close();
  source = null;
  const session = getSession();
  if (!session) {
    state = EMPTY;
    loaded = false;
    emit();
    return;
  }
  void refresh();
  source = new EventSource(`/api/events?token=${encodeURIComponent(session.token)}`);
  source.addEventListener('change', () => void refresh());
  source.onerror = () => reportError('Reconectando ao servidor…');
  source.onopen = () => reportError(null);
}

if (typeof window !== 'undefined') {
  onSessionChange(connect);
  connect();
}

export function useDB() {
  return useSyncExternalStore(subscribe, getDB);
}

export const useLoaded = () => useSyncExternalStore(subscribe, isLoaded);

export function resetDB() {
  fire('/console/reset');
}
