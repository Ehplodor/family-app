/**
 * Stockage local (IndexedDB), partagé entre l'appli et le service worker.
 *  - kv     : identité de l'appareil, clés du cercle, curseur de synchro, réglages locaux
 *  - docs   : état de toutes les données (une entrée par document)
 *  - outbox : modifications locales pas encore transmises au relais
 *  - blobs  : photos (en clair sur l'appareil, chiffrées sur le relais)
 */
const DB_NAME = 'family-app';
const VERSION = 1;
export type StoreName = 'kv' | 'docs' | 'outbox' | 'blobs';

let dbPromise: Promise<IDBDatabase> | null = null;

export function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('kv');
        d.createObjectStore('docs');
        d.createObjectStore('outbox', { autoIncrement: true });
        d.createObjectStore('blobs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

const wrap = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export async function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return wrap((await db()).transaction(store).objectStore(store).get(key));
}

export async function put(store: StoreName, key: IDBValidKey | undefined, value: unknown): Promise<void> {
  const tx = (await db()).transaction(store, 'readwrite');
  const s = tx.objectStore(store);
  if (key === undefined) s.put(value);
  else s.put(value, key);
  await done(tx);
}

export async function del(store: StoreName, key: IDBValidKey | IDBKeyRange): Promise<void> {
  const tx = (await db()).transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await done(tx);
}

export async function putMany(store: StoreName, entries: [IDBValidKey | undefined, unknown][]): Promise<void> {
  if (!entries.length) return;
  const tx = (await db()).transaction(store, 'readwrite');
  const s = tx.objectStore(store);
  for (const [k, v] of entries) {
    if (k === undefined) s.put(v);
    else s.put(v, k);
  }
  await done(tx);
}

export async function entries<T>(store: StoreName, limit?: number): Promise<[IDBValidKey, T][]> {
  const tx = (await db()).transaction(store);
  const s = tx.objectStore(store);
  const [keys, values] = await Promise.all([wrap(s.getAllKeys(null, limit)), wrap(s.getAll(null, limit))]);
  return keys.map((k, i) => [k, values[i] as T]);
}

export async function clear(...stores: StoreName[]): Promise<void> {
  const tx = (await db()).transaction(stores, 'readwrite');
  for (const s of stores) tx.objectStore(s).clear();
  await done(tx);
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
