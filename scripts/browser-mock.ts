// 浏览器环境 mock，必须在任何业务模块导入前先加载。
function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, String(value))
  } as unknown as Storage;
}

const listeners: Array<(e: StorageEvent) => void> = [];
const storage = createMemoryStorage();

Object.assign(globalThis, {
  localStorage: storage,
  sessionStorage: createMemoryStorage(),
  window: {
    addEventListener: (_: string, fn: (e: StorageEvent) => void) => listeners.push(fn),
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    }
  },
  structuredClone: (obj: unknown) => JSON.parse(JSON.stringify(obj))
});

(globalThis as Record<string, unknown>).__fireStorage = (key: string, newValue: string) => {
  for (const fn of listeners) fn({ key, newValue } as StorageEvent);
};

export {};
