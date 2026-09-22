import type { RunRecord } from "./types";

// Записи запусков в IndexedDB браузера (localStorage мал для сценариев на 3 МБ).
// При недоступном хранилище (приватный режим) запуски живут только до перезагрузки.
const DB = "sozvezdie", STORE = "runs";
const memory = new Map<string, RunRecord>();

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const store = {
  async save(run: RunRecord) {
    memory.set(run.id, run);
    try { await tx("readwrite", (s) => s.put(run)); } catch { /* только память */ }
  },
  async all(): Promise<RunRecord[]> {
    // Смены, которые не удалось записать в хранилище браузера, остаются только в памяти —
    // их нужно отдавать вместе с сохранёнными, иначе смена «пропадает» из списка.
    let saved: RunRecord[] = [];
    try { saved = await tx("readonly", (s) => s.getAll() as IDBRequest<RunRecord[]>); } catch { /* только память */ }
    const byId = new Map(saved.map((r) => [r.id, r]));
    for (const [id, run] of memory) if (!byId.has(id)) byId.set(id, run);
    return [...byId.values()];
  },
  async remove(id: string) {
    memory.delete(id);
    try { await tx("readwrite", (s) => s.delete(id)); } catch { /* только память */ }
  },
};
