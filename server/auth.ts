import { randomUUID } from 'node:crypto';
import type { DB, User } from '../src/data/types';
import { CORPORATE_DOMAIN } from '../src/lib/limits';
import { readDB, updateDB, type ServerDB } from './db';

export type LoginResult = { ok: true; user: User; token: string } | { ok: false; error: string };

/** Ambiente de demonstração: qualquer senha vale para os funcionários dos dados de exemplo (PRD, Tela 1). */
export async function login(email: string, password: string): Promise<LoginResult> {
  const normalized = email.trim().toLowerCase();
  if (!normalized.endsWith(CORPORATE_DOMAIN)) return { ok: false, error: `Use seu e-mail corporativo (${CORPORATE_DOMAIN}).` };
  const user = (await readDB()).users.find((u) => u.email.toLowerCase() === normalized);
  if (!user || !password) return { ok: false, error: 'E-mail ou senha incorretos.' };
  const token = randomUUID();
  await updateDB((db) => {
    db.sessions[token] = user.id;
  });
  return { ok: true, user, token };
}

export async function logout(token: string) {
  await updateDB((db) => {
    delete db.sessions[token];
  });
}

export async function userForToken(token: string | undefined): Promise<User | undefined> {
  if (!token) return undefined;
  const db = await readDB();
  const id = db.sessions[token];
  return id ? db.users.find((u) => u.id === id) : undefined;
}

/**
 * O que cada pessoa pode ver. O analista vê o service desk inteiro; o
 * colaborador vê só as próprias conversas e chamados, e dos outros usuários
 * apenas os analistas (para mostrar quem o atende).
 */
export function viewFor(user: User, db: ServerDB): DB {
  const { sessions: _sessions, llmUsage: _usage, ...shared } = db;
  if (user.role === 'analista') return shared;
  return {
    ...shared,
    users: db.users.filter((u) => u.id === user.id || u.role === 'analista'),
    tickets: db.tickets.filter((t) => t.requesterId === user.id),
    conversations: db.conversations.filter((c) => c.contactId === user.id),
  };
}
