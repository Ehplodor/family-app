import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { api, ApiError, type Doc, type Me, type Member } from './api';

/* ------------------------------------------------------------------ */
/* Collections : cache partagé + synchro temps réel                    */
/* ------------------------------------------------------------------ */

type CollectionState = { docs: Doc<any>[]; loaded: boolean };
type Entry = { state: CollectionState; loading: Promise<void> | null; listeners: Set<() => void> };

const entries = new Map<string, Entry>();

function entry(name: string): Entry {
  let e = entries.get(name);
  if (!e) {
    e = { state: { docs: [], loaded: false }, loading: null, listeners: new Set() };
    entries.set(name, e);
  }
  return e;
}

function setState(name: string, docs: Doc<any>[], loaded = true) {
  const e = entry(name);
  e.state = { docs, loaded };
  e.listeners.forEach((l) => l());
}

function loadCollection(name: string): Promise<void> {
  const e = entry(name);
  if (e.loading) return e.loading;
  e.loading = api<Doc<any>[]>('GET', `/docs/${name}`)
    .then((docs) => setState(name, docs))
    .catch((err) => console.warn(`Chargement de ${name} impossible`, err))
    .finally(() => {
      e.loading = null;
    });
  return e.loading;
}

function reloadLoadedCollections() {
  for (const [name, e] of entries) if (e.state.loaded) loadCollection(name);
}

export type Collection<T> = {
  docs: Doc<T>[];
  loaded: boolean;
  create: (data: T) => Promise<Doc<T>>;
  update: (id: string, patch: Partial<T>) => Promise<void>;
  remove: (id: string) => Promise<void>;
};

/**
 * Accès à une collection partagée par toute la famille.
 * Toute modification (par vous ou un autre membre) est répercutée en direct.
 */
export function useCollection<T extends object>(name: string): Collection<T> {
  const e = entry(name);
  const state = useSyncExternalStore(
    (cb) => {
      e.listeners.add(cb);
      return () => {
        e.listeners.delete(cb);
      };
    },
    () => e.state,
  );

  useEffect(() => {
    if (!entry(name).state.loaded) loadCollection(name);
  }, [name]);

  return useMemo(() => {
    const docs = state.docs as Doc<T>[];
    return {
      docs,
      loaded: state.loaded,
      async create(data: T) {
        const doc = await api<Doc<T>>('POST', `/docs/${name}`, { data });
        const current = entry(name).state.docs;
        if (!current.some((d) => d.id === doc.id)) setState(name, [...current, doc]);
        return doc;
      },
      async update(id: string, patch: Partial<T>) {
        // Mise à jour optimiste : l'écran réagit tout de suite.
        setState(
          name,
          entry(name).state.docs.map((d) => (d.id === id ? { ...d, ...patch } : d)),
        );
        try {
          const doc = await api<Doc<T>>('PATCH', `/docs/${name}/${id}`, { data: patch });
          setState(name, entry(name).state.docs.map((d) => (d.id === id ? doc : d)));
        } catch (err) {
          loadCollection(name);
          throw err;
        }
      },
      async remove(id: string) {
        setState(name, entry(name).state.docs.filter((d) => d.id !== id));
        try {
          await api('DELETE', `/docs/${name}/${id}`);
        } catch (err) {
          loadCollection(name);
          throw err;
        }
      },
    };
  }, [name, state]);
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

type SessionValue = {
  status: 'loading' | 'anon' | 'ready' | 'offline';
  me: Me | null;
  setMe: (me: Me) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMeState] = useState<Me | null>(null);
  const [status, setStatus] = useState<SessionValue['status']>('loading');

  const setMe = useCallback((m: Me) => {
    setMeState(m);
    setStatus('ready');
  }, []);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('GET', '/me'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setMeState(null);
        setStatus('anon');
      } else {
        setStatus((s) => (s === 'ready' ? s : 'offline'));
      }
    }
  }, [setMe]);

  const logout = useCallback(async () => {
    await api('POST', '/logout');
    entries.clear();
    setMeState(null);
    setStatus('anon');
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Flux temps réel : chaque changement côté serveur recharge ce qui est concerné.
  const familyId = me?.family.id;
  useEffect(() => {
    if (!familyId) return;
    const es = new EventSource('/api/stream');
    let hadError = false;
    es.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'family') refresh();
      else if (msg.type === 'docs' && entries.get(msg.collection)?.state.loaded) loadCollection(msg.collection);
    };
    es.onerror = () => {
      hadError = true;
    };
    es.onopen = () => {
      // Après une coupure, on rattrape ce qu'on a pu manquer.
      if (hadError) {
        hadError = false;
        refresh();
        reloadLoadedCollections();
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        refresh();
        reloadLoadedCollections();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      es.close();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [familyId, refresh]);

  const value = useMemo(() => ({ status, me, setMe, refresh, logout }), [status, me, setMe, refresh, logout]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const v = useContext(SessionContext);
  if (!v) throw new Error('SessionProvider manquant');
  return v;
}

/** À utiliser uniquement dans les écrans accessibles une fois connecté. */
export function useMe(): Me {
  const { me } = useSession();
  if (!me) throw new Error('Non connecté');
  return me;
}

export function useMembers(): { members: Member[]; byId: (id: string | null | undefined) => Member | undefined } {
  const { members } = useMe();
  return useMemo(() => {
    const map = new Map(members.map((m) => [m.id, m]));
    return { members, byId: (id) => (id ? map.get(id) : undefined) };
  }, [members]);
}

/** Petit stockage local (par appareil), tolérant aux erreurs. */
export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T) => {
      setValue(v);
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* stockage indisponible : on garde la valeur en mémoire */
      }
    },
    [key],
  );
  return [value, set];
}
