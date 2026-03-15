import { useCallback, useMemo, useState } from 'react';
import type { ConversationListItem, SourceGroup } from '../types';

export function useStorage(initialItems: ConversationListItem[] = []): {
  items: ConversationListItem[];
  search: string;
  setSearch: (value: string) => void;
  setItems: (items: ConversationListItem[]) => void;
  grouped: SourceGroup;
  filtered: ConversationListItem[];
} {
  const [items, setItems] = useState<ConversationListItem[]>(initialItems);
  const [search, setSearch] = useState<string>('');

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return items;
    }

    return items.filter((item) => {
      return (
        item.title.toLowerCase().includes(query) ||
        item.preview.toLowerCase().includes(query) ||
        item.source.toLowerCase().includes(query)
      );
    });
  }, [items, search]);

  const grouped = useMemo<SourceGroup>(() => {
    return filtered.reduce<SourceGroup>((acc, item) => {
      const key = item.source;
      const bucket = acc[key] ?? [];
      bucket.push(item);
      acc[key] = bucket;
      return acc;
    }, {});
  }, [filtered]);

  const updateSearch = useCallback((value: string) => {
    setSearch(value);
  }, []);

  return {
    items,
    search,
    setSearch: updateSearch,
    setItems,
    grouped,
    filtered
  };
}
