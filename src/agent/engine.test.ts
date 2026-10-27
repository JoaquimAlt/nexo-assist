import { describe, expect, it } from 'vitest';
import type { Block, Conversation, Message } from '../data/types';
import { createSeed } from '../data/seed';
import { detectAffected, normalize, runAgent, type AgentEnv } from './engine';

// Uma quarta-feira às 11:43, como no protótipo.
const NOW = new Date(2026, 9, 21, 11, 43);

function env(conversation?: Partial<Conversation>): AgentEnv {
  const db = createSeed(NOW);
  const user = db.users.find((u) => u.id === 'u-ana')!;
  return {
    user,
    tickets: db.tickets.filter((t) => t.requesterId === user.id),
    conversation: { id: 'c', contactId: user.id, status: 'agent', createdAt: NOW.toISOString(), messages: [], agent: {}, ...conversation },
    now: NOW,
    nextTicketId: 'INC-20520',
    nextDraftId: 'D-381',
  };
}

const texts = (blocks: Block[]) => blocks.flatMap((b) => (b.type === 'text' ? [b.text, b.question ?? ''] : [])).join(' ');

describe('consulta de chamados', () => {
  it('lista os chamados abertos para a colaboradora escolher', () => {
    const r = runAgent({ type: 'text', text: 'Qual o status do meu chamado?' }, env());
    expect(r.tools).toEqual(['consultou seus chamados']);
    expect(texts(r.blocks)).toContain('Você tem 3 chamados abertos');
    const picker = r.blocks.find((b) => b.type === 'ticket-picker');
    expect(picker).toMatchObject({ ticketIds: ['INC-20311', 'INC-20298', 'REQ-10442'] });
  });

  it('aponta o prazo vencido e oferece chamar um analista', () => {
    const r = runAgent({ type: 'pick-ticket', messageId: 'm', ticketId: 'INC-20311' }, env());
    expect(r.tools).toEqual(['consultou o INC-20311', 'calculou o prazo']);
    expect(r.blocks[0]).toEqual({ type: 'ticket', ticketId: 'INC-20311' });
    expect(texts(r.blocks)).toContain('acima do prazo de 3 dias úteis para prioridade média');
    expect(r.context.focusTicketId).toBe('INC-20311');
  });

  it('transfere para o Suporte N2 com o chamado em foco', () => {
    const r = runAgent({ type: 'text', text: 'Quero falar com um analista.' }, env({ agent: { focusTicketId: 'INC-20311' } }));
    expect(r.effects).toEqual([{ type: 'handoff', ticketId: 'INC-20311' }]);
    expect(texts(r.blocks)).toContain('Encaminhei para o Suporte N2');
  });

  it('reconhece um número de chamado citado no texto', () => {
    const r = runAgent({ type: 'text', text: 'e o req 10442?' }, env());
    expect(r.blocks[0]).toEqual({ type: 'ticket', ticketId: 'REQ-10442' });
  });
});

describe('abertura de chamado', () => {
  it('explica que o artigo não serve para o Windows 11 e pergunta quem é afetado', () => {
    const r = runAgent({ type: 'text', text: 'Meu notebook não conecta na VPN desde ontem. Aparece o erro 809.' }, env());
    expect(r.tools).toEqual(['consultou seus chamados', 'buscou na central de ajuda']);
    expect(texts(r.blocks)).toContain('o artigo do erro 809 vale só para Windows 10 — o seu é Windows 11');
    expect(r.context.awaiting).toBe('affected');
  });

  it('monta o rascunho com prioridade alta por causa da reunião', () => {
    const first = runAgent({ type: 'text', text: 'Meu notebook não conecta na VPN desde ontem. Aparece o erro 809.' }, env());
    const r = runAgent(
      { type: 'text', text: 'Só eu. Tenho reunião com um cliente às 14h e preciso da VPN funcionando.' },
      env({ agent: first.context }),
    );
    const draft = r.blocks.find((b) => b.type === 'draft');
    expect(draft?.type === 'draft' && draft.draft).toMatchObject({
      title: 'VPN não conecta no notebook — erro 809',
      category: 'Rede e VPN',
      priority: 'alta',
      affected: 'eu',
    });
    expect(draft?.type === 'draft' && draft.draft.description).toContain('desde 20/10');
    expect(texts(r.blocks)).toContain('por causa da reunião — a resposta chega antes das 14h');
    expect(r.effects).toContainEqual({ type: 'mark-choice', value: 'aff:eu' });
  });

  it('cria o chamado ao confirmar o rascunho', () => {
    const first = runAgent({ type: 'text', text: 'A impressora não imprime.' }, env());
    const kbNo = runAgent({ type: 'choice', messageId: 'x', blockIndex: 0, value: 'kb:no', label: 'Não resolveu' }, env({ agent: first.context }));
    const draft = runAgent({ type: 'choice', messageId: 'x', blockIndex: 0, value: 'aff:equipe', label: 'Minha equipe' }, env({ agent: kbNo.context }));
    const message: Message = { id: 'm-draft', at: NOW.toISOString(), author: 'assistant', blocks: draft.blocks };

    const r = runAgent({ type: 'draft', messageId: 'm-draft', action: 'confirm' }, env({ messages: [message], agent: draft.context }));
    expect(r.effects).toEqual([{ type: 'create-ticket', messageId: 'm-draft', ticketId: 'INC-20520' }]);
    expect(texts(r.blocks)).toContain('abri o INC-20520 com prioridade alta');
  });

  it('sugere acrescentar a um chamado já aberto sobre o mesmo assunto', () => {
    const r = runAgent({ type: 'text', text: 'Meu notebook continua muito lento' }, env());
    expect(r.blocks[0]).toEqual({ type: 'ticket', ticketId: 'INC-20311' });
    expect(texts(r.blocks)).toContain('Você já tem o INC-20311');
  });
});

describe('utilitários', () => {
  it('normaliza acentos e caixa', () => {
    expect(normalize('  Não Sei ')).toBe('nao sei');
  });

  it('detecta quem é afetado', () => {
    expect(detectAffected(normalize('Só eu'))).toBe('eu');
    expect(detectAffected(normalize('a equipe toda'))).toBe('equipe');
    expect(detectAffected(normalize('toda a empresa'))).toBe('empresa');
    expect(detectAffected(normalize('não sei'))).toBe('nao_sei');
    expect(detectAffected(normalize('preciso disso logo'))).toBeUndefined();
  });
});
