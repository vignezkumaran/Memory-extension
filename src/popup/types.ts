import type { Conversation } from '../shared/types';

export interface PopupProps {
  onSelectConversation: (id: string) => void;
  onRequestDeleteConversation: (id: string) => void;
  onInjectConversation: (id: string) => void;
  canInject: boolean;
  injectDisabledReason: string | undefined;
}

export type SourceGroup = Record<string, ConversationListItem[]>;

export interface ConversationListItem {
  id: string;
  title: string;
  preview: string;
  messageCount: number;
  source: Conversation['source'];
  createdAt: number;
}
