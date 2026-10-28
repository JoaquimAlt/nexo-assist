import { beforeEach, describe, expect, it } from 'vitest';
import { app } from './app.js';
import { resetDB, updateDB } from './db.js';
import { configureTicketService } from './tickets.js';

/** Testa a API pelo próprio Hono, sem subir servidor: é o mesmo código que roda na Vercel. */
const call = (path: string, init: { token?: string; body?: unknown } = {}) =>
  app.request(path, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

async function loginAs(email: string) {
  const res = await call('/api/login', { body: { email, password: 'qualquer' } });
  return ((await res.json()) as { token: string }).token;
}

beforeEach(async () => {
  await resetDB();
  configureTicketService({ failureRate: 0, latencyMs: [0, 0], random: Math.random });
});

describe('API', () => {
  it('aceita qualquer senha para funcionários e recusa outro domínio', async () => {
    expect((await call('/api/login', { body: { email: 'ana.souza@nexo.com.br', password: 'x' } })).status).toBe(200);
    expect((await call('/api/login', { body: { email: 'ana@gmail.com', password: 'x' } })).status).toBe(401);
  });

  it('exige sessão', async () => {
    expect((await call('/api/state')).status).toBe(401);
  });

  it('entrega a cada colaborador só os próprios dados', async () => {
    const token = await loginAs('ana.souza@nexo.com.br');
    const { db } = (await (await call('/api/state', { token })).json()) as { db: { tickets: { requesterId: string }[]; sessions?: unknown } };
    expect(db.tickets.every((t) => t.requesterId === 'u-ana')).toBe(true);
    expect(db.sessions).toBeUndefined();
  });

  it('responde 204 quando a revisão não mudou e manda o estado quando mudou', async () => {
    const token = await loginAs('ana.souza@nexo.com.br');
    const { rev } = (await (await call('/api/state', { token })).json()) as { rev: number };
    expect((await call(`/api/state?rev=${rev}`, { token })).status).toBe(204);
    await call('/api/conversations/start', { token, body: {} });
    expect((await call(`/api/state?rev=${rev}`, { token })).status).toBe(200);
  });

  it('responde a mensagem dentro da requisição', async () => {
    const token = await loginAs('ana.souza@nexo.com.br');
    await call('/api/conversations/start', { token, body: {} });
    const { db } = (await (await call('/api/state', { token })).json()) as { db: { conversations: { id: string }[] } };
    const id = db.conversations.at(-1)!.id;
    const res = await call(`/api/conversations/${id}/messages`, { token, body: { input: { type: 'text', text: 'Qual o status do meu chamado?' }, echo: 'Qual o status do meu chamado?' } });
    expect(res.status).toBe(200);
    const after = (await (await call('/api/state', { token })).json()) as { db: { conversations: { id: string; pending?: unknown; messages: { author: string }[] }[] } };
    const conv = after.db.conversations.find((c) => c.id === id)!;
    expect(conv.pending).toBeUndefined();
    expect(conv.messages.at(-1)!.author).toBe('assistant');
  }, 15_000);

  it('bloqueia ações de analista para colaborador e conversa de outra pessoa', async () => {
    const token = await loginAs('ana.souza@nexo.com.br');
    expect((await call('/api/console/c-bruno/assume', { token, body: {} })).status).toBe(403);
    expect((await call('/api/conversations/c-bruno/messages', { token, body: { input: { type: 'text', text: 'oi' } } })).status).toBe(404);
  });
});

describe('banco', () => {
  it('não perde gravações feitas ao mesmo tempo', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        updateDB((db) => {
          db.users[0].department = `${db.users[0].department}|${i}`;
        }),
      ),
    );
    const token = await loginAs('ana.souza@nexo.com.br');
    const { db } = (await (await call('/api/state', { token })).json()) as { db: { users: { department: string }[] } };
    expect(db.users[0].department.split('|')).toHaveLength(11);
  });
});
