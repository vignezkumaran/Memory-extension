import type { Conversation, Message } from './types';

export function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<Message>;
  return (
    (candidate.role === 'user' || candidate.role === 'assistant' || candidate.role === 'system') &&
    typeof candidate.content === 'string' &&
    (candidate.timestamp === undefined || typeof candidate.timestamp === 'number')
  );
}

export function isConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<Conversation>;
  return (
    typeof candidate.id === 'string' &&
    Array.isArray(candidate.messages) &&
    candidate.messages.every(isMessage) &&
    typeof candidate.createdAt === 'number' &&
    (candidate.source === 'chatgpt' || candidate.source === 'claude' || candidate.source === 'perplexity')
  );
}
