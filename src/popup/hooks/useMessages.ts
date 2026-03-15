import { useCallback } from 'react';
import type { BackgroundRequestMessage, BackgroundResponseMessage, RuntimeMessage } from '../../shared/types';

function sendRuntimeMessage<TRequest extends BackgroundRequestMessage>(message: TRequest): Promise<BackgroundResponseMessage> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message as RuntimeMessage, (response: BackgroundResponseMessage | undefined) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      if (!response) {
        reject(new Error('No response from service worker.'));
        return;
      }

      resolve(response);
    });
  });
}

export function useMessages(): {
  getConversation: (id: string) => Promise<BackgroundResponseMessage>;
  listConversations: () => Promise<BackgroundResponseMessage>;
  deleteConversation: (id: string) => Promise<BackgroundResponseMessage>;
  exportConversations: () => Promise<BackgroundResponseMessage>;
} {
  const getConversation = useCallback(
    (id: string) => sendRuntimeMessage({ type: 'GET_CONVERSATION', payload: { id } }),
    []
  );
  const listConversations = useCallback(() => sendRuntimeMessage({ type: 'LIST_CONVERSATIONS' }), []);
  const deleteConversation = useCallback(
    (id: string) => sendRuntimeMessage({ type: 'DELETE_CONVERSATION', payload: { id } }),
    []
  );
  const exportConversations = useCallback(() => sendRuntimeMessage({ type: 'EXPORT_CONVERSATIONS' }), []);

  return {
    getConversation,
    listConversations,
    deleteConversation,
    exportConversations
  };
}
