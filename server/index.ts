import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { app } from './app.js';
import { env } from './env.js';
import { clearStalePending, storeKind } from './db.js';
import { checkModel } from './llm.js';

/** Servidor local (npm run dev / npm start). Na Vercel, quem atende é api/[[...route]].ts. */

// Em produção local, o mesmo servidor entrega o front (npm run build && npm start).
app.use('/*', serveStatic({ root: './dist' }));
app.get('*', serveStatic({ path: './dist/index.html' }));

await clearStalePending();

serve({ fetch: app.fetch, port: env.port }, (info) => {
  console.log(`Nexo Assist API em http://localhost:${info.port} · banco: ${storeKind}`);
  void checkModel().then((status) => console.log(status));
});
