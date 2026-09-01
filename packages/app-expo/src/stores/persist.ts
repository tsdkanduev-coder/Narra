/**
 * Persist utility for React Native
 * Uses expo-file-system for file I/O
 */
import * as FileSystem from "expo-file-system/legacy";
import * as SecureStore from "expo-secure-store";
import type { StateCreator, StoreApi } from "zustand";

const DEBOUNCE_MS = 500;
const STORE_DIR = `${FileSystem.documentDirectory}readany-store`;
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
const writePromises = new Map<string, Promise<void>>();
const pendingData = new Map<string, unknown>();

let dirCreated = false;

async function ensureDir() {
  if (!dirCreated) {
    const dirInfo = await FileSystem.getInfoAsync(STORE_DIR);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(STORE_DIR, { intermediates: true });
    }
    dirCreated = true;
  }
}

export function debouncedSave(key: string, data: unknown): void {
  const existing = pendingWrites.get(key);
  if (existing) clearTimeout(existing);

  pendingData.set(key, data);

  const timer = setTimeout(() => {
    pendingWrites.delete(key);
    const dataToWrite = pendingData.get(key);
    pendingData.delete(key);
    const promise = writeToFS(key, dataToWrite);
    writePromises.set(key, promise);
    promise.finally(() => writePromises.delete(key));
  }, DEBOUNCE_MS);

  pendingWrites.set(key, timer);
}

async function writeToFS(key: string, data: unknown): Promise<void> {
  try {
    await ensureDir();
    const filePath = `${STORE_DIR}/${key}.json`;
    await FileSystem.writeAsStringAsync(filePath, JSON.stringify(data));
  } catch (err) {
    console.error(`Failed to persist ${key}:`, err);
  }
}

/**
 * Битый файл стора откладывается в сторону, а не читается на каждом старте:
 * иначе гидрация никогда не завершалась (`_hasHydrated` оставался false) и
 * приложение зависало на заглушке. Копия остаётся рядом для разбора.
 */
async function quarantineCorruptStore(key: string, filePath: string): Promise<void> {
  try {
    await FileSystem.moveAsync({ from: filePath, to: `${filePath}.corrupt-${Date.now()}` });
  } catch (err) {
    console.error(`Failed to quarantine corrupt store ${key}:`, err);
  }
}

export async function loadFromFS<T>(key: string): Promise<T | null> {
  const filePath = `${STORE_DIR}/${key}.json`;
  let text: string | null = null;
  try {
    await ensureDir();
    text = await FileSystem.readAsStringAsync(filePath);
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    console.error(`Persisted store ${key} is corrupt, starting fresh:`, err);
    await quarantineCorruptStore(key, filePath);
    return null;
  }
}

export async function flushAllWrites(): Promise<void> {
  for (const [key, timer] of pendingWrites.entries()) {
    clearTimeout(timer);
    pendingWrites.delete(key);
    const data = pendingData.get(key);
    pendingData.delete(key);
    if (data !== undefined) {
      const promise = writeToFS(key, data);
      writePromises.set(key, promise);
      promise.finally(() => writePromises.delete(key));
    }
  }
  await Promise.all(writePromises.values());
}

export function withPersist<T extends object>(
  key: string,
  creator: StateCreator<T>,
  /** Keys to always reset to these values after hydration (transient state that should not be restored) */
  resetAfterHydrate?: Partial<T>,
  migrate?: (persisted: T) => T,
): StateCreator<T> {
  return (set, get, api) => {
    let persistLoaded = false;

    const wrappedSet = ((partial: unknown, replace?: boolean) => {
      if (replace) {
        (set as (state: T, replace: true) => void)(partial as T, true);
      } else {
        (set as (partial: T | Partial<T> | ((state: T) => T | Partial<T>)) => void)(
          partial as T | Partial<T> | ((state: T) => T | Partial<T>),
        );
      }
      // Only save to persist after initial load is complete
      if (persistLoaded) {
        debouncedSave(key, (api as StoreApi<T>).getState());
      }
    }) as typeof set;
    const state = creator(wrappedSet, get, api);

    // Load persisted data and notify when done
    loadFromFS<T>(key)
      .then(async (persisted) => {
        let migrated: T | null = null;
        if (persisted) {
          try {
            migrated = migrate ? migrate(persisted) : persisted;
          } catch (err) {
            // Миграция падала на старом снимке (например, книга без characters),
            // и стор навсегда оставался негидрированным. Лучше стартовать с
            // дефолтами, чем повесить приложение; снимок сохраняем для разбора.
            console.error(`Migration of persisted store ${key} failed, starting fresh:`, err);
            await quarantineCorruptStore(key, `${STORE_DIR}/${key}.json`);
            migrated = null;
          }
        }
        if (migrated) {
          // Merge persisted data with current state (don't replace methods)
          const currentState = get();
          const mergedState = {
            ...currentState,
            ...migrated,
            ...(resetAfterHydrate ?? {}),
            _hasHydrated: true,
          };
          (set as (state: T, replace: true) => void)(mergedState as T, true);
        } else {
          const currentState = get();
          const mergedState = { ...currentState, ...(resetAfterHydrate ?? {}), _hasHydrated: true };
          (set as (state: T, replace: true) => void)(mergedState as T, true);
        }
        persistLoaded = true;

        const hydratedState = (
          api as StoreApi<T & { loadApiKeys?: () => Promise<void> }>
        ).getState();
        if (typeof hydratedState.loadApiKeys === "function") {
          await hydratedState.loadApiKeys();
        }

        // Dispatch event to notify that persist is loaded
        if (
          typeof window !== "undefined" &&
          typeof window.dispatchEvent === "function" &&
          typeof CustomEvent !== "undefined"
        ) {
          window.dispatchEvent(new CustomEvent("persist:loaded", { detail: { key } }));
        }
      })
      .catch((err) => {
        // Любая неожиданная ошибка гидрации не должна оставлять стор в
        // «вечно загружается»: экраны ждут _hasHydrated.
        console.error(`Hydration of persisted store ${key} failed, using defaults:`, err);
        if (!persistLoaded) {
          const currentState = get();
          (set as (state: T, replace: true) => void)(
            { ...currentState, ...(resetAfterHydrate ?? {}), _hasHydrated: true } as T,
            true,
          );
          persistLoaded = true;
        }
      });

    return state;
  };
}

// Secure storage for sensitive data like API keys
export async function saveSecure(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}

export async function loadSecure(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key);
}

export async function deleteSecure(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(key);
}
