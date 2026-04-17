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

const PERPLEXITY_MESSAGE_SELECTORS = [
	'[data-message-author-role]',
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
	'main .prose'
] as const;

function normalizeMessageText(rawText: string): string {
	return rawText.replace(/\s+/g, ' ').trim();
}

function inferPerplexityRole(node: Element, text: string): Message['role'] {
	const explicitRole = node.getAttribute('data-message-author-role');
	if (explicitRole === 'user' || explicitRole === 'assistant' || explicitRole === 'system') {
		return explicitRole;
	}

	const testId = (node.getAttribute('data-testid') ?? '').toLowerCase();
	const ariaLabel = (node.getAttribute('aria-label') ?? '').toLowerCase();
	const className = (node.getAttribute('class') ?? '').toLowerCase();
	const roleHint = `${testId} ${ariaLabel} ${className}`;

	if (roleHint.includes('query') || roleHint.includes('prompt') || roleHint.includes('user')) {
		return 'user';
	}

	if (roleHint.includes('assistant') || roleHint.includes('answer') || roleHint.includes('response')) {
		return 'assistant';
	}

	if (/^you\s*[:\-]/i.test(text)) {
		return 'user';
	}

	return 'assistant';
}

async function waitForPerplexityMessages(timeoutMs = 12_000): Promise<boolean> {
	const hasMessages = (): boolean => {
		const nodes = document.querySelectorAll(PERPLEXITY_MESSAGE_SELECTORS.join(','));
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

function buildPerplexityTitle(messages: Message[]): string {
	const firstUser = messages.find((item) => item.role === 'user');
	if (firstUser?.content) {
		return firstUser.content.slice(0, 80);
	}

	return messages[0]?.content.slice(0, 80) ?? 'Perplexity Conversation';
}

function extractPerplexityConversation(): Conversation | null {
	const containers = Array.from(document.querySelectorAll(PERPLEXITY_MESSAGE_SELECTORS.join(',')));
	const messages: Message[] = [];
	const seen = new Set<string>();

	for (const container of containers) {
		const text = normalizeMessageText(container.textContent ?? '');
		if (!text || text.length < 8) {
			continue;
		}

		const role = inferPerplexityRole(container, text);
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
		title: buildPerplexityTitle(messages),
		messages,
		createdAt: Date.now(),
		source: 'perplexity'
	};
}

function savePerplexityConversationToBackground(conversation: Conversation): Promise<void> {
	return new Promise((resolve, reject) => {
		chrome.runtime.sendMessage({ type: 'SAVE_CONVERSATION', payload: { conversation } }, (response: unknown) => {
			const runtimeError = chrome.runtime.lastError;
			if (runtimeError) {
				reject(new Error(runtimeError.message));
				return;
			}

			const type = (response as { type?: string } | undefined)?.type;
			if (type !== 'SAVE_RESULT') {
				reject(new Error('Unable to save Perplexity conversation.'));
				return;
			}

			resolve();
		});
	});
}

function findPerplexityEditor(): HTMLTextAreaElement | HTMLDivElement | null {
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

function formatInjectContent(message: InjectMessage): string {
        if (message.payload.preparedPrompt && message.payload.preparedPrompt.trim().length > 0) {
                return message.payload.preparedPrompt;
        }

        return message.payload.conversation.messages
                .map((item) => `${item.role.toUpperCase()}: ${item.content}`)
                .join('\n\n');
}

function injectIntoPerplexity(message: InjectMessage): { success: boolean; error?: string } {
	const editor = findPerplexityEditor();
	if (!editor) {
		return { success: false, error: 'Perplexity input editor not found.' };
	}

	const content = formatInjectContent(message);
	if (editor instanceof HTMLTextAreaElement) {
		editor.focus();
		const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
		descriptor?.set?.call(editor, content);
		editor.dispatchEvent(new Event('input', { bubbles: true }));
		editor.dispatchEvent(new Event('change', { bubbles: true }));
		return { success: true };
	}

	setEditableDivContent(editor, content);
	return { success: true };
}

const listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (message, _sender, sendResponse) => {
	void (async () => {
		try {
			if (isPopupCaptureRequestMessage(message)) {
				const foundMessages = await waitForPerplexityMessages();
				if (!foundMessages) {
					logWithContext('warn', 'Perplexity wait timed out, attempting extraction with current DOM', {
						source: 'perplexity'
					});
				}

				const conversation = extractPerplexityConversation();
				if (!conversation) {
					throw new MessageValidationError('No Perplexity conversation found to capture.');
				}

				await savePerplexityConversationToBackground(conversation);
				sendResponse({ success: true });
				return;
			}

			if (isInjectMessage(message)) {
				sendResponse(injectIntoPerplexity(message));
				return;
			}

			throw new MessageValidationError('Unsupported message in Perplexity content script.');
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

logWithContext('info', 'Perplexity content script initialized', { source: 'perplexity' });
