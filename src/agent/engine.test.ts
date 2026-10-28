import { describe, expect, it } from 'vitest';
import type { Block, Conversation, Interpretation, Message } from '../data/types';
import { createSeed } from '../data/seed';
import { CONFIDENCE, detectAffected, normalize, runAgent, type AgentEnv } from './engine';

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
    nextIds: { incidente: 'INC-20520', requisicao: 'REQ-10443' },
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
    expect(r.effects).toMatchObject([{ type: 'handoff', ticketId: 'INC-20311', summary: { ticket: expect.stringContaining('prazo vencido') } }]);
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
    expect(texts(r.blocks)).toContain('por causa da reunião — resposta até 15:43');
    expect(texts(r.blocks)).toContain('Esse prazo passa do seu horário das 14h');
    expect(r.effects).toContainEqual({ type: 'mark-choice', value: 'aff:eu' });
  });

  it('cria o chamado ao confirmar o rascunho', () => {
    const first = runAgent({ type: 'text', text: 'A impressora não imprime.' }, env());
    const kbNo = runAgent({ type: 'choice', messageId: 'x', blockIndex: 0, value: 'kb:no', label: 'Não resolveu' }, env({ agent: first.context }));
    const draft = runAgent({ type: 'choice', messageId: 'x', blockIndex: 0, value: 'aff:eu', label: 'Só eu' }, env({ agent: kbNo.context }));
    const message: Message = { id: 'm-draft', at: NOW.toISOString(), author: 'assistant', blocks: draft.blocks };

    const r = runAgent({ type: 'draft', messageId: 'm-draft', action: 'confirm' }, env({ messages: [message], agent: draft.context }));
    expect(r.effects).toEqual([{ type: 'create-ticket', messageId: 'm-draft', ticketId: 'INC-20520' }]);
    expect(texts(r.blocks)).toContain('abri o INC-20520 com prioridade média');
  });

  it('sugere acrescentar a um chamado já aberto sobre o mesmo assunto', () => {
    const r = runAgent({ type: 'text', text: 'Meu notebook continua muito lento' }, env());
    expect(r.blocks[0]).toEqual({ type: 'ticket', ticketId: 'INC-20311' });
    expect(texts(r.blocks)).toContain('Você já tem o INC-20311');
  });
});

describe('detalhe da decisão', () => {
  it('explica por que a prioridade ficou alta', () => {
    const first = runAgent({ type: 'text', text: 'Meu notebook não conecta na VPN desde ontem. Aparece o erro 809.' }, env());
    const r = runAgent({ type: 'text', text: 'Só eu. Tenho reunião com um cliente às 14h.' }, env({ agent: first.context }));
    expect(r.decision).toMatchObject({ trigger: 'Mensagem de texto', intent: 'Abrir um chamado', confidence: CONFIDENCE.keyword });
    expect(r.decision.understood).toContainEqual({ label: 'Urgência', value: '“reuniao”' });
    expect(r.decision.reasons.join(' ')).toContain('compromisso em risco → prioridade alta');
    expect(r.decision.reasons.join(' ')).toContain('Só cria o chamado depois da sua confirmação');
  });

  it('registra que o artigo não vale para o sistema da colaboradora', () => {
    const r = runAgent({ type: 'text', text: 'Meu notebook não conecta na VPN desde ontem. Aparece o erro 809.' }, env());
    expect(r.decision.understood).toEqual(
      expect.arrayContaining([
        { label: 'Categoria', value: 'Rede e VPN' },
        { label: 'Código de erro', value: '809' },
        { label: 'Sistema', value: 'Windows 11' },
      ]),
    );
    expect(r.decision.reasons).toContain('O artigo “VPN: erro 809 no Windows 10” vale só para Windows 10; o seu computador é Windows 11.');
  });

  it('dá confiança máxima a botões e mínima quando nada se aplica', () => {
    const button = runAgent({ type: 'choice', messageId: 'm', blockIndex: 0, value: 'start:status', label: 'Ver meus chamados' }, env());
    expect(button.decision).toMatchObject({ trigger: 'Botão “Ver meus chamados”', confidence: CONFIDENCE.explicit });

    const unknown = runAgent({ type: 'text', text: 'hmm' }, env());
    expect(unknown.decision).toMatchObject({ intent: 'Não identificada', confidence: CONFIDENCE.none });
  });

  it('justifica a recusa de um chamado de outra pessoa pela privacidade', () => {
    const r = runAgent({ type: 'text', text: 'e o INC-20502?' }, env());
    expect(r.decision.reasons[0]).toContain('por privacidade');
  });

  it('aponta o prazo vencido em dias úteis', () => {
    const r = runAgent({ type: 'pick-ticket', messageId: 'm', ticketId: 'INC-20311' }, env());
    expect(r.decision.action).toBe('Apontou o prazo vencido e ofereceu um analista');
    expect(r.decision.reasons.join(' ')).toContain('O prazo para prioridade média é 3 dias úteis a partir da última atualização; venceu em');
  });
});

/** Leva um relato até o rascunho, escolhendo quem é afetado. */
function draftFor(textIn: string, affected: string) {
  const first = runAgent({ type: 'text', text: textIn }, env());
  const ctx = first.context.awaiting === 'kb'
    ? runAgent({ type: 'choice', messageId: 'x', blockIndex: 0, value: 'kb:no', label: 'Não resolveu' }, env({ agent: first.context })).context
    : first.context;
  const r = runAgent({ type: 'choice', messageId: 'x', blockIndex: 0, value: `aff:${affected}`, label: affected }, env({ agent: ctx }));
  const block = r.blocks.find((b) => b.type === 'draft');
  if (block?.type !== 'draft') throw new Error('sem rascunho');
  return { r, draft: block.draft };
}

describe('regras do service desk (Anexo A)', () => {
  it('classifica pedido como requisição (REQ) de prioridade baixa', () => {
    const { draft } = draftFor('Preciso de uma licença do Adobe Acrobat para editar contratos', 'eu');
    expect(draft).toMatchObject({ kind: 'requisicao', category: 'Software', priority: 'baixa' });
  });

  it('classifica algo que parou como incidente (INC)', () => {
    const { draft } = draftFor('O Power BI não atualiza o painel de vendas', 'eu');
    expect(draft).toMatchObject({ kind: 'incidente', category: 'Software', priority: 'media' });
  });

  it('dá prioridade crítica quando algo para a equipe e transfere ao confirmar', () => {
    const { r: draft } = draftFor('A impressora do andar não imprime nada', 'equipe');
    const message: Message = { id: 'm-draft', at: NOW.toISOString(), author: 'assistant', blocks: draft.blocks };
    const r = runAgent({ type: 'draft', messageId: 'm-draft', action: 'confirm' }, env({ messages: [message], agent: draft.context }));
    expect(r.effects).toMatchObject([
      { type: 'create-ticket', ticketId: 'INC-20520' },
      { type: 'handoff', ticketId: 'INC-20520', summary: { reason: expect.stringContaining('crítico') } },
    ]);
    expect(texts(r.blocks)).toContain('Como é crítico, já chamei um analista');
  });

  it('usa os prazos do Anexo A', () => {
    const { r } = draftFor('A impressora do andar não imprime nada', 'eu');
    // Média: 3 dias úteis a partir de quarta, 21/10 → segunda, 26/10.
    expect(texts(r.blocks)).toContain('resposta até 26/10 às 11:43');
  });

  it('oferece reabrir um chamado resolvido há menos de 7 dias em vez de abrir outro', () => {
    const r = runAgent({ type: 'text', text: 'Minha senha do SAP bloqueou de novo' }, env());
    expect(r.blocks[0]).toEqual({ type: 'ticket', ticketId: 'INC-20150' });
    expect(texts(r.blocks)).toContain('posso reabrir ele');

    const reopen = runAgent({ type: 'choice', messageId: 'x', blockIndex: 1, value: 'tk:reabrir', label: 'Reabrir o chamado' }, env({ agent: r.context }));
    expect(reopen.effects).toEqual([{ type: 'reopen', ticketId: 'INC-20150', text: 'Minha senha do SAP bloqueou de novo' }]);
  });

  it('não oferece reabrir chamado resolvido há mais de 7 dias', () => {
    const r = runAgent({ type: 'pick-ticket', messageId: 'm', ticketId: 'INC-19877' }, env());
    const choices = r.blocks.flatMap((b) => (b.type === 'text' ? b.choices ?? [] : [])).map((c) => c.value);
    expect(choices).not.toContain('tk:reabrir');
  });

  it('redireciona assuntos fora de TI', () => {
    const r = runAgent({ type: 'text', text: 'Quero saber quando caem minhas férias' }, env());
    expect(r.decision.intent).toBe('Fora do escopo de TI');
    expect(texts(r.blocks)).toContain('Esse assunto é do RH');
    expect(r.effects).toEqual([]);
  });

  it('não confunde pedido de TI com assunto de outra área', () => {
    const r = runAgent({ type: 'text', text: 'Preciso de acesso à pasta Financeiro do SharePoint' }, env());
    expect(r.decision.intent).not.toBe('Fora do escopo de TI');
  });

  it('chama um analista quando não entende duas vezes seguidas', () => {
    const first = runAgent({ type: 'text', text: 'hmm' }, env());
    expect(first.effects).toEqual([]);
    const second = runAgent({ type: 'text', text: 'ahn' }, env({ agent: first.context }));
    expect(second.effects).toMatchObject([{ type: 'handoff', lowConfidence: CONFIDENCE.none }]);
    expect(texts(second.blocks)).toContain('Não consegui entender');
  });

  it('responde o horário do service desk pela central de ajuda', () => {
    const r = runAgent({ type: 'text', text: 'Qual o horário do service desk?' }, env());
    expect(texts(r.blocks)).toContain('das 8h às 18h');
    expect(r.tools).toEqual(['buscou na central de ajuda']);
  });
});

const llm = (partial: Partial<Interpretation>): Interpretation => ({ intent: 'relatar_problema', understood: 'entendido', confidence: 0.9, reasons: ['motivo do modelo'], ...partial });
const withLlm = (it: Interpretation, conversation?: Partial<Conversation>): AgentEnv => ({
  ...env(conversation),
  interpretation: it,
  source: { kind: 'llm', model: 'gemini-teste', tokens: 500 },
});

describe('interpretação pelo modelo', () => {
  it('usa a categoria, o tipo e o título do modelo quando as regras não reconhecem o assunto', () => {
    const it1 = llm({ category: 'Software', kind: 'requisicao', title: 'Acesso ao Miro para a equipe de design' });
    const first = runAgent({ type: 'text', text: 'Gostaria de usar aquele quadro branco online' }, withLlm(it1));
    expect(first.context.awaiting).toBe('affected');
    const draft = runAgent({ type: 'choice', messageId: 'x', blockIndex: 0, value: 'aff:eu', label: 'Só eu' }, env({ agent: first.context }));
    const block = draft.blocks.find((b) => b.type === 'draft');
    expect(block?.type === 'draft' && block.draft).toMatchObject({ category: 'Software', kind: 'requisicao', title: 'Acesso ao Miro para a equipe de design', priority: 'baixa' });
  });

  it('não pergunta quem é afetado quando a mensagem já disse', () => {
    const r = runAgent(
      { type: 'text', text: 'A internet caiu para o andar inteiro, ninguém da minha equipe consegue trabalhar' },
      withLlm(llm({ category: 'Rede e VPN', affected: 'equipe', urgency: 'ninguém consegue trabalhar' })),
    );
    const block = r.blocks.find((b) => b.type === 'draft');
    expect(block?.type === 'draft' && block.draft.priority).toBe('critica');
  });

  it('ignora "afetados" inventado pelo modelo e pergunta', () => {
    const r = runAgent({ type: 'text', text: 'queria usar aquele quadro branco online nas reuniões' }, withLlm(llm({ category: 'Software', kind: 'requisicao', affected: 'eu' })));
    expect(r.context.awaiting).toBe('affected');
    expect(r.blocks.some((b) => b.type === 'draft')).toBe(false);
  });

  it('mostra no detalhe o entendimento, os motivos e a origem do modelo', () => {
    const r = runAgent({ type: 'text', text: 'Como faço pra instalar o Figma?' }, withLlm(llm({ intent: 'duvida', kbArticleId: 'instalar-software', understood: 'Quer instalar o Figma.' })));
    expect(r.decision.source).toMatchObject({ kind: 'llm', model: 'gemini-teste' });
    expect(r.decision.understood[0]).toEqual({ label: 'Entendimento', value: 'Quer instalar o Figma.' });
    expect(r.decision.reasons[0]).toBe('motivo do modelo');
    expect(texts(r.blocks)).toContain('Portal da Empresa › Software');
  });

  it('não inventa resposta para dúvida sem artigo', () => {
    const r = runAgent({ type: 'text', text: 'Qual a política de uso de IA generativa?' }, withLlm(llm({ intent: 'duvida' })));
    expect(texts(r.blocks)).toContain('Não encontrei isso na central de ajuda');
  });

  it('com confiança baixa, pergunta de novo em vez de agir', () => {
    const r = runAgent({ type: 'text', text: 'aquilo lá de novo' }, withLlm(llm({ intent: 'relatar_problema', confidence: 0.3 })));
    expect(r.decision.intent).toBe('Não identificada');
    expect(r.effects).toEqual([]);
  });

  it('confirma antes de complementar um chamado', () => {
    const r = runAgent({ type: 'text', text: 'Agora o notebook também trava ao abrir o Excel' }, withLlm(llm({ intent: 'complementar_chamado', ticketId: 'INC-20311' })));
    expect(r.effects).toEqual([]);
    expect(texts(r.blocks)).toContain('Quer que eu acrescente isso ao INC-20311?');
  });

  it('não mostra chamado de outra pessoa mesmo que o modelo aponte para ele', () => {
    const r = runAgent({ type: 'text', text: 'como está o INC-20502?' }, withLlm(llm({ intent: 'consultar_chamados', ticketId: 'INC-20502' })));
    expect(texts(r.blocks)).toContain('Não encontrei o INC-20502 entre os seus chamados');
    expect(r.blocks.some((b) => b.type === 'ticket' && b.ticketId === 'INC-20502')).toBe(false);
  });

  it('marca botões como decididos pelas regras, sem modelo', () => {
    const r = runAgent({ type: 'choice', messageId: 'm', blockIndex: 0, value: 'start:status', label: 'Ver meus chamados' }, env());
    expect(r.decision.source).toMatchObject({ kind: 'regras', note: expect.stringContaining('não precisa do modelo') });
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
