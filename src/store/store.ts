import { useSyncExternalStore } from 'react';
import type { DB } from '../data/types';
import { SEED_VERSION } from '../data/seed';
import { api, getSession, onActionDone, onSessionChange, reportError } from '../api/client';

/**
 * Cópia local do que o servidor deixa esta pessoa ver. O navegador pergunta de
 * tempos em tempos se a revisão mudou e só baixa o estado quando mudou; por
 * isso colaborador e analista conversam ao vivo, em abas ou máquinas
 * diferentes, inclusive nas funções da Vercel, que não mantêm conexão aberta.
 */
const EMPTY: DB = { version: SEED_VERSION, users: [], tickets: [], conversations: [], seq: { inc: 0, req: 0, draft: 0 }, analystAvailable: true };

/** Intervalo da consulta com a aba visível e em segundo plano. */
const POLL_MS = 1500;
const POLL_HIDDEN_MS = 10_000;

let state: DB = EMPTY;
let rev = -1;
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

/** Busca o estado se mudou; pedidos durante a busca viram uma busca só, logo depois. */
export function refresh(): Promise<void> {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = api<{ rev: number; db: DB } | null>(`/state?rev=${rev}`)
    .then((res) => {
      if (res) {
        state = res.db;
        rev = res.rev;
        loaded = true;
        emit();
      }
      reportError(null);
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

let timer: ReturnType<typeof setTimeout> | undefined;

function schedule() {
  clearTimeout(timer);
  if (!getSession()) return;
  timer = setTimeout(
    () => void refresh().finally(schedule),
    typeof document !== 'undefined' && document.hidden ? POLL_HIDDEN_MS : POLL_MS,
  );
}

function connect() {
  clearTimeout(timer);
  state = EMPTY;
  rev = -1;
  loaded = false;
  emit();
  if (!getSession()) return;
  void refresh().finally(schedule);
}

if (typeof window !== 'undefined') {
  onSessionChange(connect);
  // Depois de uma ação, atualiza na hora em vez de esperar a próxima consulta.
  onActionDone(() => void refresh());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refresh().finally(schedule);
  });
  connect();
}

export function useDB() {
  return useSyncExternalStore(subscribe, getDB);
}

export const useLoaded = () => useSyncExternalStore(subscribe, isLoaded);

export { resetDB } from '../api/actions';
