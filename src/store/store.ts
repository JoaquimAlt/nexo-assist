import { useSyncExternalStore } from 'react';
import type { DB } from '../data/types';
import { createSeed, SEED_VERSION } from '../data/seed';

/**
 * "Backend" simulado: um único documento persistido no localStorage.
 * O evento `storage` sincroniza abas, então o colaborador e o analista
 * podem conversar em duas abas do mesmo navegador.
 */
const KEY = 'nexo-assist:db';
const hasStorage = typeof window !== 'undefined' && typeof localStorage !== 'undefined';

function load(): DB {
  if (hasStorage) {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const db = JSON.parse(raw) as DB;
        if (db.version === SEED_VERSION) return db;
      }
    } catch {
      // dados corrompidos: recomeça do seed
    }
  }
  return createSeed();
}

function persist() {
  if (!hasStorage) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // armazenamento cheio ou bloqueado: segue só em memória
  }
}

let state = load();
persist();

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const getDB = () => state;

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Aplica uma mutação sobre uma cópia do estado, persiste e notifica. */
export function updateDB(mutate: (db: DB) => void) {
  const next = structuredClone(state);
  mutate(next);
  state = next;
  persist();
  emit();
}

export function resetDB() {
  state = createSeed();
  persist();
  emit();
}

if (hasStorage) {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY || !e.newValue) return;
    try {
      state = JSON.parse(e.newValue) as DB;
      emit();
    } catch {
      // ignora escrita parcial de outra aba
    }
  });
}

export function useDB() {
  return useSyncExternalStore(subscribe, getDB);
}
