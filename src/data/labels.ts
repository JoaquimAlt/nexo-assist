import type { Affected, Priority, TicketStatus } from './types';

export type Tone = 'amber' | 'blue' | 'green' | 'gray' | 'red';

export const TICKET_STATUS: Record<TicketStatus, { label: string; tone: Tone }> = {
  aguardando_analista: { label: 'Aguardando analista', tone: 'amber' },
  em_atendimento: { label: 'Em atendimento', tone: 'blue' },
  em_andamento: { label: 'Em andamento', tone: 'blue' },
  aprovado: { label: 'Aprovado', tone: 'green' },
  resolvido: { label: 'Resolvido', tone: 'gray' },
};

export const PRIORITY: Record<Priority, { label: string; tone: Tone }> = {
  baixa: { label: 'Baixa', tone: 'gray' },
  media: { label: 'Média', tone: 'gray' },
  alta: { label: 'Alta', tone: 'amber' },
  critica: { label: 'Crítica', tone: 'red' },
};

export const AFFECTED: Record<Affected, string> = {
  eu: 'Somente você',
  equipe: 'Sua equipe',
  empresa: 'Toda a empresa',
  nao_sei: 'Não informado',
};

export const CATEGORIES = [
  'Rede e VPN',
  'Hardware › Notebook',
  'Periféricos',
  'Impressão',
  'E-mail e colaboração',
  'Acessos',
  'Sistemas',
  'Outros',
];
