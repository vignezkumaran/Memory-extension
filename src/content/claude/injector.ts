import { DomElementNotFoundError } from '../../shared/errors';
import { logWithContext } from '../../shared/logger';
import type { Conversation, InjectMessage, StatusMessage } from '../../shared/types';
import { getEditorWithRetry, setEditorContent } from './editor-handler';

const STATUS_ID = 'ai-memory-claude-status';

function summarizeConversation(conversation: Conversation): string {
  const userMessages = conversation.messages.filter((message) => message.role === 'user').length;
  const assistantMessages = conversation.messages.filter((message) => message.role === 'assistant').length;
  const preview = conversation.messages[0]?.content.slice(0, 160) ?? 'No preview available.';

  return `Summary: ${userMessages} user messages, ${assistantMessages} assistant messages.\nPreview: ${preview}`;
}

function formatConversation(conversation: Conversation, format: InjectMessage['payload']['format']): string {
  const header = `--- Previous conversation from ChatGPT ---\nTitle: ${conversation.title ?? 'Untitled'}\n`;

  if (format === 'summary') {
    return `${header}${summarizeConversation(conversation)}`;
  }

  const bodyMessages = format === 'last-only'
    ? conversation.messages.slice(-1)
    : conversation.messages;

  const body = bodyMessages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join('\n\n');

  return `${header}${body}`;
}

function ensureStatusElement(): HTMLDivElement {
  const existing = document.getElementById(STATUS_ID);
  if (existing instanceof HTMLDivElement) {
    return existing;
  }

  const node = document.createElement('div');
  node.id = STATUS_ID;
  node.style.position = 'fixed';
  node.style.bottom = '20px';
  node.style.right = '20px';
  node.style.zIndex = '2147483647';
  node.style.padding = '8px 12px';
  node.style.borderRadius = '10px';
  node.style.border = '1px solid currentColor';
  node.style.background = 'Canvas';
  node.style.color = 'CanvasText';
  node.style.fontSize = '12px';
  document.body.appendChild(node);
  return node;
}

function renderStatus(message: string, success: boolean): void {
  const statusElement = ensureStatusElement();
  statusElement.textContent = message;
  statusElement.style.opacity = success ? '1' : '0.9';

  window.setTimeout(() => {
    statusElement.remove();
  }, 3000);
}

/**
 * Injects formatted conversation text into Claude's editor.
 */
export async function injectConversationToClaude(message: InjectMessage): Promise<StatusMessage> {
  try {
    const editor = await getEditorWithRetry();
    const formatted = formatConversation(message.payload.conversation, message.payload.format);
    setEditorContent(editor, formatted);

    const status: StatusMessage = {
      type: 'INJECTION_STATUS',
      payload: {
        success: true,
        messageCount: message.payload.conversation.messages.length
      }
    };

    renderStatus('Memory injected successfully.', true);
    return status;
  } catch (error) {
    const reason = error instanceof DomElementNotFoundError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);

    logWithContext('error', 'Failed Claude injection', { reason });
    renderStatus('Failed to inject memory.', false);

    return {
      type: 'INJECTION_STATUS',
      payload: {
        success: false,
        error: reason
      }
    };
  }
}
