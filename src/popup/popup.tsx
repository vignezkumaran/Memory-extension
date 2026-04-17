import { Component, type ErrorInfo, type ReactElement, type ReactNode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useMessages } from './hooks/useMessages';
import type { ConversationListItem } from './types';
import type { Conversation, InjectMessage } from '../shared/types';
import './popup.css';

class PopupErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  public constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  public static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  public componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error({ error, info });
  }

  public render(): ReactNode {
    if (this.state.hasError) {
      return <div style={{ padding: '12px' }}>An unexpected error occurred in the extension popup.</div>;
    }

    return this.props.children;
  }
}

type TabContext = 'chatgpt' | 'claude' | 'perplexity' | 'deepseek' | 'other';
type Screen = 'loading' | 'save' | 'list' | 'empty' | 'settings';
type ToastKind = 'success' | 'error';
type TransferStyle = 'brief' | 'structured' | 'actionable';

interface ToastState {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ExportPayload {
  conversations: Conversation[];
}

interface InjectionResult {
  success: boolean;
  error?: string;
}

function buildConversationSearchText(conversation: Conversation | undefined): string {
  if (!conversation) {
    return '';
  }

  const messageText = conversation.messages.map((message) => message.content).join(' ');
  return `${conversation.title ?? ''} ${messageText}`.toLowerCase();
}

function toRelativeTime(epochMs: number): string {
  const deltaMs = Date.now() - epochMs;
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) {
    return 'just now';
  }

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function compactLine(input: string, maxLength = 180): string {
  const text = normalizeText(input);
  if (!text) {
    return '';
  }

  const shortened = text.slice(0, maxLength);
  return shortened.length < text.length ? `${shortened.trimEnd()}...` : shortened;
}

function uniqueLines(lines: string[], max = 4): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const compact = compactLine(line);
    if (!compact) {
      continue;
    }

    const key = compact.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    out.push(compact);
    if (out.length >= max) {
      break;
    }
  }

  return out;
}

function buildContextPacket(
  conversation: Conversation,
  style: TransferStyle,
  objective: string,
  targetContext: TabContext
): string {
  const userHighlights = uniqueLines(
    conversation.messages.filter((message) => message.role === 'user').map((message) => message.content),
    4
  );
  const assistantHighlights = uniqueLines(
    conversation.messages.filter((message) => message.role === 'assistant').map((message) => message.content),
    4
  );

  const constraints = uniqueLines(
    conversation.messages
      .map((message) => message.content)
      .filter((content) => /\b(must|should|avoid|required|cannot|limit|deadline|budget)\b/i.test(content)),
    3
  );

  const openQuestions = uniqueLines(
    conversation.messages.map((message) => message.content).filter((content) => content.includes('?')),
    3
  );

  const latestUser = [...conversation.messages].reverse().find((message) => message.role === 'user');
  const objectiveLine = normalizeText(objective) || 'Continue from this context without repeating all prior chat history.';

  const styleInstruction =
    style === 'brief'
      ? 'Reply in a compact answer only.'
      : style === 'actionable'
        ? 'Reply with concrete, step-by-step actions and exact next outputs.'
        : 'Reply with short, structured sections.';

  return [
    `Context Packet (${conversation.source.toUpperCase()} -> ${getTabLabel(targetContext)})`,
    `Title: ${conversation.title ?? 'Untitled conversation'}`,
    `Goal: ${objectiveLine}`,
    '',
    'User Intent:',
    ...(userHighlights.length > 0 ? userHighlights.map((line) => `- ${line}`) : ['- No clear user intent extracted.']),
    '',
    'Useful Prior Outputs:',
    ...(assistantHighlights.length > 0
      ? assistantHighlights.map((line) => `- ${line}`)
      : ['- No assistant highlights extracted.']),
    '',
    'Constraints:',
    ...(constraints.length > 0 ? constraints.map((line) => `- ${line}`) : ['- No explicit constraints found.']),
    '',
    'Open Questions:',
    ...(openQuestions.length > 0 ? openQuestions.map((line) => `- ${line}`) : ['- No open questions detected.']),
    '',
    `Latest User Message: ${latestUser ? compactLine(latestUser.content, 220) : 'Unavailable'}`,
    '',
    'Instruction For Target Model:',
    styleInstruction,
    'Use this packet as context, avoid replaying the full transcript, and continue from the latest goal.'
  ].join('\n');
}

function detectTabContext(url: string | undefined): TabContext {
  if (!url) {
    return 'other';
  }

  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return 'other';
  }

  if (hostname === 'chatgpt.com' || hostname === 'chat.openai.com') {
    return 'chatgpt';
  }

  if (hostname === 'claude.ai' || hostname.endsWith('.claude.ai')) {
    return 'claude';
  }

  if (hostname === 'perplexity.ai' || hostname.endsWith('.perplexity.ai')) {
    return 'perplexity';
  }

  if (hostname === 'deepseek.com' || hostname.endsWith('.deepseek.com')) {
    return 'deepseek';
  }

  return 'other';
}

function isMissingReceiverError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes('receiving end does not exist') || message.includes('could not establish connection');
}

function getTabLabel(context: TabContext): string {
  if (context === 'chatgpt') {
    return 'ChatGPT';
  }

  if (context === 'claude') {
    return 'Claude';
  }

  if (context === 'perplexity') {
    return 'Perplexity';
  }

  if (context === 'deepseek') {
    return 'DeepSeek';
  }

  return 'Unsupported Tab';
}

function App(): ReactElement {
  const [screen, setScreen] = useState<Screen>('loading');
  const [tabContext, setTabContext] = useState<TabContext>('other');
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [memories, setMemories] = useState<ConversationListItem[]>([]);
  const [conversationMap, setConversationMap] = useState<Record<string, Conversation>>({});
  const [search, setSearch] = useState('');
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [expandedConversationId, setExpandedConversationId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [clearAllConfirm, setClearAllConfirm] = useState(false);
  const [showInjectStatus, setShowInjectStatus] = useState(true);
  const [groupBySource, setGroupBySource] = useState(true);
  const [autoExpandPreview, setAutoExpandPreview] = useState(true);
  const [transferGoal, setTransferGoal] = useState('');
  const [transferStyle, setTransferStyle] = useState<TransferStyle>('structured');
  const { listConversations, deleteConversation, getConversation, exportConversations } = useMessages();

  const canInject = tabContext !== 'other';
  const canSave = tabContext !== 'other';
  const injectDisabledReason = canInject ? undefined : 'Open a supported AI chat tab to insert saved context.';

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setToast(null);
    }, 4000);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [toast]);

  useEffect(() => {
    const init = async (): Promise<void> => {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        setActiveTabId(activeTab?.id ?? null);
        setTabContext(detectTabContext(activeTab?.url));
      } catch {
        setTabContext('other');
      }

      try {
        const response = await listConversations();
        if (response.type === 'LIST_RESULT') {
          setMemories(response.payload.conversations);
          setScreen(response.payload.conversations.length > 0 ? 'list' : 'empty');
        } else {
          setScreen('empty');
        }
      } catch {
        setScreen('empty');
      }
    };

    void init();
  }, [listConversations]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return memories;
    }

    return memories.filter((memory) => {
      if (memory.title.toLowerCase().includes(query) || memory.preview.toLowerCase().includes(query)) {
        return true;
      }

      const indexed = buildConversationSearchText(conversationMap[memory.id]);
      return indexed.includes(query);
    });
  }, [conversationMap, memories, search]);

  const grouped = useMemo(() => {
    if (!groupBySource) {
      return { all: filtered } as Record<string, ConversationListItem[]>;
    }

    return filtered.reduce<Record<string, ConversationListItem[]>>((acc, item) => {
      const bucket = acc[item.source] ?? [];
      bucket.push(item);
      acc[item.source] = bucket;
      return acc;
    }, {});
  }, [filtered, groupBySource]);

  const deleteTarget = useMemo(() => {
    if (!deleteTargetId) {
      return null;
    }

    return memories.find((memory) => memory.id === deleteTargetId) ?? null;
  }, [deleteTargetId, memories]);

  const showToast = (kind: ToastKind, message: string): void => {
    setToast({ id: Date.now(), kind, message });
  };

  const refreshMemories = async (): Promise<void> => {
    const response = await listConversations();
    if (response.type === 'LIST_RESULT') {
      setMemories(response.payload.conversations);

      const exported = await exportConversations();
      if (exported.type === 'EXPORT_RESULT') {
        const parsed = JSON.parse(exported.payload.json) as ExportPayload;
        const map: Record<string, Conversation> = {};
        for (const conversation of parsed.conversations ?? []) {
          map[conversation.id] = conversation;
        }
        setConversationMap(map);
      }

      setScreen(response.payload.conversations.length > 0 ? 'list' : 'empty');
      return;
    }

    if (response.type === 'ERROR') {
      throw new Error(response.payload.message);
    }

    throw new Error('Unexpected response while listing conversations.');
  };

  const saveConversationToBackground = async (conversation: Conversation): Promise<boolean> => {
    const response = await chrome.runtime.sendMessage({
      type: 'SAVE_CONVERSATION',
      payload: { conversation }
    });

    return (response as { type?: string } | undefined)?.type === 'SAVE_RESULT';
  };

  const normalizeInjectionResult = (response: unknown): InjectionResult => {
    if (!response || typeof response !== 'object') {
      return { success: false, error: 'No injection response from content script.' };
    }

    const typed = response as {
      success?: boolean;
      error?: string;
      type?: string;
      payload?: { success?: boolean; error?: string };
    };

    if (typed.type === 'INJECTION_STATUS') {
      const statusError = typed.payload?.error;
      return {
        success: Boolean(typed.payload?.success),
        ...(statusError ? { error: statusError } : {})
      };
    }

    const plainError = typed.error;
    return {
      success: Boolean(typed.success),
      ...(plainError ? { error: plainError } : {})
    };
  };

  const getContentScriptFileForContext = (context: TabContext): string | null => {
    if (context === 'chatgpt') {
      return 'src/content/chatgpt/index.js';
    }

    if (context === 'claude') {
      return 'src/content/claude/index.js';
    }

    if (context === 'perplexity') {
      return 'src/content/perplexity/index.js';
    }

    if (context === 'deepseek') {
      return 'src/content/deepseek/index.js';
    }

    return null;
  };

  const ensureContentScriptReady = async (tabId: number): Promise<boolean> => {
    if (!chrome.scripting?.executeScript) {
      return false;
    }

    const scriptFile = getContentScriptFileForContext(tabContext);
    if (!scriptFile) {
      return false;
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: [scriptFile]
      });

      return true;
    } catch {
      return false;
    }
  };

  const injectConversationFallback = async (tabId: number, preparedPrompt: string): Promise<InjectionResult> => {
    if (!chrome.scripting?.executeScript) {
      return { success: false, error: 'Scripting API unavailable for fallback injection.' };
    }

    const content = preparedPrompt;

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [content],
      func: (text) => {
        const selectors = [
          'textarea',
          'div[contenteditable="true"][role="textbox"]',
          '.ProseMirror[contenteditable="true"]',
          '[contenteditable="true"]'
        ];

        let editor: Element | null = null;
        for (const selector of selectors) {
          const candidate = document.querySelector(selector);
          if (candidate) {
            editor = candidate;
            break;
          }
        }

        if (!editor) {
          return { success: false, error: 'Chat editor not found for fallback injection.' };
        }

        if (editor instanceof HTMLTextAreaElement) {
          editor.focus();
          const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
          descriptor?.set?.call(editor, text);
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          editor.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true };
        }

        if (editor instanceof HTMLElement && editor.isContentEditable) {
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
            document.execCommand('insertText', false, text);
          } else {
            editor.textContent = text;
          }

          editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText' }));
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
          editor.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true };
        }

        return { success: false, error: 'Editor exists but is not editable.' };
      }
    });

    return (results[0]?.result as InjectionResult | undefined) ?? {
      success: false,
      error: 'Fallback execution did not return a result.'
    };
  };

  const captureConversationFallback = async (tabId: number): Promise<Conversation | null> => {
    if (!chrome.scripting?.executeScript) {
      return null;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const host = window.location.hostname;
        const source =
          host.includes('chatgpt.com') || host.includes('openai.com')
            ? 'chatgpt'
            : host.includes('claude.ai')
              ? 'claude'
              : host.includes('perplexity.ai')
                ? 'perplexity'
                : host.includes('deepseek.com')
                  ? 'deepseek'
                  : null;

        if (!source) {
          return null;
        }

        const selectors = [
          '[data-message-author-role]',
          '[data-role="user"]',
          '[data-role="assistant"]',
          '[data-testid*="message"]',
          '[data-testid*="query"]',
          '[data-testid*="answer"]',
          '[class*="message"]',
          '[class*="assistant"]',
          '[class*="user"]',
          'main article',
          'article',
          'main .prose',
          'main .markdown',
          'main .message'
        ];

        const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
        const seen = new Set<string>();
        const messages = nodes
          .map((node) => {
            const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (!text) {
              return null;
            }

            const explicitRole = node.getAttribute('data-message-author-role');
            const dataRole = (node.getAttribute('data-role') ?? '').toLowerCase();
            const testId = (node.getAttribute('data-testid') ?? '').toLowerCase();
            const className = (node.getAttribute('class') ?? '').toLowerCase();
            const hint = `${testId} ${className}`;

            let role: 'user' | 'assistant' | 'system' = 'assistant';
            if (explicitRole === 'user' || explicitRole === 'assistant' || explicitRole === 'system') {
              role = explicitRole;
            } else if (dataRole === 'user' || hint.includes('query') || hint.includes('prompt') || hint.includes('user')) {
              role = 'user';
            } else if (dataRole === 'assistant' || hint.includes('assistant') || hint.includes('answer') || hint.includes('response') || hint.includes('bot')) {
              role = 'assistant';
            }

            const fingerprint = `${role}:${text}`;
            if (seen.has(fingerprint)) {
              return null;
            }

            seen.add(fingerprint);
            return { role, content: text };
          })
          .filter((item): item is { role: 'user' | 'assistant' | 'system'; content: string } => item !== null)
          .filter((item) => item.content.length > 8)
          .slice(0, 160);

        if (messages.length === 0) {
          return null;
        }

        const firstUser = messages.find((message) => message.role === 'user');
        const first = firstUser?.content ?? messages[0]?.content ?? 'AI Conversation';
        return {
          id: crypto.randomUUID(),
          title: first.slice(0, 80),
          messages,
          createdAt: Date.now(),
          source
        };
      }
    });

    const firstResult = results[0];
    return (firstResult?.result as Conversation | null) ?? null;
  };

  const handleSaveConversation = async (): Promise<void> => {
    if (!canSave) {
      showToast('error', 'Save is only available on supported AI chat tabs.');
      return;
    }

    if (!activeTabId) {
      showToast('error', 'Active tab unavailable.');
      return;
    }

    try {
      let response: { success?: boolean; error?: string } | undefined;
      try {
        response = (await chrome.tabs.sendMessage(activeTabId, {
          type: 'POPUP_CAPTURE_CONTEXT'
        })) as { success?: boolean; error?: string } | undefined;
      } catch (sendError) {
        if (!isMissingReceiverError(sendError)) {
          throw sendError;
        }

        const injected = await ensureContentScriptReady(activeTabId);
        if (!injected) {
          throw sendError;
        }

        response = (await chrome.tabs.sendMessage(activeTabId, {
          type: 'POPUP_CAPTURE_CONTEXT'
        })) as { success?: boolean; error?: string } | undefined;
      }

      if (!response?.success) {
        const fallbackConversation = await captureConversationFallback(activeTabId);
        if (!fallbackConversation) {
          showToast('error', response?.error ?? 'Unable to save from this page.');
          return;
        }

        const saved = await saveConversationToBackground(fallbackConversation);
        if (!saved) {
          showToast('error', 'Capture succeeded but save failed.');
          return;
        }
      }

      await refreshMemories();
      setScreen('list');
      showToast('success', 'Conversation saved successfully.');
    } catch (error) {
      try {
        const fallbackConversation = activeTabId ? await captureConversationFallback(activeTabId) : null;
        if (fallbackConversation) {
          const saved = await saveConversationToBackground(fallbackConversation);
          if (saved) {
            await refreshMemories();
            setScreen('list');
            showToast('success', 'Conversation saved successfully.');
            return;
          }
        }
      } catch {
      }

      showToast('error', error instanceof Error ? error.message : 'Unable to save from this page.');
    }
  };

  const handleInject = async (memoryId: string): Promise<void> => {
    if (!canInject) {
      showToast('error', 'Context insertion is unavailable on this tab.');
      return;
    }

    if (!activeTabId) {
      showToast('error', 'Active tab unavailable for injection.');
      return;
    }

    try {
      const convoResponse = await getConversation(memoryId);
      if (convoResponse.type !== 'GET_RESULT') {
        showToast('error', convoResponse.type === 'ERROR' ? convoResponse.payload.message : 'Unable to fetch conversation.');
        return;
      }
        const preparedPrompt = buildContextPacket(
          convoResponse.payload.conversation,
          transferStyle,
          transferGoal,
          tabContext
        );

        const message: InjectMessage = {
        type: 'INJECT_CONVERSATION',
        payload: { conversation: convoResponse.payload.conversation, format: 'summary', preparedPrompt }
      };

      let injectionResult: InjectionResult;
      try {
        const primaryResponse = await chrome.tabs.sendMessage(activeTabId, message);
        injectionResult = normalizeInjectionResult(primaryResponse);
      } catch (primaryError) {
        if (isMissingReceiverError(primaryError)) {
          const injected = await ensureContentScriptReady(activeTabId);
          if (injected) {
            const retriedResponse = await chrome.tabs.sendMessage(activeTabId, message);
            injectionResult = normalizeInjectionResult(retriedResponse);
          } else {
            const fallback = await injectConversationFallback(activeTabId, preparedPrompt);
            if (!fallback.success) {
              throw primaryError;
            }

            injectionResult = fallback;
          }
        } else {
          const fallback = await injectConversationFallback(activeTabId, preparedPrompt);
          if (!fallback.success) {
            throw primaryError;
          }

          injectionResult = fallback;
        }
      }

      if (!injectionResult.success) {
        const fallback = await injectConversationFallback(activeTabId, preparedPrompt);
        if (!fallback.success) {
          showToast('error', injectionResult.error ?? fallback.error ?? 'Injection failed.');
          return;
        }
      }
    } catch (error) {
      showToast('error', error instanceof Error ? error.message : 'Injection failed.');
      return;
    }

    if (showInjectStatus) {
      showToast('success', `Memory injected into ${getTabLabel(tabContext)}.`);
    }
  };

  const handleDeleteConfirmed = async (): Promise<void> => {
    if (!deleteTargetId) {
      return;
    }

    try {
      const response = await deleteConversation(deleteTargetId);
      if (response.type !== 'DELETE_RESULT') {
        showToast('error', response.type === 'ERROR' ? response.payload.message : 'Delete failed.');
        return;
      }

      await refreshMemories();
      setDeleteTargetId(null);
      showToast('success', 'Conversation removed.');
    } catch (error) {
      showToast('error', error instanceof Error ? error.message : 'Delete failed.');
    }
  };

  const handleExportAll = async (): Promise<void> => {
    const response = await exportConversations();
    if (response.type !== 'EXPORT_RESULT') {
      showToast('error', response.type === 'ERROR' ? response.payload.message : 'Export failed.');
      return;
    }

    const blob = new Blob([response.payload.json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'ai-memory-export.json';
    anchor.click();
    URL.revokeObjectURL(url);
    showToast('success', 'Export completed successfully.');
  };

  if (screen === 'loading') {
    return (
      <div className="ai-popup">
        <nav className="ai-top-nav">
          <div className="ai-skeleton ai-skeleton-title" />
          <div className="ai-skeleton ai-skeleton-icon" />
        </nav>
        <div className="ai-left-accent" />
        <main className="ai-main">
          <div className="ai-skeleton ai-skeleton-search" />
          <div className="ai-skeleton-card" />
          <div className="ai-skeleton-card" />
          <div className="ai-skeleton-card" />
        </main>
        <div className="ai-radial-glow" />
      </div>
    );
  }

  return (
    <div className="ai-popup">
      <nav className="ai-top-nav ai-frosted">
        <div className="ai-header-left">
          {screen === 'settings' ? (
            <button className="ai-icon-btn" type="button" onClick={() => setScreen('list')} aria-label="Back">
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
          ) : null}
          <h1 className="ai-title">{screen === 'settings' ? 'Settings' : 'Conversation Memory'}</h1>
        </div>

        <div className="ai-header-actions">
          {screen !== 'settings' ? (
            <span className={`ai-status-pill ${canInject ? 'is-active' : ''}`}>{getTabLabel(tabContext)}</span>
          ) : null}
          {screen !== 'settings' ? (
            <button className="ai-icon-btn" type="button" onClick={() => setScreen('settings')} aria-label="Settings">
              <span className="material-symbols-outlined">settings</span>
            </button>
          ) : null}
        </div>
      </nav>

      <div className="ai-left-accent" />
      <div className="ai-radial-glow" />

      <main className="ai-main">
        {screen === 'save' ? (
          <section className="ai-empty">
            <div className="ai-illustration-box">
              <span className="material-symbols-outlined">ink_highlighter</span>
            </div>
            <h2>Save Current Conversation</h2>
            <p>
              {canSave
                ? `You are on ${getTabLabel(tabContext)}. Save this conversation to local memory for reuse.`
                : 'Open ChatGPT, Claude, Perplexity, or DeepSeek to save the active conversation.'}
            </p>
            <button className="ai-btn" type="button" disabled={!canSave} onClick={() => { void handleSaveConversation(); }}>
              Save Conversation
            </button>
            <button className="ai-btn-ghost" type="button" onClick={() => setScreen(memories.length > 0 ? 'list' : 'empty')}>
              Open Saved Conversations
            </button>
          </section>
        ) : null}

        {screen === 'list' ? (
          <>
            {!canInject ? (
              <div className="ai-banner">
                <span className="material-symbols-outlined">warning</span>
                <div>
                  <strong>Context insertion unavailable</strong>
                  <div>{injectDisabledReason}</div>
                </div>
              </div>
            ) : null}

            {toast ? (
              <div
                className={`ai-toast ${toast.kind === 'error' ? 'is-error' : ''}`}
                key={toast.id}
                role={toast.kind === 'error' ? 'alert' : 'status'}
                aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
                aria-atomic="true"
              >
                <span className="material-symbols-outlined">{toast.kind === 'error' ? 'warning' : 'check_circle'}</span>
                <span>{toast.message}</span>
                <button type="button" className="ai-icon-btn" onClick={() => setToast(null)} aria-label="Dismiss toast">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
            ) : null}

            <div className="ai-search-wrap">
              <div className="ai-search-row">
                <input
                  className="ai-input"
                  placeholder="Search saved conversations"
                  value={search}
                  aria-label="Search saved conversations"
                  spellCheck={false}
                  onChange={(event) => setSearch(event.target.value)}
                />
                {search ? (
                  <button className="ai-icon-btn" type="button" onClick={() => setSearch('')} aria-label="Clear search">
                    <span className="material-symbols-outlined">close</span>
                  </button>
                ) : null}
              </div>
            </div>

            {search ? <p className="ai-item-meta">{filtered.length} results for "{search}"</p> : null}

            {filtered.length === 0 ? (
              <div className="ai-no-results">
                <p>No saved conversations match "{search}".</p>
                <button type="button" className="ai-link" onClick={() => setSearch('')}>
                  Clear search
                </button>
              </div>
            ) : (
              Object.keys(grouped)
                .sort((left, right) => left.localeCompare(right))
                .map((groupKey) => {
                  const items = grouped[groupKey] ?? [];
                  const label = groupKey === 'all' ? 'ALL' : groupKey.toUpperCase();

                  return (
                    <section className="ai-group" key={groupKey}>
                      <h3>
                        {label} ({items.length})
                      </h3>

                      {items.map((item) => (
                        <article key={item.id} className="ai-item">
                          <div className="ai-item-row-top">
                                            <span className={`ai-source-badge ${item.source === 'chatgpt' ? 'is-chatgpt' : 'is-perplexity'}`}>
                                                {item.source === 'chatgpt'
                                                  ? 'ChatGPT'
                                                  : item.source === 'perplexity'
                                                    ? 'Perplexity'
                                                    : item.source === 'deepseek'
                                                      ? 'DeepSeek'
                                                      : 'Claude'}
                            </span>
                            <span className="ai-item-meta">{toRelativeTime(item.createdAt)}</span>
                            <span className="ai-item-meta">{item.messageCount} msgs</span>
                          </div>

                          <div className="ai-item-title">{item.title}</div>
                          <p className={`ai-item-preview ${autoExpandPreview ? 'expanded' : ''}`}>{item.preview}</p>

                          <div className="ai-item-actions">
                            <button
                              className="ai-btn"
                              type="button"
                              disabled={!canInject}
                              onClick={() => {
                                void handleInject(item.id);
                              }}
                            >
                              Insert Context
                            </button>
                            <button className="ai-btn-delete" type="button" onClick={() => setDeleteTargetId(item.id)}>
                              Remove
                            </button>
                            <button
                              className="ai-btn-ghost"
                              type="button"
                              onClick={() => setExpandedConversationId((current) => (current === item.id ? null : item.id))}
                            >
                              {expandedConversationId === item.id ? 'Hide Details' : 'View Details'}
                            </button>
                          </div>

                          {expandedConversationId === item.id && conversationMap[item.id] ? (
                            <div className="ai-full-transcript">
                              {(conversationMap[item.id]?.messages ?? []).map((message, index) => (
                                <p key={`${item.id}-${index}`}>
                                  <strong>{message.role.toUpperCase()}:</strong> {message.content}
                                </p>
                              ))}
                            </div>
                          ) : null}
                        </article>
                      ))}
                    </section>
                  );
                })
            )}
          </>
        ) : null}

        {screen === 'empty' ? (
          <section className="ai-empty">
            <div className="ai-illustration-box">
              <span className="material-symbols-outlined">draw</span>
            </div>
            <h2>No saved conversations yet.</h2>
            <p>Save a conversation from a supported AI tab to start building your memory library.</p>
            <button className="ai-btn" type="button" onClick={() => setScreen('save')}>
              Save a Conversation
            </button>
          </section>
        ) : null}

        {screen === 'settings' ? (
          <section className="ai-settings">
            <article className="ai-settings-card">
              <p>
                {memories.length} saved conversations · Stored locally · Cloud sync not enabled
              </p>
            </article>

            <div className="ai-toggle-row">
              <span>Expand preview text</span>
              <button
                type="button"
                className={`ai-toggle ${autoExpandPreview ? 'is-on' : ''}`}
                onClick={() => setAutoExpandPreview((value) => !value)}
                aria-label="Toggle auto-expand preview"
                  aria-pressed={autoExpandPreview}
              />
            </div>

            <div className="ai-toggle-row">
              <span>Show insertion status</span>
              <button
                type="button"
                className={`ai-toggle ${showInjectStatus ? 'is-on' : ''}`}
                onClick={() => setShowInjectStatus((value) => !value)}
                aria-label="Toggle inject status"
                  aria-pressed={showInjectStatus}
              />
            </div>

            <div className="ai-toggle-row">
              <span>Group by source</span>
              <button
                type="button"
                className={`ai-toggle ${groupBySource ? 'is-on' : ''}`}
                onClick={() => setGroupBySource((value) => !value)}
                aria-label="Toggle source grouping"
                  aria-pressed={groupBySource}
              />
            </div>

            <button className="ai-btn-outline" type="button" onClick={handleExportAll}>
              Export Conversations (JSON)
            </button>

            <button className="ai-btn-outline is-danger" type="button" onClick={() => setClearAllConfirm(true)}>
              Clear Conversation List
            </button>

            {clearAllConfirm ? (
              <div className="ai-inline-confirm">
                <button
                  type="button"
                  className="ai-btn-danger"
                  onClick={() => {
                    setMemories([]);
                    setClearAllConfirm(false);
                    showToast('success', 'Conversation list cleared.');
                  }}
                >
                  Confirm Clear
                </button>
                <button type="button" className="ai-btn-ghost" onClick={() => setClearAllConfirm(false)}>
                  Cancel
                </button>
              </div>
            ) : null}

            <div className="ai-about">
              <strong>Conversation Memory v1.0.0</strong>
              <p>Professional local memory workflow for modern AI assistant sessions.</p>
            </div>
          </section>
        ) : null}
      </main>

      {screen === 'list' || screen === 'empty' || screen === 'save' ? (
        <footer className="ai-sticky-footer">
          <div className="ai-footer-row">
            <button className="ai-btn-ghost" type="button" onClick={() => setScreen('save')}>
              Save
            </button>
            <button className="ai-btn-ghost" type="button" onClick={() => setScreen(memories.length > 0 ? 'list' : 'empty')}>
              Library
            </button>
          </div>
        </footer>
      ) : null}

      {deleteTarget ? (
        <div
          className="ai-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-memory-title"
          aria-describedby="delete-memory-description"
        >
          <div className="ai-modal">
            <h3 id="delete-memory-title">Remove this conversation?</h3>
            <p>
              "{deleteTarget.title.slice(0, 28)}{deleteTarget.title.length > 28 ? '...' : ''}" will be permanently removed from local storage.
            </p>
            <div className="ai-modal-actions">
              <button className="ai-btn-danger" type="button" onClick={() => { void handleDeleteConfirmed(); }}>
                Remove Permanently
              </button>
              <button className="ai-btn-ghost" type="button" onClick={() => setDeleteTargetId(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('Popup root element not found.');
}

const root = createRoot(container);
root.render(
  <PopupErrorBoundary>
    <App />
  </PopupErrorBoundary>
);
