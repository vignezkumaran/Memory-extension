import { MessageValidationError } from '../../shared/errors';
import { logWithContext } from '../../shared/logger';
import type { BackgroundResponseMessage } from '../../shared/types';
import { extractChatGPTConversation } from './extractor';
import { injectSaveButton } from './ui';

function isBackgroundResponseMessage(value: unknown): value is BackgroundResponseMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) {
    return false;
  }

  const type = (value as { type: string }).type;
  return (
    type === 'SAVE_RESULT' ||
    type === 'LIST_RESULT' ||
    type === 'DELETE_RESULT' ||
    type === 'EXPORT_RESULT' ||
    type === 'IMPORT_RESULT' ||
    type === 'ERROR'
  );
}

async function sendSaveRequest(conversationId: string, payload: unknown): Promise<BackgroundResponseMessage> {
  return new Promise<BackgroundResponseMessage>((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response: unknown) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      if (!isBackgroundResponseMessage(response)) {
        reject(new MessageValidationError('Missing response from background service worker.'));
        return;
      }

      resolve(response);
    });
  }).finally(() => {
    logWithContext('debug', 'Save request completed', { conversationId });
  });
}

async function onSaveConversation(): Promise<void> {
  try {
    const conversation = await extractChatGPTConversation();
    if (!conversation) {
      logWithContext('warn', 'Skipping save because extraction returned null', { source: 'chatgpt' });
      return;
    }

    const response = await sendSaveRequest(conversation.id, {
      type: 'SAVE_CONVERSATION',
      payload: { conversation }
    });

    if (response.type === 'SAVE_RESULT') {
      logWithContext('info', 'Conversation saved successfully', { id: response.payload.id });
      return;
    }

    if (response.type === 'ERROR') {
      throw new MessageValidationError(`${response.payload.code}: ${response.payload.message}`);
    }

    throw new MessageValidationError(`Unexpected response type: ${response.type}`);
  } catch (error) {
    logWithContext('error', 'Failed to save ChatGPT conversation', {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

interface PopupSaveRequestMessage {
  type: 'POPUP_SAVE_CHATGPT';
}

function isPopupSaveRequestMessage(value: unknown): value is PopupSaveRequestMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return (value as { type?: string }).type === 'POPUP_SAVE_CHATGPT';
}

const popupListener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (message, _sender, sendResponse) => {
  if (!isPopupSaveRequestMessage(message)) {
    return false;
  }

  void (async () => {
    try {
      await onSaveConversation();
      sendResponse({ success: true });
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })();

  return true;
};

chrome.runtime.onMessage.addListener(popupListener);

const cleanup = injectSaveButton(onSaveConversation);
window.addEventListener('beforeunload', () => {
  cleanup();
  chrome.runtime.onMessage.removeListener(popupListener);
});

export { extractChatGPTConversation };
