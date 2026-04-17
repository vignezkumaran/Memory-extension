import { MessageValidationError } from '../../shared/errors';
import { logWithContext } from '../../shared/logger';
import type { Conversation, InjectMessage, Message } from '../../shared/types';

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

const DEEPSEEK_MESSAGE_SELECTORS = [
  '[data-message-author-role]',
  '[data-role="user"]',
  '[data-role="assistant"]',
  '[data-testid*="message"]',
  '[data-testid*="query"]',
  '[data-testid*="answer"]',
  '[class*="message"]',
  '[class*="assistant"]',
  '[class*="user"]',
  'article',
  'main article',
  'main [data-testid*="message"]',
  'main [data-testid*="query"]',
  'main [data-testid*="answer"]',
  'main .message',
  'main .markdown'
] as const;

function normalizeMessageText(rawText: string): string {
  return rawText.replace(/\s+/g, ' ').trim();
}

function inferRole(node: Element, text: string): Message['role'] {
  const explicitRole = node.getAttribute('data-message-author-role');
  if (explicitRole === 'user' || explicitRole === 'assistant' || explicitRole === 'system') {
    return explicitRole;
  }

  const dataRole = (node.getAttribute('data-role') ?? '').toLowerCase();
  if (dataRole === 'user') {
    return 'user';
  }

  if (dataRole === 'assistant' || dataRole === 'bot') {
    return 'assistant';
  }

  const testId = (node.getAttribute('data-testid') ?? '').toLowerCase();
  const ariaLabel = (node.getAttribute('aria-label') ?? '').toLowerCase();
  const className = (node.getAttribute('class') ?? '').toLowerCase();
  const hint = `${testId} ${ariaLabel} ${className}`;

  if (hint.includes('query') || hint.includes('prompt') || hint.includes('user')) {
    return 'user';
  }

  if (hint.includes('assistant') || hint.includes('answer') || hint.includes('response') || hint.includes('bot')) {
    return 'assistant';
  }

  const lower = text.toLowerCase();
  if (lower.startsWith('you') || lower.startsWith('user') || lower.startsWith('human')) {
    return 'user';
  }

  if (lower.startsWith('system')) {
    return 'system';
  }

  return 'assistant';
}

async function waitForDeepSeekMessages(timeoutMs = 12_000): Promise<boolean> {
  const hasMessages = (): boolean => {
    const nodes = document.querySelectorAll(DEEPSEEK_MESSAGE_SELECTORS.join(','));
    return Array.from(nodes).some((node) => normalizeMessageText(node.textContent ?? '').length > 8);
  };

  if (hasMessages()) {
    return true;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;

    const observer = new MutationObserver(() => {
      if (hasMessages()) {
        settled = true;
        observer.disconnect();
        window.clearTimeout(timeoutId);
        resolve(true);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    const timeoutId = window.setTimeout(() => {
      if (settled) {
        return;
      }

      observer.disconnect();
      resolve(false);
    }, timeoutMs);
  });
}

function buildDeepSeekTitle(messages: Message[]): string {
  const firstUser = messages.find((item) => item.role === 'user');
  if (firstUser?.content) {
    return firstUser.content.slice(0, 80);
  }

  return messages[0]?.content.slice(0, 80) ?? 'DeepSeek Conversation';
}

function extractDeepSeekConversation(): Conversation | null {
  const candidates = Array.from(document.querySelectorAll(DEEPSEEK_MESSAGE_SELECTORS.join(',')));
  const messages: Message[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const text = normalizeMessageText(candidate.textContent ?? '');
    if (!text || text.length < 8) {
      continue;
    }

    const role = inferRole(candidate, text);
    const fingerprint = `${role}:${text}`;
    if (seen.has(fingerprint)) {
      continue;
    }

    seen.add(fingerprint);
    messages.push({ role, content: text });
  }

  if (messages.length === 0) {
    return null;
  }

  return {
    id: crypto.randomUUID(),
    title: buildDeepSeekTitle(messages),
    messages,
    createdAt: Date.now(),
    source: 'deepseek'
  };
}

function saveConversation(conversation: Conversation): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'SAVE_CONVERSATION', payload: { conversation } }, (response: unknown) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      const responseType = (response as { type?: string } | undefined)?.type;
      if (responseType !== 'SAVE_RESULT') {
        reject(new Error('Unable to save DeepSeek conversation.'));
        return;
      }

      resolve();
    });
  });
}

function formatInjection(message: InjectMessage): string {
  if (message.payload.preparedPrompt && message.payload.preparedPrompt.trim().length > 0) {
    return message.payload.preparedPrompt;
  }

  return message.payload.conversation.messages
    .map((item) => `${item.role.toUpperCase()}: ${item.content}`)
    .join('\n\n');
}

function findDeepSeekEditor(): HTMLTextAreaElement | HTMLDivElement | null {
  const chatTextarea = document.querySelector('textarea[placeholder], textarea');
  if (chatTextarea instanceof HTMLTextAreaElement) {
    return chatTextarea;
  }

  const textbox = document.querySelector('div[contenteditable="true"][role="textbox"]');
  if (textbox instanceof HTMLDivElement) {
    return textbox;
  }

  const prose = document.querySelector('.ProseMirror[contenteditable="true"]');
  if (prose instanceof HTMLDivElement) {
    return prose;
  }

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

function setEditableDivContent(editor: HTMLDivElement, content: string): void {
  editor.focus();
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  if (typeof document.execCommand === 'function') {
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
    document.execCommand('insertText', false, content);
  } else {
    editor.textContent = content;
  }

  editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText' }));
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: content }));
  editor.dispatchEvent(new Event('change', { bubbles: true }));
}

function injectIntoDeepSeek(message: InjectMessage): { success: boolean; error?: string } {
  const editor = findDeepSeekEditor();
  if (!editor) {
    return { success: false, error: 'DeepSeek input editor not found.' };
  }

  const formatted = formatInjection(message);
  if (editor instanceof HTMLTextAreaElement) {
    editor.focus();
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    descriptor?.set?.call(editor, formatted);
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    return { success: true };
  }

  setEditableDivContent(editor, formatted);
  return { success: true };
}

const listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (message, _sender, sendResponse) => {
  void (async () => {
    try {
      if (isPopupCaptureRequestMessage(message)) {
        const foundMessages = await waitForDeepSeekMessages();
        if (!foundMessages) {
          logWithContext('warn', 'DeepSeek wait timed out, attempting extraction with current DOM', {
            source: 'deepseek'
          });
        }

        const conversation = extractDeepSeekConversation();
        if (!conversation) {
          throw new MessageValidationError('No DeepSeek conversation found to capture.');
        }

        await saveConversation(conversation);
        sendResponse({ success: true });
        return;
      }

      if (isInjectMessage(message)) {
        sendResponse(injectIntoDeepSeek(message));
        return;
      }

      throw new MessageValidationError('Unsupported message in DeepSeek content script.');
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  })();

  return true;
};

chrome.runtime.onMessage.addListener(listener);

window.addEventListener('beforeunload', () => {
  chrome.runtime.onMessage.removeListener(listener);
});

logWithContext('info', 'DeepSeek content script initialized', { source: 'deepseek' });
