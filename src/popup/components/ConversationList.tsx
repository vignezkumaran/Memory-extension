import type { ReactElement } from 'react';
import { ConversationItem } from './ConversationItem';
import type { PopupProps, SourceGroup } from '../types';

interface ConversationListProps extends PopupProps {
  grouped: SourceGroup;
}

function formatSourceLabel(source: string): string {
  return source
    .split(/[-_\s]+/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function ConversationList({
  grouped,
  onSelectConversation,
  onRequestDeleteConversation,
  onInjectConversation,
  canInject,
  injectDisabledReason
}: ConversationListProps): ReactElement {
  const sources = Object.keys(grouped).sort((left, right) => left.localeCompare(right));

  return (
    <div>
      {sources.map((source) => {
        const entries = grouped[source] ?? [];
        if (entries.length === 0) {
          return null;
        }

        return (
          <section key={source} className="ai-group">
            <h3>{formatSourceLabel(source)}</h3>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {entries.map((item) => (
                <ConversationItem
                  key={item.id}
                  item={item}
                  onSelectConversation={onSelectConversation}
                  onRequestDeleteConversation={onRequestDeleteConversation}
                  onInjectConversation={onInjectConversation}
                  canInject={canInject}
                  injectDisabledReason={injectDisabledReason}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
