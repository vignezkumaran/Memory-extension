import { MessageValidationError } from '../../shared/errors';
import { logWithContext } from '../../shared/logger';
import type { InjectMessage } from '../../shared/types';
import { injectConversationToClaude } from './injector';

const teardownCallbacks: Array<() => void> = [];

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

window.addEventListener('beforeunload', () => {
  teardownCallbacks.forEach((cleanup) => cleanup());
  teardownCallbacks.length = 0;
});
