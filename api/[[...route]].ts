import { handle } from 'hono/vercel';
import { app } from '../server/app.js';

/** Função da Vercel: recebe todas as rotas /api/* com o caminho original. */
const handler = handle(app);

export const GET = handler;
export const POST = handler;
