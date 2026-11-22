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
import type { Item } from './lib/vault';
import type { CircleInfo } from './lib/vault';
import type { SyncStatus } from './lib/sync';

/** Élément lisible : ses champs, son propriétaire et les cercles qui le voient. */
export type Doc<T> = Item<T>;
export type Member = { id: string; name: string; color: string; kind?: 'child' | 'adult' };
export type Me = { member: Member; family: { name: string; settings: Omit<FamilySettings, 'name'> }; members: Member[] };
export type { CircleInfo };

/* ------------------------------------------------------------------ Contexte */

type AppState = 'loading' | 'setup' | 'migrate' | 'choose-member' | 'ready' | 'removed';
type Ctx = { engine: Engine | null; notifier: Notifier | null; state: AppState; error: string | null };
const AppContext = createContext<Ctx>({ engine: null, notifier: null, state: 'loading', error: null });

let booted: Promise<{ engine: Engine; notifier: Notifier }> | null = null;
function boot() {
  booted ??= Engine.boot().then((engine) => {
    // Pour les essais en développement uniquement (absent de l'appli publiée).
    if (import.meta.env.DEV) (window as unknown as { __engine: Engine }).__engine = engine;
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
  if (!e.migrated) return 'migrate';
  if (!e.memberId || !e.vault.get('members', e.memberId)) return 'choose-member';
  return 'ready';
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ctx, setCtx] = useState<Ctx>({ engine: null, notifier: null, state: 'loading', error: null });

  useEffect(() => {
    let unsub: (() => void)[] = [];
    boot()
      .then(({ engine, notifier }) => {
        const refresh = () => setCtx({ engine, notifier, state: computeState(engine), error: null });
        unsub = [engine.subscribe(refresh), engine.vault.subscribe(refresh)];
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

/** `groups` : cercles qui voient l'élément (par défaut : le réglage de l'appareil). */
type WithGroups = { groups?: string[] };

export type Collection<T> = {
  docs: Doc<T>[];
  loaded: boolean;
  create: (data: T & WithGroups) => Promise<Doc<T>>;
  update: (id: string, patch: Partial<T> & WithGroups) => Promise<void>;
  /** Supprime pour tout le monde (si on en est l'auteur), sinon seulement pour soi. */
  remove: (id: string) => Promise<'all' | 'me'>;
  /** Peut-on modifier ces champs de l'élément ? (sans champs : peut-on le supprimer pour tous ?) */
  canEdit: (id: string, fields?: string[]) => boolean;
};

/**
 * Accès à une collection. Les données sont lues sur l'appareil (instantané, même hors ligne), vérifiées par
 * le coffre (signatures, droits), et les modifications sont synchronisées en arrière-plan.
 */
export function useCollection<T extends object>(name: string): Collection<T> {
  const engine = useEngine();
  const v = engine.vault;
  const defaults = useDefaultGroups();
  const docs = useSyncExternalStore(
    (cb) => v.subscribe(cb),
    () => v.list<T>(name),
  );
  return useMemo(
    () => ({
      docs,
      loaded: true,
      create: (data: T & WithGroups) => v.create<T>(name, data, { groups: data.groups?.length ? data.groups : defaults }),
      update: (id: string, patch: Partial<T> & WithGroups) => v.update<T>(name, id, patch, patch.groups),
      remove: (id: string) => v.remove(name, id),
      canEdit: (id: string, fields?: string[]) => v.canEdit(name, id, fields, !fields),
    }),
    [docs, v, name, defaults],
  );
}

export function useDoc<T extends object>(collection: string, id: string): Doc<T> | undefined {
  const { docs } = useCollection<T>(collection);
  return docs.find((d) => d.id === id);
}

/* ------------------------------------------------------------------ Cercles */

/** Cercles lisibles par cet appareil (se met à jour à chaque vérification). */
export function useCircles(): CircleInfo[] {
  const engine = useEngine();
  const v = engine.vault;
  useSyncExternalStore((cb) => v.subscribe(cb), v.getVersion);
  return v.circles();
}

/** Le coffre (pour les écrans qui gèrent les cercles). */
export function useVault() {
  const engine = useEngine();
  const v = engine.vault;
  useSyncExternalStore((cb) => v.subscribe(cb), v.getVersion);
  return v;
}

/* ------------------------------------------------------------------ Cercles par défaut (réglage de l'appareil) */

const DEFAULT_KEY = 'circles.default';
const defaultListeners = new Set<() => void>();
let defaultChoice: string[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(DEFAULT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
})();

export function setDefaultCircles(ids: string[]) {
  defaultChoice = ids;
  try {
    localStorage.setItem(DEFAULT_KEY, JSON.stringify(ids));
  } catch {
    /* stockage indisponible : réglage gardé en mémoire */
  }
  defaultListeners.forEach((l) => l());
}

/** Cercles où ranger un nouvel élément : le réglage de l'appareil, sinon le premier cercle partagé. */
export function useDefaultGroups(): string[] {
  const choice = useSyncExternalStore(
    (l) => {
      defaultListeners.add(l);
      return () => defaultListeners.delete(l);
    },
    () => defaultChoice,
  );
  const circles = useCircles();
  return useMemo(() => {
    const ok = choice.filter((id) => circles.some((c) => c.id === id && c.writable));
    if (ok.length) return ok;
    const first = circles.find((c) => !c.personal && c.writable) ?? circles.find((c) => c.writable);
    return first ? [first.id] : [];
  }, [choice, circles]);
}

/* ------------------------------------------------------------------ Moi / la famille */

/**
 * Moi, les personnes de mes cercles, et les réglages communs. Un profil ne compte que s'il est écrit par la
 * personne elle-même (ou, pour un enfant sans appareil, par celui qui l'a créé).
 * Le « nom de la famille » affiché est celui du premier cercle partagé.
 */
export function useMe(): Me {
  const engine = useEngine();
  const members = useCollection<MemberData>('members').docs;
  const settings = useDoc<FamilySettings>('settings', 'family');
  const circles = useCircles();
  return useMemo(() => {
    const list = members.map((m) => ({ id: m.id, name: m.name, color: m.color, kind: m.kind }));
    const member = list.find((m) => m.id === engine.memberId) ?? { id: engine.memberId ?? '', name: '?', color: '#999999' };
    const { name: _old, ...rest } = settings ?? ({} as Partial<FamilySettings>);
    void _old;
    const shared = circles.find((c) => !c.personal);
    return { member, members: list, family: { name: shared?.name ?? 'Ma famille', settings: rest } };
  }, [members, settings, engine.memberId, circles]);
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
