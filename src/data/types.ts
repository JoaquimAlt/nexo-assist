export type Role = 'colaborador' | 'analista';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  department: string;
  team?: string;
  os?: string;
  /** Índice da paleta de avatar (0–6). */
  color: number;
  online: boolean;
  passwordChangedAt: string;
}

export type Priority = 'baixa' | 'media' | 'alta' | 'critica';
export type TicketStatus = 'aguardando_analista' | 'em_atendimento' | 'em_andamento' | 'aprovado' | 'resolvido';

export interface TicketNote {
  at: string;
  author: string;
  text: string;
}

export interface Ticket {
  id: string;
  title: string;
  shortTitle?: string;
  description: string;
  category: string;
  priority: Priority;
  status: TicketStatus;
  requesterId: string;
  openedAt: string;
  updatedAt: string;
  resolvedAt?: string;
  assignee?: string;
  assignedAt?: string;
  notes: TicketNote[];
}

export type Affected = 'eu' | 'equipe' | 'empresa' | 'nao_sei';

/** Incidente (INC): algo parou ou não funciona. Requisição (REQ): pedido de acesso, equipamento ou software. */
export type TicketKind = 'incidente' | 'requisicao';

export interface TicketDraft {
  id: string;
  kind: TicketKind;
  title: string;
  description: string;
  category: string;
  priority: Priority;
  affected: Affected;
  createdAt: string;
}

export interface Choice {
  value: string;
  label: string;
}

export type Block =
  | { type: 'text'; text: string; question?: string; choices?: Choice[]; chosen?: string }
  | { type: 'ticket-picker'; ticketIds: string[]; selected?: string }
  | { type: 'ticket'; ticketId: string }
  | { type: 'draft'; draft: TicketDraft; state: 'pending' | 'confirmed' | 'cancelled'; ticketId?: string };

export interface DecisionFact {
  label: string;
  value: string;
}

/** Como o assistente chegou a uma resposta: o que entendeu, o que fez, com que segurança e por quê. */
export interface Decision {
  /** O que disparou a resposta: texto livre, botão, escolha na lista... */
  trigger: string;
  intent: string;
  understood: DecisionFact[];
  action: string;
  /** Segurança na interpretação, de 0 a 1. */
  confidence: number;
  reasons: string[];
}

export type EventIcon ='transfer' | 'headset' | 'bot' | 'check' | 'alert';

export interface Message {
  id: string;
  at: string;
  author: 'contact' | 'assistant' | 'analyst' | 'event';
  /** Texto do colaborador, do analista ou do evento (visão do analista). */
  text?: string;
  /** Conteúdo estruturado das respostas do assistente. */
  blocks?: Block[];
  /** Ferramentas que o assistente usou antes de responder. */
  tools?: string[];
  /** Detalhe da decisão por trás da resposta do assistente. */
  decision?: Decision;
  /** Resposta de erro: a entrada que pode ser reenviada. */
  retry?: AgentInput;
  analyst?: { name: string; team: string };
  /** Eventos têm um texto próprio para o colaborador. */
  event?: { icon: EventIcon; contactText?: string };
}

/**
 * agent    — o Nexo Assist está atendendo
 * help     — o agent pediu ajuda e está pausado
 * waiting  — transferida, aguardando um analista
 * human    — um analista assumiu
 * resolved — resolvida pelo agent
 * closed   — encerrada
 */
export type ConversationStatus = 'agent' | 'help' | 'waiting' | 'human' | 'resolved' | 'closed';

export interface ProblemInfo {
  text: string;
  extra?: string;
  topic: string;
}

export interface AgentContext {
  awaiting?: 'affected' | 'note' | 'kb';
  problem?: ProblemInfo;
  focusTicketId?: string;
  /** Respostas seguidas em que o agent não entendeu o pedido. */
  misses?: number;
}

export type AgentInput =
  | { type: 'text'; text: string }
  | { type: 'choice'; messageId: string; blockIndex: number; value: string; label: string }
  | { type: 'pick-ticket'; messageId: string; ticketId: string }
  | { type: 'draft'; messageId: string; action: 'confirm' | 'cancel' };

/** O que o analista recebe na transferência, para não perguntar tudo de novo. */
export interface HandoffSummary {
  reason: string;
  ticket?: string;
  report?: string;
  /** O que o agent já fez na conversa. */
  tried: string[];
}

export interface Conversation {
  id: string;
  contactId: string;
  status: ConversationStatus;
  createdAt: string;
  messages: Message[];
  ticketId?: string;
  queue?: string;
  waitingSince?: string;
  waitingDeadline?: string;
  confidence?: number;
  assigneeId?: string;
  assignedAt?: string;
  lastReadAt?: string;
  closedAt?: string;
  agent: AgentContext;
  handoff?: HandoffSummary;
  pending?: {
    tools: string[];
    startedAt: string;
    durationMs: number;
    /** Aviso enquanto o sistema de chamados é consultado de novo. */
    notice?: string;
  };
  contactTypingUntil?: number;
  analystTypingUntil?: number;
}

export interface DB {
  version: number;
  users: User[];
  tickets: Ticket[];
  conversations: Conversation[];
  seq: { inc: number; req: number; draft: number };
  analystAvailable: boolean;
}
