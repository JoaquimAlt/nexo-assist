import './env';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import type { User } from '../src/data/types';
import { CATEGORIES } from '../src/data/labels';
import { env } from './env';
import { getDB, resetDB, subscribe } from './db';
import { login, logout, userForToken, viewFor } from './auth';
import { contactTyping, restartConversation, sendToConversation, startConversation, updateDraft } from './runtime';
import * as consoleActions from './console';
import { checkModel } from './llm';

type Vars = { Variables: { user: User; token: string } };
const app = new Hono<Vars>();

const tokenOf = (c: Context) => c.req.header('authorization')?.replace(/^Bearer /, '') ?? c.req.query('token');

/** Corpo validado; um corpo inválido vira 400 em vez de chegar às regras. */
async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T | Response> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  return parsed.success ? parsed.data : c.json({ error: 'Requisição inválida.' }, 400);
}

app.post('/api/login', async (c) => {
  const data = await body(c, z.object({ email: z.string().max(200), password: z.string().max(200) }));
  if (data instanceof Response) return data;
  const result = login(data.email, data.password);
  return result.ok ? c.json({ token: result.token, user: result.user }) : c.json({ error: result.error }, 401);
});

app.use('/api/*', async (c, next) => {
  const token = tokenOf(c);
  const user = userForToken(token);
  if (!user || !token) return c.json({ error: 'Sessão expirada.' }, 401);
  c.set('user', user);
  c.set('token', token);
  await next();
});

app.post('/api/logout', (c) => {
  logout(c.get('token'));
  return c.json({ ok: true });
});

app.get('/api/state', (c) => c.json(viewFor(c.get('user'))));

/** Avisa o navegador a cada mudança; ele busca o estado de novo. */
app.get('/api/events', (c) =>
  streamSSE(c, async (stream) => {
    let pending = false;
    const unsubscribe = subscribe(() => {
      if (pending) return;
      pending = true;
      // Junta mudanças em sequência num aviso só.
      setTimeout(() => {
        pending = false;
        void stream.writeSSE({ event: 'change', data: '' });
      }, 30);
    });
    stream.onAbort(unsubscribe);
    await stream.writeSSE({ event: 'change', data: '' });
    while (!stream.aborted) {
      await stream.sleep(25_000);
      await stream.writeSSE({ event: 'ping', data: '' });
    }
  }),
);

// ---------------------------------------------------------------------------
// Colaborador: só mexe nas próprias conversas.

const collaborator = new Hono<Vars>();

collaborator.use('*', async (c, next) => {
  if (c.get('user').role !== 'colaborador') return c.json({ error: 'Apenas colaboradores.' }, 403);
  await next();
});

collaborator.use('/:id/*', async (c, next) => {
  const id = c.req.param('id');
  if (id === 'start') return next();
  const conv = getDB().conversations.find((x) => x.id === id);
  if (!conv || conv.contactId !== c.get('user').id) return c.json({ error: 'Conversa não encontrada.' }, 404);
  await next();
});

const agentInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(1000) }),
  z.object({ type: z.literal('choice'), messageId: z.string(), blockIndex: z.number().int(), value: z.string().max(60), label: z.string().max(120) }),
  z.object({ type: z.literal('pick-ticket'), messageId: z.string(), ticketId: z.string().max(20) }),
  z.object({ type: z.literal('draft'), messageId: z.string(), action: z.enum(['confirm', 'cancel']) }),
]);

collaborator.post('/start', (c) => {
  startConversation(c.get('user').id);
  return c.json({ ok: true });
});

collaborator.post('/:id/messages', async (c) => {
  const data = await body(c, z.object({ input: agentInput, echo: z.string().max(1000).optional() }));
  if (data instanceof Response) return data;
  // Responde na hora; o agent trabalha em segundo plano e o navegador acompanha pelos eventos.
  void sendToConversation(c.req.param('id'), data.input, data.echo).catch((err) => console.error('[agent]', err));
  return c.json({ ok: true });
});

collaborator.post('/:id/restart', (c) => {
  restartConversation(c.req.param('id'));
  return c.json({ ok: true });
});

collaborator.post('/:id/draft', async (c) => {
  const data = await body(
    c,
    z.object({
      messageId: z.string(),
      draft: z.object({
        id: z.string(),
        kind: z.enum(['incidente', 'requisicao']),
        title: z.string().min(1).max(90),
        description: z.string().min(1).max(2000),
        category: z.enum(CATEGORIES as [string, ...string[]]),
        priority: z.enum(['baixa', 'media', 'alta', 'critica']),
        affected: z.enum(['eu', 'equipe', 'empresa', 'nao_sei']),
        createdAt: z.string(),
      }),
    }),
  );
  if (data instanceof Response) return data;
  updateDraft(c.req.param('id'), data.messageId, data.draft);
  return c.json({ ok: true });
});

collaborator.post('/:id/typing', (c) => {
  contactTyping(c.req.param('id'));
  return c.json({ ok: true });
});

app.route('/api/conversations', collaborator);

// ---------------------------------------------------------------------------
// Analista

const analyst = new Hono<Vars>();

analyst.use('*', async (c, next) => {
  if (c.get('user').role !== 'analista') return c.json({ error: 'Apenas analistas.' }, 403);
  await next();
});

analyst.post('/availability', async (c) => {
  const data = await body(c, z.object({ available: z.boolean() }));
  if (data instanceof Response) return data;
  consoleActions.setAvailability(data.available);
  return c.json({ ok: true });
});

analyst.post('/reset', (c) => {
  resetDB();
  return c.json({ ok: true });
});

analyst.post('/:id/:action', async (c) => {
  const id = c.req.param('id');
  const me = c.get('user');
  switch (c.req.param('action')) {
    case 'assume':
      consoleActions.assume(id, me);
      break;
    case 'return':
      consoleActions.returnToAgent(id);
      break;
    case 'close':
      consoleActions.closeConversation(id, me);
      break;
    case 'read':
      consoleActions.markRead(id);
      break;
    case 'unread':
      consoleActions.markUnread(id);
      break;
    case 'typing':
      consoleActions.analystTyping(id);
      break;
    case 'send': {
      const data = await body(c, z.object({ text: z.string().min(1).max(2000) }));
      if (data instanceof Response) return data;
      consoleActions.sendAsAnalyst(id, me, data.text);
      break;
    }
    default:
      return c.json({ error: 'Ação desconhecida.' }, 404);
  }
  return c.json({ ok: true });
});

app.route('/api/console', analyst);

// ---------------------------------------------------------------------------
// Em produção, o mesmo servidor entrega o front (npm run build && npm start).

app.use('/*', serveStatic({ root: './dist' }));
app.get('*', serveStatic({ path: './dist/index.html' }));

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`Nexo Assist API em http://localhost:${info.port}`);
  void checkModel().then((status) => console.log(status));
});
