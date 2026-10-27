import type { DB, Priority, Ticket, TicketKind } from '../data/types';
import { TICKET_KIND } from '../data/labels';
import { getDB, updateDB } from '../store/store';

/**
 * Serviço de chamados simulado. Faz o papel do sistema legado: cada chamada
 * leva alguns décimos de segundo e, de vez em quando, falha. Toda operação
 * recebe quem está pedindo, e um colaborador só enxerga e altera os próprios
 * chamados.
 */

export class TicketServiceError extends Error {
  constructor(message = 'O sistema de chamados não respondeu.') {
    super(message);
    this.name = 'TicketServiceError';
  }
}

interface Config {
  /** Chance de uma chamada falhar (0–1). */
  failureRate: number;
  latencyMs: [min: number, max: number];
  random: () => number;
}

/** `?instavel` na URL deixa o sistema bem instável, para demonstrar as novas tentativas. */
const unstable = typeof location !== 'undefined' && new URLSearchParams(location.search).has('instavel');

const config: Config = { failureRate: unstable ? 0.5 : 0.08, latencyMs: [150, 450], random: Math.random };

export function configureTicketService(next: Partial<Config>) {
  Object.assign(config, next);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function call<T>(op: () => T): Promise<T> {
  const [min, max] = config.latencyMs;
  await wait(min + config.random() * (max - min));
  if (config.random() < config.failureRate) throw new TicketServiceError();
  return op();
}

/** Chamado inexistente ou de outra pessoa: não adianta tentar de novo. */
export class TicketAccessError extends Error {
  constructor(ticketId: string) {
    super(`Chamado ${ticketId} não encontrado.`);
    this.name = 'TicketAccessError';
  }
}

function owned(db: DB, ticketId: string, requesterId: string) {
  const t = db.tickets.find((x) => x.id === ticketId);
  if (!t || t.requesterId !== requesterId) throw new TicketAccessError(ticketId);
  return t;
}

function nextId(db: DB, kind: TicketKind) {
  const key: 'inc' | 'req' = kind === 'requisicao' ? 'req' : 'inc';
  const prefix = TICKET_KIND[kind].prefix;
  let n = db.seq[key];
  while (db.tickets.some((t) => t.id === `${prefix}-${n}`)) n++;
  return { id: `${prefix}-${n}`, key, n };
}

/** Próximo número de cada tipo, sem reservar (o agent usa para prever o número). */
export function peekNextIds(): Record<TicketKind, string> {
  const db = getDB();
  return { incidente: nextId(db, 'incidente').id, requisicao: nextId(db, 'requisicao').id };
}

export interface NewTicket {
  kind: TicketKind;
  title: string;
  description: string;
  category: string;
  priority: Priority;
}

export const ticketService = {
  listByRequester(requesterId: string): Promise<Ticket[]> {
    return call(() => structuredClone(getDB().tickets.filter((t) => t.requesterId === requesterId)));
  },

  create(requesterId: string, input: NewTicket): Promise<Ticket> {
    return call(() => {
      let created!: Ticket;
      updateDB((db) => {
        const { id, key, n } = nextId(db, input.kind);
        const now = new Date().toISOString();
        created = {
          id,
          title: input.title,
          description: input.description,
          category: input.category,
          priority: input.priority,
          status: 'aguardando_analista',
          requesterId,
          openedAt: now,
          updatedAt: now,
          notes: [],
        };
        db.tickets.push(created);
        db.seq[key] = n + 1;
      });
      return created;
    });
  },

  addNote(requesterId: string, ticketId: string, author: string, text: string): Promise<void> {
    return call(() =>
      updateDB((db) => {
        const t = owned(db, ticketId, requesterId);
        const now = new Date().toISOString();
        t.notes.push({ at: now, author, text });
        t.updatedAt = now;
      }),
    );
  },

  reopen(requesterId: string, ticketId: string, author: string, text: string): Promise<void> {
    return call(() =>
      updateDB((db) => {
        const t = owned(db, ticketId, requesterId);
        const now = new Date().toISOString();
        t.status = 'aguardando_analista';
        t.resolvedAt = undefined;
        t.updatedAt = now;
        t.notes.push({ at: now, author, text: `Reaberto: ${text}` });
      }),
    );
  },

  /** Marca o chamado como aguardando analista, na transferência da conversa. */
  transfer(requesterId: string, ticketId: string): Promise<void> {
    return call(() =>
      updateDB((db) => {
        const t = owned(db, ticketId, requesterId);
        if (t.status !== 'resolvido' && t.status !== 'aprovado') t.status = 'aguardando_analista';
      }),
    );
  },
};

/** Tenta de novo quando o sistema legado falha, esperando um pouco mais a cada vez. */
export async function withRetry<T>(op: () => Promise<T>, onRetry?: (attempt: number) => void, attempts = 3): Promise<{ value: T; failures: number }> {
  for (let i = 1; ; i++) {
    try {
      return { value: await op(), failures: i - 1 };
    } catch (err) {
      if (!(err instanceof TicketServiceError) || i >= attempts) throw err;
      onRetry?.(i + 1);
      await wait(400 * i);
    }
  }
}
