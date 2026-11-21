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
import { Engine, type FamilySettings, type Member as MemberData } from './lib/engine';
import { Notifier } from './lib/notify';
import type { Doc } from './lib/replica';
import type { SyncStatus } from './lib/sync';

export type { Doc } from './lib/replica';
export type Member = { id: string; name: string; color: string; kind?: 'child' | 'adult' };
export type Me = { member: Member; family: { name: string; settings: Omit<FamilySettings, 'name'> }; members: Member[] };

/* ------------------------------------------------------------------ Contexte */

type AppState = 'loading' | 'setup' | 'choose-member' | 'ready' | 'removed';
type Ctx = { engine: Engine | null; notifier: Notifier | null; state: AppState; error: string | null };
const AppContext = createContext<Ctx>({ engine: null, notifier: null, state: 'loading', error: null });

let booted: Promise<{ engine: Engine; notifier: Notifier }> | null = null;
function boot() {
  booted ??= Engine.boot().then((engine) => {
    const notifier = new Notifier(engine);
    engine.sync?.whenReady().then(() => {
      notifier.ensureSubscription().catch(() => {});
      notifier.scheduleUpload(false);
    });
    return { engine, notifier };
  });
  return booted;
}

function computeState(e: Engine | null): AppState {
  if (!e) return 'loading';
  if (e.removed) return 'removed';
  if (!e.circle) return 'setup';
  if (!e.memberId || !e.replica.get('members', e.memberId)) return 'choose-member';
  return 'ready';
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ctx, setCtx] = useState<Ctx>({ engine: null, notifier: null, state: 'loading', error: null });

  useEffect(() => {
    let unsub: (() => void)[] = [];
    boot()
      .then(({ engine, notifier }) => {
        const refresh = () => setCtx({ engine, notifier, state: computeState(engine), error: null });
        unsub = [engine.subscribe(refresh), engine.replica.subscribe('members', refresh)];
        let lastCircle = engine.circle?.circleId;
        unsub.push(
          engine.subscribe(() => {
            // Après un changement de cercle (rotation de clé), on réenregistre les notifications.
            if (engine.circle?.circleId !== lastCircle) {
              lastCircle = engine.circle?.circleId;
              engine.sync?.whenReady().then(() => {
                notifier.ensureSubscription().catch(() => {});
                notifier.scheduleUpload(true);
              });
            }
          }),
        );
        refresh();
      })
      .catch((err) => setCtx((c) => ({ ...c, error: String(err) })));
    return () => unsub.forEach((u) => u());
  }, []);

  return <AppContext.Provider value={ctx}>{children}</AppContext.Provider>;
}

export const useApp = () => useContext(AppContext);

export function useEngine(): Engine {
  const { engine } = useApp();
  if (!engine) throw new Error('Moteur non initialisé');
  return engine;
}

export function useNotifier(): Notifier {
  const { notifier } = useApp();
  if (!notifier) throw new Error('Notifications non initialisées');
  return notifier;
}

export function useSyncStatus(): SyncStatus {
  const engine = useEngine();
  return useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => engine.sync?.status ?? 'local',
  );
}

/* ------------------------------------------------------------------ Collections */

export type Collection<T> = {
  docs: Doc<T>[];
  loaded: boolean;
  create: (data: T) => Promise<Doc<T>>;
  update: (id: string, patch: Partial<T>) => Promise<void>;
  remove: (id: string) => Promise<void>;
};

/**
 * Accès à une collection de la famille. Les données sont lues sur l'appareil
 * (instantané, même hors ligne) et les modifications sont synchronisées en arrière-plan.
 */
export function useCollection<T extends object>(name: string): Collection<T> {
  const engine = useEngine();
  const r = engine.replica;
  const docs = useSyncExternalStore(
    (cb) => r.subscribe(name, cb),
    () => r.list<T>(name),
  );
  return useMemo(
    () => ({
      docs,
      loaded: true,
      create: (data: T) => r.create<T>(name, data),
      update: (id: string, patch: Partial<T>) => r.update<T>(name, id, patch),
      remove: (id: string) => r.remove(name, id),
    }),
    [docs, r, name],
  );
}

export function useDoc<T extends object>(collection: string, id: string): Doc<T> | undefined {
  const { docs } = useCollection<T>(collection);
  return docs.find((d) => d.id === id);
}

/* ------------------------------------------------------------------ Moi / la famille */

export function useMe(): Me {
  const engine = useEngine();
  const members = useCollection<MemberData>('members').docs;
  const settings = useDoc<FamilySettings>('settings', 'family');
  return useMemo(() => {
    const list = members.map((m) => ({ id: m.id, name: m.name, color: m.color, kind: m.kind }));
    const member = list.find((m) => m.id === engine.memberId) ?? { id: engine.memberId ?? '', name: '?', color: '#999999' };
    const { name = 'Ma famille', ...rest } = settings ?? ({} as Partial<FamilySettings>);
    return { member, members: list, family: { name, settings: rest } };
  }, [members, settings, engine.memberId]);
}

export function useMembers(): { members: Member[]; byId: (id: string | null | undefined) => Member | undefined } {
  const { members } = useMe();
  return useMemo(() => {
    const map = new Map(members.map((m) => [m.id, m]));
    return { members, byId: (id) => (id ? map.get(id) : undefined) };
  }, [members]);
}

/** Photo chiffrée → URL locale affichable. */
export function useBlobUrl(blobId: string | undefined): string | null {
  const engine = useEngine();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    if (blobId) {
      engine.getBlob(blobId).then((b) => {
        if (b && !revoked) setUrl((objectUrl = URL.createObjectURL(b)));
      });
    }
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [blobId, engine]);
  return url;
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
