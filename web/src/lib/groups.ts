/**
 * Cercles restreints (« Parents », « Moi seul »…) à l'intérieur de la famille : fonctions pures,
 * testées dans groups.test.ts.
 *
 * Toute la famille partage la clé du cercle familial : ce qui doit rester entre quelques personnes est donc
 * chiffré une SECONDE fois, avec la clé du (ou des) cercle(s) restreint(s) :
 *
 *   secret du cercle restreint (256 bits, propre au cercle)
 *     ├─ transmis à chaque appareil AUTORISÉ, chiffré pour sa clé publique (collection `groupKeys`)
 *     └─ HKDF → clé AES-256-GCM du cercle
 *           ├─ chiffre la description du cercle : nom, couleur, membres (collection `groups`)
 *           └─ chiffre la clé à usage unique de chaque élément (« enveloppes »)
 *   clé à usage unique de l'élément → chiffre l'évènement lui-même (collection `privateEvents`)
 *
 * Un élément partagé par plusieurs cercles n'est chiffré qu'une fois ; seule sa clé est « emballée » pour
 * chaque cercle. Un appareil de la famille hors de ces cercles ne voit qu'un paquet illisible (ni titre, ni
 * date), et le relais, lui, ne voit toujours que la couche de chiffrement familiale.
 *
 * Retirer quelqu'un d'un cercle crée une nouvelle clé (une « époque » de plus), transmise aux seuls appareils
 * restants : la personne retirée garde ce qu'elle avait déjà vu, mais ne peut plus lire ce qui est écrit ensuite
 * (chaque modification d'un élément tire une nouvelle clé à usage unique).
 */
import { fromUtf8, hex, utf8 } from './bytes';
import { deriveGroupKey, deriveGroupKeyId, importItemKey, safetyCode, newItemKey, open, openFromDevice, openJSON, seal, sealJSON, sealToDevice } from './crypto';

type Bytes = Uint8Array<ArrayBuffer>;

/** Description d'un cercle restreint (stockée chiffrée avec la clé du cercle). */
export type GroupMeta = {
  name: string;
  color: string;
  /** Membres de la famille qui font partie du cercle. */
  members: string[];
  /** Cercle personnel (« Moi seul ») de ce membre. */
  personal?: string;
  /** Cercle supprimé (la suppression est elle aussi chiffrée : un appareil sans accès ne peut pas la simuler). */
  deleted?: boolean;
};
/** Document `groups/<id>` : la description chiffrée, et l'identifiant de la clé utilisée. */
export type GroupDoc = { meta?: string | null; mk?: string | null };
/**
 * Document `groupKeys/<keyId><deviceId>` : le secret d'un cercle, chiffré pour UN appareil.
 *  - `proof` : preuve, chiffrée avec la clé du cercle, que cet appareil a été autorisé par un appareil qui
 *    détenait la clé (un appareil sans la clé ne peut pas se déclarer « autorisé » pour recevoir les rappels) ;
 *  - `links` : pour une clé renouvelée (époque > 0), preuve(s) chiffrée(s) avec la ou les clés précédentes : seul
 *    un appareil qui détenait la clé en vigueur peut en annoncer une nouvelle.
 */
export type GroupKeyDoc = {
  group: string;
  key: string;
  epoch: number;
  device: string;
  env: string;
  by: string;
  proof?: string;
  links?: { pk: string; link: string }[];
  /** Signature de l'appareil `by` pour l'appareil `device` : le destinataire sait qui lui remet la clé. */
  auth?: string;
};
/** Document `privateEvents/<id>` : un évènement chiffré pour un ou plusieurs cercles. */
export type PrivateBox = { v: 1; w: Record<string, string>; d: string };
export type PrivateDoc = { box?: PrivateBox | null };

/** Clé d'un cercle détenue par cet appareil. */
export type HeldKey = { group: string; keyId: string; epoch: number; key: CryptoKey; secret: Bytes };

const ID_RE = /^[0-9a-f]{32}$/;
export const isId = (s: unknown): s is string => typeof s === 'string' && ID_RE.test(s);

/* ------------------------------------------------------------------ Identifiants */

/** Identifiant du cercle personnel d'un membre : le même sur tous ses appareils (évite les doublons). */
export async function personalGroupId(memberId: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(`family-app/personal-group:${memberId}`)));
  return hex(h.slice(0, 16));
}

/* ------------------------------------------------------------------ Clés : la plus récente, qui l'a */

type KeyRef = { key: string; epoch: number };
/** Ordre des clés d'un cercle : époque la plus haute, puis (en cas d'égalité) identifiant le plus petit. */
export const newer = (a: KeyRef, b: KeyRef) => a.epoch > b.epoch || (a.epoch === b.epoch && a.key < b.key);

/** Clé en vigueur d'un cercle (celle avec laquelle on doit chiffrer), d'après toutes les enveloppes connues. */
export function latestKey(keys: GroupKeyDoc[], group: string): KeyRef | null {
  let best: KeyRef | null = null;
  for (const k of keys) {
    if (k.group !== group || !isId(k.key) || !Number.isInteger(k.epoch) || k.epoch < 0) continue;
    if (!best || newer(k, best)) best = { key: k.key, epoch: k.epoch };
  }
  return best;
}


type DeviceLike = { id: string; memberId: string; revoked?: boolean; pub?: JsonWebKey; label?: string };

/**
 * Appareils qui attendent l'accès à un cercle : appareils (non retirés) des membres du cercle qui ne sont pas
 * parmi les appareils autorisés (`holders`, preuves vérifiées). Ils ne reçoivent PAS la clé automatiquement : un
 * appareil qui choisit le profil de quelqu'un d'autre à son arrivée dans la famille ne doit pas pouvoir lire ses
 * éléments privés. Un appareil qui a déjà accès doit l'autoriser d'un geste.
 */
export function pendingDevices<D extends DeviceLike>(meta: GroupMeta, holders: Set<string>, devices: D[]): D[] {
  return devices.filter((d) => !d.revoked && !!d.pub && meta.members.includes(d.memberId) && !holders.has(d.id));
}

/* ------------------------------------------------------------------ Secret du cercle pour un appareil */

const envContext = (group: string, keyId: string, epoch: number, device: string) => `group-key:${group}:${keyId}:${epoch}:${device}`;

export async function sealGroupSecret(pub: JsonWebKey, secret: Bytes, group: string, keyId: string, epoch: number, device: string) {
  return sealToDevice(pub, secret, envContext(group, keyId, epoch, device));
}

/** Contexte de la signature d'une enveloppe : qui (`by`) remet quelle clé à quel appareil. */
export const authContext = (group: string, keyId: string, epoch: number, device: string, by: string) =>
  `group-auth:${group}:${keyId}:${epoch}:${device}:${by}`;

/** Nouvelle clé de cercle : secret aléatoire, identifiant dérivé du secret. */
export async function newGroupKey(group: string, epoch: number, secret: Bytes): Promise<HeldKey> {
  return { group, keyId: await deriveGroupKeyId(secret), epoch, key: await deriveGroupKey(secret), secret };
}

const proofContext = (k: Pick<HeldKey, 'group' | 'keyId'>, device: string) => `group-grant:${k.group}:${k.keyId}:${device}`;
const linkContext = (group: string, keyId: string, epoch: number) => `group-link:${group}:${keyId}:${epoch}`;

/** Preuve d'autorisation d'un appareil (faite avec la clé du cercle). */
export const grantProof = (k: HeldKey, device: string) => seal(k.key, utf8.encode(device), proofContext(k, device));
export async function checkProof(k: HeldKey, device: string, proof: unknown): Promise<boolean> {
  if (typeof proof !== 'string') return false;
  try {
    return fromUtf8.decode(await open(k.key, proof, proofContext(k, device))) === device;
  } catch {
    return false;
  }
}

/** Lien d'une nouvelle clé vers la précédente (fait avec la clé précédente). */
export const keyLink = (prev: HeldKey, next: Pick<HeldKey, 'keyId' | 'epoch'>) =>
  seal(prev.key, utf8.encode(next.keyId), linkContext(prev.group, next.keyId, next.epoch));
export async function checkLink(prev: HeldKey, next: Pick<HeldKey, 'keyId' | 'epoch'>, link: unknown): Promise<boolean> {
  if (typeof link !== 'string' || prev.epoch !== next.epoch - 1) return false;
  try {
    return fromUtf8.decode(await open(prev.key, link, linkContext(prev.group, next.keyId, next.epoch))) === next.keyId;
  } catch {
    return false;
  }
}

/** Liens d'une clé renouvelée vers les clés précédentes (une seule en général ; plusieurs après un conflit). */
export type KeyLinkRef = { pk: string; link: string };
function linksOf(d: GroupKeyDoc): KeyLinkRef[] {
  const out: KeyLinkRef[] = [];
  if (Array.isArray(d.links)) for (const l of d.links) if (l && typeof l.pk === 'string' && typeof l.link === 'string') out.push(l);
  return out;
}

/** Appareils dont l'autorisation pour une clé est prouvée (preuve chiffrée avec cette clé). */
export async function provenHolders(k: HeldKey, docs: GroupKeyDoc[], cache?: Map<string, boolean>): Promise<Set<string>> {
  const out = new Set<string>();
  for (const d of docs) {
    if (d.key !== k.keyId || typeof d.device !== 'string') continue;
    const ck = `${k.keyId}|${d.device}|${d.proof}`;
    let ok = cache?.get(ck);
    if (ok === undefined) {
      ok = await checkProof(k, d.device, d.proof);
      cache?.set(ck, ok);
    }
    if (ok) out.add(d.device);
  }
  return out;
}

const subset = (a: Set<string>, b: Set<string>) => [...a].every((x) => b.has(x));

export type Resolved = {
  /** Clé avec laquelle chiffrer (null : pas encore acceptée, ou conflit non résolu). */
  current: HeldKey | null;
  /** Dernière clé sûre et unique (à épingler). */
  pinned: HeldKey | null;
  /** Appareils autorisés pour `current`. */
  holders: Set<string>;
  /** Conflit : clés concurrentes qu'on ne sait pas départager (écriture bloquée jusqu'au renouvellement). */
  conflict: { key: HeldKey; holders: Set<string> }[] | null;
  /** Sans épingle (premier accès) : clés proposées, à accepter après comparaison d'un code. */
  offers: HeldKey[];
};

/**
 * Clé en vigueur d'un cercle pour CET appareil.
 *
 * - On part de la clé « épinglée » (la dernière jugée sûre, gardée sur l'appareil) et on ne monte d'une époque
 *   que par une clé **liée** à une clé sûre (preuve chiffrée avec elle). Une clé fabriquée par un appareil sans
 *   la clé en vigueur n'est jamais adoptée ; une clé concurrente à la même époque que l'épingle est ignorée.
 * - Deux clés liées à la même époque (un ancien membre a fabriqué une clé concurrente avec l'ancienne clé au
 *   moment de son retrait, ou deux renouvellements simultanés) : on garde celle dont les appareils autorisés
 *   sont **inclus** dans ceux de toutes les autres. Les appareils « qui connaissent » une clé comptent aussi
 *   (`knowers` : l'appareil qui nous l'a remise, signature vérifiée) : une clé fabriquée par la personne retirée
 *   contient donc forcément son appareil, et ne peut pas gagner. Sinon : conflit, écriture bloquée jusqu'au
 *   renouvellement.
 * - Sans épingle (nouvel appareil) : rien n'est adopté automatiquement ; les clés reçues sont « proposées », à
 *   accepter après avoir comparé un code avec l'appareil qui a donné l'accès (voir grantCode).
 */
export async function resolveCurrent(
  held: HeldKey[],
  docs: GroupKeyDoc[],
  pin?: string,
  proofCache?: Map<string, boolean>,
  knowers?: Map<string, Set<string>>,
): Promise<Resolved> {
  const start = pin ? held.find((k) => k.keyId === pin) : undefined;
  if (!start) {
    const offers = [...held].sort((a, b) => b.epoch - a.epoch || (a.keyId < b.keyId ? -1 : 1));
    return { current: null, pinned: null, holders: new Set(), conflict: null, offers };
  }
  let level: HeldKey[] = [start];
  let pinned = start;
  for (;;) {
    const epoch = level[0].epoch + 1;
    const next: HeldKey[] = [];
    for (const k of held) {
      if (k.epoch !== epoch) continue;
      let ok = false;
      for (const d of docs) {
        if (d.key !== k.keyId) continue;
        for (const l of linksOf(d)) {
          const prev = level.find((t) => t.keyId === l.pk);
          if (prev && (await checkLink(prev, k, l.link))) {
            ok = true;
            break;
          }
        }
        if (ok) break;
      }
      if (ok) next.push(k);
    }
    if (!next.length) break;
    if (next.length === 1) {
      level = next;
      pinned = next[0];
      continue;
    }
    // Appareils qui connaissent chaque clé : autorisés prouvés + appareils qui nous l'ont remise (signature
    // vérifiée). L'auteur d'une clé concurrente ne peut donc pas se cacher pour la faire gagner.
    const withHolders = await Promise.all(
      next.map(async (key) => {
        const holders = await provenHolders(key, docs, proofCache);
        for (const d of knowers?.get(key.keyId) ?? []) holders.add(d);
        return { key, holders };
      }),
    );
    const minimal = withHolders.filter((a) => withHolders.every((b) => subset(a.holders, b.holders)));
    if (minimal.length >= 1) {
      // Plusieurs clés aux autorisés identiques (même renouvellement envoyé deux fois) : la plus petite, au hasard.
      minimal.sort((a, b) => (a.key.keyId < b.key.keyId ? -1 : 1));
      level = [minimal[0].key];
      pinned = minimal[0].key;
      continue;
    }
    return { current: null, pinned, holders: new Set(), conflict: withHolders, offers: [] };
  }
  return { current: level[0], pinned: level[0], holders: await provenHolders(level[0], docs, proofCache), conflict: null, offers: [] };
}

/**
 * Code de vérification d'un accès (5 émojis) : calculé avec le secret de la clé et l'appareil qui la reçoit.
 * L'appareil qui donne l'accès l'affiche ; le nouvel appareil aussi, pour chaque clé reçue. Une fausse clé
 * (envoyée par un autre appareil) donne un autre code.
 */
export const grantCode = (k: HeldKey, deviceId: string) => safetyCode('group-grant', k.secret, deviceId);

/** Ouvre une enveloppe adressée à cet appareil ; null si elle est illisible ou incohérente. */
export async function openGroupSecret(privateKey: CryptoKey, doc: GroupKeyDoc, deviceId: string): Promise<HeldKey | null> {
  if (doc.device !== deviceId || !isId(doc.group) || !isId(doc.key) || !Number.isInteger(doc.epoch) || typeof doc.env !== 'string') return null;
  try {
    const secret = await openFromDevice(privateKey, doc.env, envContext(doc.group, doc.key, doc.epoch, deviceId));
    // L'identifiant de la clé est dérivé de son secret : impossible d'annoncer un autre secret sous ce nom.
    if (secret.length !== 32 || (await deriveGroupKeyId(secret)) !== doc.key) return null;
    return { group: doc.group, keyId: doc.key, epoch: doc.epoch, key: await deriveGroupKey(secret), secret };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ Description du cercle */

export const sealGroupMeta = (k: HeldKey, meta: GroupMeta) => sealJSON(k.key, meta, `group-meta:${k.group}`);

export async function openGroupMeta(doc: GroupDoc | undefined, held: Map<string, HeldKey>, group: string): Promise<GroupMeta | null> {
  const k = doc?.mk ? held.get(doc.mk) : undefined;
  if (!k || k.group !== group || typeof doc?.meta !== 'string') return null;
  try {
    const m = await openJSON<GroupMeta>(k.key, doc.meta, `group-meta:${group}`);
    if (typeof m?.name !== 'string' || !Array.isArray(m.members)) return null;
    return {
      name: m.name,
      color: typeof m.color === 'string' ? m.color : '#8E5CE6',
      members: m.members.filter((x) => typeof x === 'string'),
      personal: m.personal,
      ...(m.deleted ? { deleted: true } : {}),
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ Éléments chiffrés pour des cercles */

const wrapContext = (itemId: string, keyId: string) => `group-wrap:${itemId}:${keyId}`;
const dataContext = (collection: string, itemId: string) => `private:${collection}:${itemId}`;

/**
 * Chiffre un élément pour des cercles.
 *  - `keys` : la clé en vigueur de chaque cercle que cet appareil détient ;
 *  - `keep` : enveloppes à conserver telles quelles (cercles dont on ne détient pas la clé, lors d'une
 *    modification : il faut alors réutiliser la clé de l'élément, qu'on extrait de `previous`).
 * Sans `keep`, une nouvelle clé à usage unique est tirée à chaque enregistrement.
 */
export async function sealPrivate(
  collection: string,
  itemId: string,
  data: unknown,
  keys: HeldKey[],
  opts: { keep?: Record<string, string>; previous?: PrivateBox; held?: Map<string, HeldKey> } = {},
): Promise<PrivateBox> {
  const keep = opts.keep ?? {};
  let item: { raw: Bytes; key: CryptoKey };
  if (Object.keys(keep).length) {
    const raw = opts.previous && opts.held ? await unwrapItemKey(itemId, opts.previous, opts.held) : null;
    if (!raw) throw new Error('Clé de l’élément introuvable');
    item = { raw, key: await importItemKey(raw) };
  } else item = await newItemKey();
  if (!keys.length && !Object.keys(keep).length) throw new Error('Aucun cercle');
  const w: Record<string, string> = { ...keep };
  for (const k of keys) w[k.keyId] = await seal(k.key, item.raw, wrapContext(itemId, k.keyId));
  return { v: 1, w, d: await seal(item.key, utf8.encode(JSON.stringify(data)), dataContext(collection, itemId)) };
}

async function unwrapItemKey(itemId: string, box: PrivateBox, held: Map<string, HeldKey>): Promise<Bytes | null> {
  for (const [keyId, wrapped] of Object.entries(box.w ?? {})) {
    const k = held.get(keyId);
    if (!k || typeof wrapped !== 'string') continue;
    try {
      const raw = await open(k.key, wrapped, wrapContext(itemId, keyId));
      if (raw.length === 32) return raw;
    } catch {
      /* enveloppe illisible : on essaie la suivante */
    }
  }
  return null;
}

/** Déchiffre un élément ; null si cet appareil n'a la clé d'aucun de ses cercles. */
export async function openPrivate<T>(collection: string, itemId: string, box: PrivateBox | null | undefined, held: Map<string, HeldKey>): Promise<T | null> {
  if (!box || box.v !== 1 || typeof box.d !== 'string' || !box.w || typeof box.w !== 'object') return null;
  const raw = await unwrapItemKey(itemId, box, held);
  if (!raw) return null;
  try {
    const pt = await open(await importItemKey(raw), box.d, dataContext(collection, itemId));
    return JSON.parse(fromUtf8.decode(pt)) as T;
  } catch {
    return null;
  }
}
