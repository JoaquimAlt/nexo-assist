import './env';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { User } from '../src/data/types';
import { CATEGORIES } from '../src/data/labels';
import { currentRev, readDB, readSnapshot, resetDB } from './db';
import { login, logout, userForToken, viewFor } from './auth';
import { contactTyping, restartConversation, sendToConversation, startConversation, updateDraft } from './runtime';
import * as consoleActions from './console';

/**
 * Rotas da API. Rodam igual no servidor local (server/index.ts) e nas funções
 * da Vercel (api/index.ts): nada fica em memória entre uma requisição e outra.
 */
type Vars = { Variables: { user: User; token: string } };
export const app = new Hono<Vars>();

const tokenOf = (c: Context) => c.req.header('authorization')?.replace(/^Bearer /, '');

/** Corpo validado; um corpo inválido vira 400 em vez de chegar às regras. */
async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T | Response> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  return parsed.success ? parsed.data : c.json({ error: 'Requisição inválida.' }, 400);
}

app.onError((err, c) => {
  console.error('[api]', err);
  return c.json({ error: 'Erro no servidor. Tente de novo.' }, 500);
});

app.post('/api/login', async (c) => {
  const data = await body(c, z.object({ email: z.string().max(200), password: z.string().max(200) }));
  if (data instanceof Response) return data;
  const result = await login(data.email, data.password);
  return result.ok ? c.json({ token: result.token, user: result.user }) : c.json({ error: result.error }, 401);
});

app.use('/api/*', async (c, next) => {
  const token = tokenOf(c);
  const user = await userForToken(token);
  if (!user || !token) return c.json({ error: 'Sessão expirada.' }, 401);
  c.set('user', user);
  c.set('token', token);
  await next();
});

app.post('/api/logout', async (c) => {
  await logout(c.get('token'));
  return c.json({ ok: true });
});

/**
 * Estado que a pessoa pode ver. O navegador manda a revisão que já tem; se nada
 * mudou, a resposta é 204 e ninguém baixa nada de novo.
 */
app.get('/api/state', async (c) => {
  const known = Number(c.req.query('rev') ?? -1);
  if (known >= 0 && known === (await currentRev())) return c.body(null, 204);
  const { db, rev } = await readSnapshot();
  return c.json({ rev, db: viewFor(c.get('user'), db) });
});

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
  const conv = (await readDB()).conversations.find((x) => x.id === id);
  if (!conv || conv.contactId !== c.get('user').id) return c.json({ error: 'Conversa não encontrada.' }, 404);
  await next();
});

const agentInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(1000) }),
  z.object({ type: z.literal('choice'), messageId: z.string(), blockIndex: z.number().int(), value: z.string().max(60), label: z.string().max(120) }),
  z.object({ type: z.literal('pick-ticket'), messageId: z.string(), ticketId: z.string().max(20) }),
  z.object({ type: z.literal('draft'), messageId: z.string(), action: z.enum(['confirm', 'cancel']) }),
]);

collaborator.post('/start', async (c) => {
  await startConversation(c.get('user').id);
  return c.json({ ok: true });
});

collaborator.post('/:id/messages', async (c) => {
  const data = await body(c, z.object({ input: agentInput, echo: z.string().max(1000).optional() }));
  if (data instanceof Response) return data;
  // A resposta do agent sai dentro desta requisição (numa função da Vercel não há "depois").
  // O navegador não espera por ela: acompanha pelo estado.
  await sendToConversation(c.req.param('id'), data.input, data.echo);
  return c.json({ ok: true });
});

collaborator.post('/:id/restart', async (c) => {
  await restartConversation(c.req.param('id'));
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
  await updateDraft(c.req.param('id'), data.messageId, data.draft);
  return c.json({ ok: true });
});

collaborator.post('/:id/typing', async (c) => {
  await contactTyping(c.req.param('id'));
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
  await consoleActions.setAvailability(data.available);
  return c.json({ ok: true });
});

analyst.post('/reset', async (c) => {
  await resetDB();
  return c.json({ ok: true });
});

analyst.post('/:id/:action', async (c) => {
  const id = c.req.param('id');
  const me = c.get('user');
  switch (c.req.param('action')) {
    case 'assume':
      await consoleActions.assume(id, me);
      break;
    case 'return':
      await consoleActions.returnToAgent(id);
      break;
    case 'close':
      await consoleActions.closeConversation(id, me);
      break;
    case 'read':
      await consoleActions.markRead(id);
      break;
    case 'unread':
      await consoleActions.markUnread(id);
      break;
    case 'typing':
      await consoleActions.analystTyping(id);
      break;
    case 'send': {
      const data = await body(c, z.object({ text: z.string().min(1).max(2000) }));
      if (data instanceof Response) return data;
      await consoleActions.sendAsAnalyst(id, me, data.text);
      break;
    }
    default:
      return c.json({ error: 'Ação desconhecida.' }, 404);
  }
  return c.json({ ok: true });
});

app.route('/api/console', analyst);
