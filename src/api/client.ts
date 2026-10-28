/**
 * Cliente da API. A sessão (token) vive no sessionStorage, por aba, para que
 * colaborador e analista fiquem logados lado a lado; "Manter conectado"
 * também grava no localStorage, lido quando uma aba nova é aberta.
 */
const KEY = 'nexo-assist:session';

export interface Session {
  token: string;
  userId: string;
}

function read(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY) ?? localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

let session = read();
const listeners = new Set<() => void>();

export const getSession = () => session;

export function onSessionChange(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setSession(next: Session | null, remember = false) {
  try {
    if (next) {
      sessionStorage.setItem(KEY, JSON.stringify(next));
      if (remember) localStorage.setItem(KEY, JSON.stringify(next));
      else localStorage.removeItem(KEY);
    } else {
      sessionStorage.removeItem(KEY);
      if (localStorage.getItem(KEY) === JSON.stringify(session)) localStorage.removeItem(KEY);
    }
  } catch {
    // sem armazenamento: a sessão fica só em memória
  }
  session = next;
  listeners.forEach((l) => l());
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T = { ok: true }>(path: string, payload?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  } catch {
    throw new ApiError('Sem conexão com o servidor.', 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401 && path !== '/login') setSession(null);
  if (!res.ok) throw new ApiError(data.error ?? 'Algo deu errado.', res.status);
  return data as T;
}

/** Ações disparadas por clique: o erro é mostrado no aviso de conexão, não derruba a tela. */
export function fire(path: string, payload: unknown = {}) {
  api(path, payload).catch((err: unknown) => reportError(err instanceof Error ? err.message : 'Algo deu errado.'));
}

let lastError: string | null = null;
const errorListeners = new Set<() => void>();

export function reportError(message: string | null) {
  lastError = message;
  errorListeners.forEach((l) => l());
}

export const getLastError = () => lastError;

export function onError(listener: () => void) {
  errorListeners.add(listener);
  return () => {
    errorListeners.delete(listener);
  };
}
