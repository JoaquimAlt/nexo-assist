import { handle } from 'hono/vercel';
import { app } from '../server/app.js';

/**
 * Função da Vercel. O vercel.json reescreve todo /api/* para cá, mantendo o
 * caminho original, e o app Hono escolhe a rota.
 */
const handler = handle(app);

export const GET = handler;
export const POST = handler;
