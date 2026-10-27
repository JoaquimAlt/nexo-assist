import { beforeEach, describe, expect, it } from 'vitest';
import { resetDB } from '../store/store';
import { TicketAccessError, TicketServiceError, configureTicketService, ticketService, withRetry } from './tickets';

beforeEach(() => {
  resetDB();
  configureTicketService({ failureRate: 0, latencyMs: [0, 0], random: Math.random });
});

describe('serviço de chamados', () => {
  it('só devolve os chamados de quem pediu', async () => {
    const tickets = await ticketService.listByRequester('u-ana');
    expect(tickets.length).toBeGreaterThan(0);
    expect(tickets.every((t) => t.requesterId === 'u-ana')).toBe(true);
  });

  it('não deixa um colaborador alterar o chamado de outro', async () => {
    await expect(ticketService.addNote('u-ana', 'INC-20502', 'Ana', 'oi')).rejects.toBeInstanceOf(TicketAccessError);
  });

  it('numera requisições como REQ e incidentes como INC', async () => {
    const req = await ticketService.create('u-ana', { kind: 'requisicao', title: 't', description: 'd', category: 'Software', priority: 'baixa' });
    const inc = await ticketService.create('u-ana', { kind: 'incidente', title: 't', description: 'd', category: 'Hardware', priority: 'media' });
    expect(req.id).toBe('REQ-10443');
    expect(inc.id).toBe('INC-20520');
  });

  it('reabre um chamado resolvido', async () => {
    await ticketService.reopen('u-ana', 'INC-20150', 'Ana', 'voltou');
    const t = (await ticketService.listByRequester('u-ana')).find((x) => x.id === 'INC-20150');
    expect(t).toMatchObject({ status: 'aguardando_analista', resolvedAt: undefined });
  });
});

describe('novas tentativas', () => {
  it('tenta de novo quando o sistema falha e conta as falhas', async () => {
    let calls = 0;
    const retries: number[] = [];
    const r = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new TicketServiceError();
        return 'ok';
      },
      (attempt) => retries.push(attempt),
    );
    expect(r).toEqual({ value: 'ok', failures: 2 });
    expect(retries).toEqual([2, 3]);
  });

  it('desiste depois de 3 tentativas', async () => {
    await expect(withRetry(async () => Promise.reject(new TicketServiceError()))).rejects.toBeInstanceOf(TicketServiceError);
  });

  it('não repete erro de acesso', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new TicketAccessError('INC-1');
      }),
    ).rejects.toBeInstanceOf(TicketAccessError);
    expect(calls).toBe(1);
  });
});
