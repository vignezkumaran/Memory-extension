export type ConversationSource = 'chatgpt' | 'claude' | 'perplexity';

/**
 * A single conversation message.
 */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
}

/**
 * Persisted conversation entity.
 */
export interface Conversation {
  id: string;
  title?: string;
  messages: Message[];
  createdAt: number;
  source: ConversationSource;
}

/**
 * Storage shape used by background worker.
 */
export interface StorageSchema {
  conversations: Record<string, Conversation>;
  settings: {
    autoSave: boolean;
    maxConversations: number;
    defaultSource?: ConversationSource;
  };
  lastAccessed: Record<string, number>;
}

export interface ConversationListItem {
  id: string;
  title: string;
  preview: string;
  messageCount: number;
  source: ConversationSource;
  createdAt: number;
}

export interface InjectMessage {
  type: 'INJECT_CONVERSATION';
  payload: {
    conversation: Conversation;
    format: 'full' | 'summary' | 'last-only';
  };
}

export interface StatusMessage {
  type: 'INJECTION_STATUS';
  payload: {
    success: boolean;
    error?: string;
    messageCount?: number;
  };
}

export interface SaveConversationMessage {
  type: 'SAVE_CONVERSATION';
  payload: {
    conversation: Conversation;
  };
}

export interface ListConversationsMessage {
  type: 'LIST_CONVERSATIONS';
}

export interface DeleteConversationMessage {
  type: 'DELETE_CONVERSATION';
  payload: {
    id: string;
  };
}

export interface ExportConversationsMessage {
  type: 'EXPORT_CONVERSATIONS';
}

export interface ImportConversationsMessage {
  type: 'IMPORT_CONVERSATIONS';
  payload: {
    raw: string;
  };
}

export interface GetConversationMessage {
  type: 'GET_CONVERSATION';
  payload: {
    id: string;
  };
}

export type BackgroundRequestMessage =
  | SaveConversationMessage
  | ListConversationsMessage
  | DeleteConversationMessage
  | ExportConversationsMessage
  | ImportConversationsMessage
  | GetConversationMessage;

export type BackgroundResponseMessage =
  | { type: 'SAVE_RESULT'; payload: { success: true; id: string } }
  | { type: 'LIST_RESULT'; payload: { conversations: ConversationListItem[] } }
  | { type: 'DELETE_RESULT'; payload: { success: boolean; id: string } }
  | { type: 'EXPORT_RESULT'; payload: { json: string } }
  | { type: 'IMPORT_RESULT'; payload: { imported: number } }
  | {
      type: 'GET_RESULT';
      payload: { conversation: Conversation };
    }
  | { type: 'ERROR'; payload: { code: string; message: string } };

export type RuntimeMessage =
  | BackgroundRequestMessage
  | BackgroundResponseMessage
  | InjectMessage
  | StatusMessage;
