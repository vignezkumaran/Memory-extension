import { ExtensionError } from '../shared/errors';

/**
 * Type-safe wrapper around chrome.storage.local.
 */
export class TypedStorage<T extends object> {
  constructor(private readonly area: chrome.storage.StorageArea) {}

  async get<K extends keyof T>(key: K): Promise<T[K] | null> {
    const result = await this.area.get(String(key));
    return (result[String(key)] as T[K] | undefined) ?? null;
  }

  async set<K extends keyof T>(key: K, value: T[K]): Promise<void> {
    await this.area.set({ [String(key)]: value });
  }

  async getAll(): Promise<Partial<T>> {
    const all = await this.area.get(null);
    return all as Partial<T>;
  }

  async remove<K extends keyof T>(key: K): Promise<void> {
    await this.area.remove(String(key));
  }

  async clear(): Promise<void> {
    await this.area.clear();
  }

  subscribe<K extends keyof T>(key: K, callback: (newValue: T[K] | null) => void): () => void {
    const listener: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (changes, areaName) => {
      if (areaName !== 'local') {
        return;
      }

      const changed = changes[String(key)];
      if (!changed) {
        return;
      }

      callback((changed.newValue as T[K] | undefined) ?? null);
    };

    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }
}

export function ensureStorageArea(): chrome.storage.StorageArea {
  if (!chrome?.storage?.local) {
    throw new ExtensionError('STORAGE_UNAVAILABLE', 'chrome.storage.local is unavailable.');
  }

  return chrome.storage.local;
}
