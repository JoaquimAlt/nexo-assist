import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { app } from './app';
import { env } from './env';
import { clearStalePending, storeKind } from './db';
import { checkModel } from './llm';

/** Servidor local (npm run dev / npm start). Na Vercel, quem atende é api/index.ts. */

// Em produção local, o mesmo servidor entrega o front (npm run build && npm start).
app.use('/*', serveStatic({ root: './dist' }));
app.get('*', serveStatic({ path: './dist/index.html' }));

await clearStalePending();

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`Nexo Assist API em http://localhost:${info.port} · banco: ${storeKind}`);
  void checkModel().then((status) => console.log(status));
});
