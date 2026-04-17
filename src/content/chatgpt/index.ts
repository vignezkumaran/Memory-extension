import { MessageValidationError } from '../../shared/errors';
import { logWithContext } from '../../shared/logger';
import type { BackgroundResponseMessage, InjectMessage } from '../../shared/types';
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

async function onSaveConversation(): Promise<boolean> {
  try {
    const conversation = await extractChatGPTConversation();
    if (!conversation) {
      logWithContext('warn', 'Skipping save because extraction returned null', { source: 'chatgpt' });
      return false;
    }

    const response = await sendSaveRequest(conversation.id, {
      type: 'SAVE_CONVERSATION',
      payload: { conversation }
    });

    if (response.type === 'SAVE_RESULT') {
      logWithContext('info', 'Conversation saved successfully', { id: response.payload.id });
      return true;
    }

    if (response.type === 'ERROR') {
      throw new MessageValidationError(`${response.payload.code}: ${response.payload.message}`);
    }

    throw new MessageValidationError(`Unexpected response type: ${response.type}`);
  } catch (error) {
    logWithContext('error', 'Failed to save ChatGPT conversation', {
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

interface PopupCaptureRequestMessage {
  type: 'POPUP_CAPTURE_CONTEXT';
}

function isPopupCaptureRequestMessage(value: unknown): value is PopupCaptureRequestMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  return (value as { type?: string }).type === 'POPUP_CAPTURE_CONTEXT';
}

function isInjectMessage(value: unknown): value is InjectMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<InjectMessage>;
  return candidate.type === 'INJECT_CONVERSATION' && !!candidate.payload?.conversation;
}

function findChatGPTEditor(): HTMLTextAreaElement | HTMLDivElement | null {
  const textArea = document.querySelector('textarea');
  if (textArea instanceof HTMLTextAreaElement) {
    return textArea;
  }

  const editable = document.querySelector('[contenteditable="true"]');
  if (editable instanceof HTMLDivElement) {
    return editable;
  }

  return null;
}

function formatInjectContent(message: InjectMessage): string {
  if (message.payload.preparedPrompt && message.payload.preparedPrompt.trim().length > 0) {
    return message.payload.preparedPrompt;
  }

  const prefix = `--- Previous conversation from ${message.payload.conversation.source.toUpperCase()} ---\n`;
  const body = message.payload.conversation.messages
    .map((item) => `${item.role.toUpperCase()}: ${item.content}`)
    .join('\n\n');

  return `${prefix}${body}`;
}

function injectIntoChatGPT(message: InjectMessage): { success: boolean; error?: string } {
  const editor = findChatGPTEditor();
  if (!editor) {
    return { success: false, error: 'ChatGPT input editor not found.' };
  }

  const content = formatInjectContent(message);
  if (editor instanceof HTMLTextAreaElement) {
    editor.focus();
    editor.value = content;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true };
  }

  editor.focus();
  editor.textContent = content;
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: content }));
  editor.dispatchEvent(new Event('change', { bubbles: true }));
  return { success: true };
}

const popupListener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (message, _sender, sendResponse) => {
  if (isPopupCaptureRequestMessage(message)) {
    void (async () => {
      try {
        const success = await onSaveConversation();
        sendResponse({
          success,
          error: success ? undefined : 'Unable to capture conversation on this ChatGPT page.'
        });
      } catch (error) {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    })();

    return true;
  }

  if (isInjectMessage(message)) {
    sendResponse(injectIntoChatGPT(message));
    return true;
  }

  return false;
};

chrome.runtime.onMessage.addListener(popupListener);

const cleanup = injectSaveButton(async () => {
  await onSaveConversation();
});
window.addEventListener('beforeunload', () => {
  cleanup();
  chrome.runtime.onMessage.removeListener(popupListener);
});
