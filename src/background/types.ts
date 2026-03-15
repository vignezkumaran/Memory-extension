import type { Conversation, StorageSchema } from '../shared/types';

export const DEFAULT_SETTINGS: StorageSchema['settings'] = {
  autoSave: false,
  maxConversations: 200,
  defaultSource: 'chatgpt'
};

export interface ImportPayload {
  conversations: Conversation[];
}
