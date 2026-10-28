import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Redis } from '@upstash/redis';
import type { DB } from '../src/data/types';
import { createSeed, SEED_VERSION } from '../src/data/seed';
import { env } from './env';

/**
 * Banco do servidor: um documento só. Conversas, chamados, o estado de cada
 * conversa e as sessões sobrevivem a um reinício.
 *
 * - Local: arquivo JSON (server/data/db.json).
 * - Vercel (ou onde houver Redis configurado): Upstash Redis, porque as funções
 *   não guardam estado entre uma requisição e outra.
 *
 * Cada gravação confere a revisão lida (compare-and-set): duas requisições ao
 * mesmo tempo não apagam a mudança uma da outra; a que perde tenta de novo.
 */
export interface ServerDB extends DB {
  /** token → id do usuário */
  sessions: Record<string, string>;
  /** Chamadas ao modelo no dia, para o limite diário. */
  llmUsage: { day: string; calls: number };
}

interface Snapshot {
  db: ServerDB;
  rev: number;
}

interface Store {
  rev(): Promise<number>;
  load(): Promise<Snapshot | null>;
  /** Grava se a revisão ainda for `expected`; devolve false se alguém gravou antes. */
  save(db: ServerDB, expected: number): Promise<boolean>;
}

const fresh = (): ServerDB => ({ ...createSeed(), sessions: {}, llmUsage: { day: '', calls: 0 } });

const usable = (db: ServerDB | null | undefined): db is ServerDB => !!db && db.version === SEED_VERSION;

// ---------------------------------------------------------------------------
// Arquivo (um processo só: a revisão vive em memória)

function fileStore(file: string): Store {
  let snapshot: Snapshot | null = null;
  if (file !== ':memory:' && existsSync(file)) {
    try {
      const db = JSON.parse(readFileSync(file, 'utf-8')) as ServerDB;
      if (usable(db)) snapshot = { db, rev: 1 };
    } catch {
      // arquivo corrompido: recomeça do seed
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    rev: async () => snapshot?.rev ?? 0,
    load: async () => snapshot,
    save: async (db, expected) => {
      if ((snapshot?.rev ?? 0) !== expected) return false;
      snapshot = { db, rev: expected + 1 };
      if (file !== ':memory:') {
        clearTimeout(timer);
        timer = setTimeout(() => {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(`${file}.tmp`, JSON.stringify(snapshot!.db));
          renameSync(`${file}.tmp`, file);
        }, 50);
      }
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Upstash Redis

const KEY_DB = 'nexo:db';
const KEY_REV = 'nexo:rev';

/** Grava o documento e avança a revisão só se ela ainda for a esperada. */
const CAS = `
local current = tonumber(redis.call('GET', KEYS[2]) or '0')
if current ~= tonumber(ARGV[2]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], current + 1)
return 1`;

function redisStore(url: string, token: string): Store {
  const redis = new Redis({ url, token, automaticDeserialization: false });
  return {
    rev: async () => Number((await redis.get<string>(KEY_REV)) ?? 0),
    load: async () => {
      const [raw, rev] = await redis.mget<[string | null, string | null]>(KEY_DB, KEY_REV);
      if (!raw) return null;
      const db = JSON.parse(raw) as ServerDB;
      return usable(db) ? { db, rev: Number(rev ?? 0) } : null;
    },
    save: async (db, expected) => (await redis.eval<[string, string], number>(CAS, [KEY_DB, KEY_REV], [JSON.stringify(db), String(expected)])) === 1,
  };
}

// ---------------------------------------------------------------------------

const store: Store = env.redis ? redisStore(env.redis.url, env.redis.token) : fileStore(env.dbFile);

export const storeKind = env.redis ? 'Upstash Redis' : env.dbFile === ':memory:' ? 'memória' : `arquivo ${env.dbFile}`;

/** Revisão atual: o navegador só baixa o estado quando ela muda. */
export const currentRev = () => store.rev();

/** Lê o banco; na primeira vez, grava os dados de demonstração. */
export async function readDB(): Promise<ServerDB> {
  return (await snapshot()).db;
}

/** Banco e revisão lidos juntos, para o navegador saber de qual versão é o estado. */
export const readSnapshot = (): Promise<Snapshot> => snapshot();

async function snapshot(): Promise<Snapshot> {
  const loaded = await store.load();
  if (loaded) return loaded;
  const rev = await store.rev();
  const db = fresh();
  // Se outra requisição semeou antes, usa o que ela gravou.
  return (await store.save(db, rev)) ? { db, rev: rev + 1 } : snapshot();
}

/**
 * Aplica uma mutação e grava. Se a mutação lançar erro, nada muda. Se outra
 * requisição gravou no meio, lê de novo e reaplica.
 */
export async function updateDB<T>(mutate: (db: ServerDB) => T): Promise<T> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const { db, rev } = await snapshot();
    const next = structuredClone(db);
    const result = mutate(next);
    if (await store.save(next, rev)) return result;
    // Espera aleatória e crescente, para quem perdeu não colidir de novo com os outros.
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 15 * (attempt + 1)));
  }
  throw new Error('Banco ocupado: muitas gravações ao mesmo tempo.');
}

/** Volta aos dados de demonstração, mantendo as sessões abertas. */
export async function resetDB() {
  await updateDB((db) => {
    const { sessions } = db;
    Object.assign(db, fresh(), { sessions });
  });
}

/** Respostas que estavam "pensando" quando o servidor local caiu não vão terminar. */
export async function clearStalePending() {
  await updateDB((db) => {
    for (const c of db.conversations) c.pending = undefined;
  });
}
