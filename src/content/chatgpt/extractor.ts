import { DomElementNotFoundError, ExtensionError } from '../../shared/errors';
import { logWithContext } from '../../shared/logger';
import type { Conversation, Message } from '../../shared/types';

const AUTHOR_SELECTOR = '[data-message-author-role]';
const USER_SELECTOR = '[data-message-author-role="user"]';
const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';

async function waitForDocumentReady(): Promise<void> {
  if (document.readyState === 'complete') {
    return;
  }

  await new Promise<void>((resolve) => {
    window.addEventListener('load', () => resolve(), { once: true });
  });
}

async function waitForMessages(timeoutMs = 12_000): Promise<void> {
  await waitForDocumentReady();

  const hasMessages = (): boolean => {
    const user = document.querySelector(USER_SELECTOR);
    const assistant = document.querySelector(ASSISTANT_SELECTOR);
    return Boolean(user || assistant);
  };

  if (hasMessages()) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const observer = new MutationObserver(() => {
      if (hasMessages()) {
        settled = true;
        observer.disconnect();
        window.clearTimeout(timeoutId);
        resolve();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    const timeoutId = window.setTimeout(() => {
      if (settled) {
        return;
      }

      observer.disconnect();
      reject(new DomElementNotFoundError(AUTHOR_SELECTOR));
    }, timeoutMs);
  });
}

function extractTextContent(element: Element): string {
  const text = element.textContent?.trim() ?? '';
  return text.replace(/\n{3,}/g, '\n\n');
}

function inferTitle(messages: Message[]): string {
  const firstUser = messages.find((message) => message.role === 'user');
  if (!firstUser) {
    return 'ChatGPT Conversation';
  }

  return firstUser.content.slice(0, 80) || 'ChatGPT Conversation';
}

/**
 * Extracts ChatGPT conversation messages from the current page.
 *
 * Note: ChatGPT does not reliably expose original per-message timestamps in the DOM,
 * so `createdAt` reflects extraction time and message-level `timestamp` is omitted.
 */
export async function extractChatGPTConversation(): Promise<Conversation | null> {
  try {
    await waitForMessages();

    const nodes = Array.from(document.querySelectorAll(AUTHOR_SELECTOR));
    if (nodes.length === 0) {
      throw new DomElementNotFoundError(AUTHOR_SELECTOR);
    }

    const messages: Message[] = [];
    for (const node of nodes) {
      const roleValue = node.getAttribute('data-message-author-role');
      if (roleValue !== 'user' && roleValue !== 'assistant' && roleValue !== 'system') {
        continue;
      }

      const content = extractTextContent(node);
      if (!content) {
        continue;
      }

      messages.push({
        role: roleValue,
        content
      });
    }

    if (messages.length === 0) {
      logWithContext('warn', 'No message content found during extraction', { source: 'chatgpt' });
      return null;
    }

    const createdAt = Date.now();
    return {
      id: crypto.randomUUID(),
      title: inferTitle(messages),
      messages,
      createdAt,
      source: 'chatgpt'
    };
  } catch (error) {
    if (error instanceof DomElementNotFoundError) {
      logWithContext('warn', 'ChatGPT extraction failed due to missing message elements', {
        error: error.message
      });
      return null;
    }

    if (error instanceof ExtensionError) {
      logWithContext('error', 'Known extension error while extracting ChatGPT conversation', {
        code: error.code,
        error: error.message
      });
      return null;
    }

    logWithContext('error', 'Unexpected extraction error', {
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}
