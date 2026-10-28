import { describe, expect, it } from 'vitest';
import { canReopen, isOverdue, slaDeadline } from './sla.js';
import type { Ticket } from '../data/types.js';

const ticket = (partial: Partial<Ticket>): Ticket => ({
  id: 'INC-1',
  title: 't',
  description: 'd',
  category: 'Hardware',
  priority: 'media',
  status: 'aguardando_analista',
  requesterId: 'u',
  openedAt: '',
  updatedAt: '',
  notes: [],
  ...partial,
});

describe('prazos (Anexo A)', () => {
  it('crítica: 1 hora corrida, mesmo fora do expediente', () => {
    expect(slaDeadline('critica', new Date(2026, 9, 24, 22, 0))).toEqual(new Date(2026, 9, 24, 23, 0));
  });

  it('alta: 4 horas úteis, pulando a noite e o fim de semana', () => {
    // Sexta 16:00 → 2 h na sexta + 2 h na segunda.
    expect(slaDeadline('alta', new Date(2026, 9, 23, 16, 0))).toEqual(new Date(2026, 9, 26, 10, 0));
  });

  it('média e baixa: dias úteis', () => {
    const wed = new Date(2026, 9, 21, 11, 43);
    expect(slaDeadline('media', wed)).toEqual(new Date(2026, 9, 26, 11, 43));
    expect(slaDeadline('baixa', wed)).toEqual(new Date(2026, 9, 28, 11, 43));
  });

  it('vence quando passa do prazo desde a última atualização', () => {
    const t = ticket({ priority: 'media', updatedAt: new Date(2026, 9, 21, 11, 0).toISOString() });
    expect(isOverdue(t, new Date(2026, 9, 26, 10, 59))).toBe(false);
    expect(isOverdue(t, new Date(2026, 9, 26, 11, 1))).toBe(true);
  });

  it('só reabre resolvido há até 7 dias', () => {
    const now = new Date(2026, 9, 21, 12, 0);
    const resolved = (days: number) => ticket({ status: 'resolvido', resolvedAt: new Date(now.getTime() - days * 86_400_000).toISOString() });
    expect(canReopen(resolved(4), now)).toBe(true);
    expect(canReopen(resolved(8), now)).toBe(false);
  });
});
