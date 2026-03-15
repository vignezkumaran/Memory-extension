import { DEFAULT_SETTINGS } from './types';
import { ensureStorageArea, TypedStorage } from './storage';
import { MessageValidationError, StorageValidationError } from '../shared/errors';
import { isConversation } from '../shared/guards';
import { logWithContext } from '../shared/logger';
import type {
  BackgroundRequestMessage,
  BackgroundResponseMessage,
  Conversation,
  ConversationListItem,
  StorageSchema
} from '../shared/types';

const storage = new TypedStorage<StorageSchema>(ensureStorageArea());

async function getSettings(): Promise<StorageSchema['settings']> {
  const settings = await storage.get('settings');
  if (!settings) {
    await storage.set('settings', DEFAULT_SETTINGS);
    return DEFAULT_SETTINGS;
  }

  return { ...DEFAULT_SETTINGS, ...settings };
}

async function getConversations(): Promise<Record<string, Conversation>> {
  return (await storage.get('conversations')) ?? {};
}

function toListItems(conversations: Record<string, Conversation>): ConversationListItem[] {
  return Object.values(conversations)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((item) => ({
      id: item.id,
      title: item.title ?? 'Untitled Conversation',
      preview: item.messages[0]?.content.slice(0, 120) ?? '',
      messageCount: item.messages.length,
      source: item.source,
      createdAt: item.createdAt
    }));
}

async function enforceLimit(conversations: Record<string, Conversation>): Promise<Record<string, Conversation>> {
  const settings = await getSettings();
  const entries = Object.entries(conversations);
  if (entries.length <= settings.maxConversations) {
    return conversations;
  }

  entries.sort(([, left], [, right]) => right.createdAt - left.createdAt);
  const kept = entries.slice(0, settings.maxConversations);
  return Object.fromEntries(kept);
}

function makeErrorResponse(code: string, message: string): BackgroundResponseMessage {
  return {
    type: 'ERROR',
    payload: { code, message }
  };
}

function assertBackgroundRequest(value: unknown): asserts value is BackgroundRequestMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    throw new MessageValidationError('Invalid message shape from runtime sender.');
  }
}

function parseImportJson(raw: string): Conversation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StorageValidationError(`Invalid JSON payload: ${String(error)}`);
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { conversations?: unknown }).conversations)) {
    throw new StorageValidationError('Import payload must contain a conversations array.');
  }

  const conversations = (parsed as { conversations: unknown[] }).conversations;
  if (!conversations.every(isConversation)) {
    throw new StorageValidationError('Import payload contains invalid conversation entries.');
  }

  return conversations;
}

async function saveConversation(conversation: Conversation): Promise<BackgroundResponseMessage> {
  const existing = await getConversations();
  const next = { ...existing, [conversation.id]: conversation };
  const trimmed = await enforceLimit(next);
  await storage.set('conversations', trimmed);

  const lastAccessed = (await storage.get('lastAccessed')) ?? {};
  lastAccessed[conversation.id] = Date.now();
  await storage.set('lastAccessed', lastAccessed);

  return {
    type: 'SAVE_RESULT',
    payload: { success: true, id: conversation.id }
  };
}

async function handleMessage(request: BackgroundRequestMessage): Promise<BackgroundResponseMessage> {
  switch (request.type) {
    case 'SAVE_CONVERSATION': {
      if (!isConversation(request.payload.conversation)) {
        throw new MessageValidationError('SAVE_CONVERSATION payload has invalid shape.');
      }
      return saveConversation(request.payload.conversation);
    }
    case 'GET_CONVERSATION': {
      const all = await getConversations();
      const conversation = all[request.payload.id];
      if (!conversation) {
        return makeErrorResponse('NOT_FOUND', `Conversation with id ${request.payload.id} not found.`);
      }

      return {
        type: 'GET_RESULT',
        payload: { conversation }
      };
    }
    case 'LIST_CONVERSATIONS': {
      const list = toListItems(await getConversations());
      return { type: 'LIST_RESULT', payload: { conversations: list } };
    }
    case 'DELETE_CONVERSATION': {
      const all = await getConversations();
      delete all[request.payload.id];
      await storage.set('conversations', all);
      return { type: 'DELETE_RESULT', payload: { success: true, id: request.payload.id } };
    }
    case 'EXPORT_CONVERSATIONS': {
      const conversations = Object.values(await getConversations());
      return {
        type: 'EXPORT_RESULT',
        payload: {
          json: JSON.stringify({ conversations }, null, 2)
        }
      };
    }
    case 'IMPORT_CONVERSATIONS': {
      const parsed = parseImportJson(request.payload.raw);
      const current = await getConversations();
      const merged: Record<string, Conversation> = { ...current };

      for (const conversation of parsed) {
        merged[conversation.id] = conversation;
      }

      const trimmed = await enforceLimit(merged);
      await storage.set('conversations', trimmed);

      return {
        type: 'IMPORT_RESULT',
        payload: { imported: parsed.length }
      };
    }
    default:
      return makeErrorResponse('UNSUPPORTED_MESSAGE', `Unhandled message type: ${(request as { type: string }).type}`);
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  void (async () => {
    try {
      assertBackgroundRequest(message);
      const response = await handleMessage(message);
      sendResponse(response);
      logWithContext('info', 'Background message handled', { type: message.type });
    } catch (error) {
      if (error instanceof MessageValidationError || error instanceof StorageValidationError) {
        sendResponse(makeErrorResponse(error.code, error.message));
        return;
      }

      logWithContext('error', 'Unhandled background error', {
        error: error instanceof Error ? error.message : String(error)
      });
      sendResponse(makeErrorResponse('UNEXPECTED_ERROR', 'Unexpected background failure.'));
    }
  })();

  return true;
});
