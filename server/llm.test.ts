import { describe, expect, it } from 'vitest';
import { createSeed } from '../src/data/seed.js';
import { buildPrompt, interpret, interpretationSchema, toInterpretation } from './llm.js';

const NOW = new Date(2026, 9, 21, 11, 43);
const db = createSeed(NOW);
const ana = db.users.find((u) => u.id === 'u-ana')!;
const tickets = db.tickets.filter((t) => t.requesterId === ana.id);
const conversation = { id: 'c', contactId: ana.id, status: 'agent' as const, createdAt: NOW.toISOString(), messages: [], agent: {} };

describe('contexto enviado ao modelo', () => {
  const prompt = buildPrompt({ text: 'meu notebook trava', user: ana, tickets, conversation, context: { awaiting: 'affected', problem: { text: 'notebook trava', topic: 'notebook' } }, now: NOW });

  it('leva só os chamados da colaboradora', () => {
    expect(prompt).toContain('INC-20311');
    expect(prompt).not.toContain('INC-20502');
    expect(prompt).not.toContain('Bruno');
  });

  it('leva o estado da conversa e a mensagem delimitada, sem chamados antigos', () => {
    expect(prompt).not.toContain('INC-19877'); // resolvido há mais de 7 dias: não ajuda a entender a mensagem
    expect(prompt).toContain('perguntou "Quem está sendo afetado?"');
    expect(prompt).toContain('"""meu notebook trava"""');
  });
});

describe('saída do modelo', () => {
  it('normaliza e descarta campos inúteis', () => {
    const raw = interpretationSchema.parse({
      intent: 'consultar_chamados',
      ticketId: 'inc-20311',
      category: null,
      kind: null,
      title: '  ',
      affected: null,
      urgency: null,
      errorCode: 'erro 809',
      outOfScopeArea: null,
      kbArticleId: null,
      understood: ' Quer saber do chamado. ',
      confidence: 1.4,
      reasons: ['cita o número', ' '],
    });
    expect(toInterpretation(raw)).toMatchObject({ ticketId: 'INC-20311', title: undefined, errorCode: '809', understood: 'Quer saber do chamado.', reasons: ['cita o número'] });
  });

  it('rejeita intenção ou artigo fora da lista', () => {
    expect(interpretationSchema.safeParse({ intent: 'apagar_tudo' }).success).toBe(false);
  });
});

describe('modelo desligado', () => {
  it('devolve só a origem e deixa as regras decidirem', async () => {
    const r = await interpret({ text: 'oi', user: ana, tickets, conversation, context: {}, now: NOW });
    expect(r.interpretation).toBeUndefined();
    expect(r.source).toMatchObject({ kind: 'regras', note: expect.stringContaining('NEXO_MODEL=off') });
  });
});
