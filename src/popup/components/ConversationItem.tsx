import { useMemo, useState, type ReactElement } from 'react';
import type { ConversationListItem } from '../types';

interface ConversationItemProps {
  item: ConversationListItem;
  onSelectConversation: (id: string) => void;
  onRequestDeleteConversation: (id: string) => void;
  onInjectConversation: (id: string) => void;
  canInject: boolean;
  injectDisabledReason: string | undefined;
}

function toRelativeTime(dateEpochMs: number): string {
  const delta = Date.now() - dateEpochMs;
  const minutes = Math.floor(delta / 60000);

  if (minutes < 1) {
    return 'just now';
  }

  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function ConversationItem({
  item,
  onSelectConversation,
  onRequestDeleteConversation,
  onInjectConversation,
  canInject,
  injectDisabledReason
}: ConversationItemProps): ReactElement {
  const [hovered, setHovered] = useState(false);
  const relativeTime = useMemo(() => toRelativeTime(item.createdAt), [item.createdAt]);

  return (
    <li onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} className="ai-item">
      <button
        className="ai-item-title"
        type="button"
        onClick={() => onSelectConversation(item.id)}
      >
        {item.title}
      </button>
      <div className="ai-item-meta">
        {item.source.toUpperCase()} • {item.messageCount} messages • {relativeTime}
      </div>
      {hovered ? <div className="ai-item-preview">{item.preview}</div> : null}
      <div className="ai-item-actions">
        <button
          className="ai-btn"
          type="button"
          onClick={() => onInjectConversation(item.id)}
          disabled={!canInject}
          title={!canInject ? injectDisabledReason ?? 'Injection is unavailable for the current tab.' : 'Inject into current tab'}
        >
          Inject
        </button>
        <button className="ai-btn-ghost" type="button" onClick={() => onRequestDeleteConversation(item.id)}>
          Delete
        </button>
      </div>
    </li>
  );
}
