import { MessageValidationError } from '../../shared/errors';
import { logWithContext } from '../../shared/logger';
import type { InjectMessage, Message, Conversation } from '../../shared/types';
import { injectConversationToClaude } from './injector';
import { findClaudeEditor } from './editor-handler';

const teardownCallbacks: Array<() => void> = [];

interface PopupCaptureRequestMessage {
  type: 'POPUP_CAPTURE_CONTEXT';
}

function isPopupCaptureRequestMessage(value: unknown): value is PopupCaptureRequestMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return (value as { type?: string }).type === 'POPUP_CAPTURE_CONTEXT';
}

function inferClaudeRole(text: string): Message['role'] {
  const lower = text.toLowerCase();
  if (lower.startsWith('you') || lower.startsWith('human') || lower.startsWith('user')) {
    return 'user';
  }

  if (lower.startsWith('system')) {
    return 'system';
  }

  return 'assistant';
}

function extractClaudeConversation(): Conversation | null {
  const containers = Array.from(document.querySelectorAll('main [data-testid], main article, main .prose'));
  const messages: Message[] = [];

  for (const container of containers) {
    const text = container.textContent?.trim();
    if (!text || text.length < 6) {
      continue;
    }

    const role = inferClaudeRole(text);
    messages.push({ role, content: text });
  }

  if (messages.length === 0) {
    return null;
  }

  return {
    id: crypto.randomUUID(),
    title: messages[0]?.content.slice(0, 80) ?? 'Claude Conversation',
    messages,
    createdAt: Date.now(),
    source: 'claude'
  };
}

function saveClaudeConversationToBackground(conversation: Conversation): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'SAVE_CONVERSATION', payload: { conversation } }, (response: unknown) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      const type = (response as { type?: string } | undefined)?.type;
      if (type !== 'SAVE_RESULT') {
        reject(new Error('Unable to save Claude conversation.'));
        return;
      }

      resolve();
    });
  });
}

function isInjectMessage(value: unknown): value is InjectMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<InjectMessage>;
  return candidate.type === 'INJECT_CONVERSATION' && !!candidate.payload?.conversation;
}

const listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (message, _sender, sendResponse) => {
  void (async () => {
    try {
      if (isPopupCaptureRequestMessage(message)) {
        const conversation = extractClaudeConversation();
        if (!conversation) {
          throw new MessageValidationError('No Claude conversation found to capture.');
        }

        await saveClaudeConversationToBackground(conversation);
        sendResponse({ success: true });
        return;
      }

      if (!isInjectMessage(message)) {
        throw new MessageValidationError('Received unsupported message in Claude content script.');
      }

      const status = await injectConversationToClaude(message);
      sendResponse(status);
    } catch (error) {
      logWithContext('error', 'Claude message handling failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      sendResponse({
        type: 'INJECTION_STATUS',
        payload: {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  })();

  return true;
};

chrome.runtime.onMessage.addListener(listener);
teardownCallbacks.push(() => chrome.runtime.onMessage.removeListener(listener));

if (!findClaudeEditor()) {
  logWithContext('warn', 'Claude editor not found during initialization; retrying via runtime calls.');
}

window.addEventListener('beforeunload', () => {
  teardownCallbacks.forEach((cleanup) => cleanup());
  teardownCallbacks.length = 0;
});
