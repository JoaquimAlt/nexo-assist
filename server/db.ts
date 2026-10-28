import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DB } from '../src/data/types';
import { createSeed, SEED_VERSION } from '../src/data/seed';
import { env } from './env';

/**
 * Banco do servidor: um documento JSON em disco. Conversas, chamados, o
 * estado de cada conversa e as sessões sobrevivem a um reinício.
 */
export interface ServerDB extends DB {
  /** token → id do usuário */
  sessions: Record<string, string>;
  /** Chamadas ao modelo no dia, para o limite diário. */
  llmUsage: { day: string; calls: number };
}

const fresh = (): ServerDB => ({ ...createSeed(), sessions: {}, llmUsage: { day: '', calls: 0 } });

function load(): ServerDB {
  if (env.dbFile !== ':memory:' && existsSync(env.dbFile)) {
    try {
      const db = JSON.parse(readFileSync(env.dbFile, 'utf-8')) as ServerDB;
      if (db.version === SEED_VERSION) {
        // Respostas que estavam "pensando" quando o servidor caiu não vão terminar.
        for (const c of db.conversations) c.pending = undefined;
        return db;
      }
    } catch {
      // arquivo corrompido: recomeça do seed
    }
  }
  return fresh();
}

let state = load();
let timer: ReturnType<typeof setTimeout> | undefined;

function persist() {
  if (env.dbFile === ':memory:') return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    mkdirSync(dirname(env.dbFile), { recursive: true });
    const tmp = `${env.dbFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, env.dbFile);
  }, 50);
}

const listeners = new Set<() => void>();

export const getDB = () => state;

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Aplica uma mutação sobre uma cópia do estado; se ela lançar erro, nada muda. */
export function updateDB(mutate: (db: ServerDB) => void) {
  const next = structuredClone(state);
  mutate(next);
  state = next;
  persist();
  listeners.forEach((l) => l());
}

/** Volta aos dados de demonstração, mantendo as sessões abertas. */
export function resetDB() {
  const { sessions } = state;
  state = { ...fresh(), sessions };
  persist();
  listeners.forEach((l) => l());
}
