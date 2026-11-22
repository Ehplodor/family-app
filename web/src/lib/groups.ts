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
import { deriveGroupKey, importItemKey, newItemKey, open, openFromDevice, openJSON, seal, sealJSON, sealToDevice } from './crypto';

type Bytes = Uint8Array<ArrayBuffer>;

/** Description d'un cercle restreint (stockée chiffrée avec la clé du cercle). */
export type GroupMeta = {
  name: string;
  color: string;
  /** Membres de la famille qui font partie du cercle. */
  members: string[];
  /** Cercle personnel (« Moi seul ») de ce membre. */
  personal?: string;
};
/** Document `groups/<id>` : la description chiffrée, et l'identifiant de la clé utilisée. */
export type GroupDoc = { meta?: string | null; mk?: string | null };
/** Document `groupKeys/<keyId><deviceId>` : le secret d'un cercle, chiffré pour UN appareil. */
export type GroupKeyDoc = { group: string; key: string; epoch: number; device: string; env: string; by: string };
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

/** Appareils qui ont reçu une clé donnée. */
export const holdersOf = (keys: GroupKeyDoc[], keyId: string) => new Set(keys.filter((k) => k.key === keyId).map((k) => k.device));

type DeviceLike = { id: string; memberId: string; revoked?: boolean; pub?: JsonWebKey; label?: string };

/**
 * Appareils qui attendent l'accès à un cercle : appareils (non retirés) des membres du cercle qui n'ont pas
 * la clé en vigueur. Ils ne la reçoivent PAS automatiquement : un appareil qui choisit le profil de quelqu'un
 * d'autre à son arrivée dans la famille ne doit pas pouvoir lire ses éléments privés. Un appareil qui a déjà
 * accès doit l'autoriser d'un geste.
 */
export function pendingDevices<D extends DeviceLike>(meta: GroupMeta, keys: GroupKeyDoc[], group: string, devices: D[]): D[] {
  const latest = latestKey(keys, group);
  if (!latest) return [];
  const holders = holdersOf(keys, latest.key);
  return devices.filter((d) => !d.revoked && !!d.pub && meta.members.includes(d.memberId) && !holders.has(d.id));
}

/* ------------------------------------------------------------------ Secret du cercle pour un appareil */

const envContext = (group: string, keyId: string, epoch: number, device: string) => `group-key:${group}:${keyId}:${epoch}:${device}`;

export async function sealGroupSecret(pub: JsonWebKey, secret: Bytes, group: string, keyId: string, epoch: number, device: string) {
  return sealToDevice(pub, secret, envContext(group, keyId, epoch, device));
}

/** Ouvre une enveloppe adressée à cet appareil ; null si elle est illisible ou incohérente. */
export async function openGroupSecret(privateKey: CryptoKey, doc: GroupKeyDoc, deviceId: string): Promise<HeldKey | null> {
  if (doc.device !== deviceId || !isId(doc.group) || !isId(doc.key) || !Number.isInteger(doc.epoch) || typeof doc.env !== 'string') return null;
  try {
    const secret = await openFromDevice(privateKey, doc.env, envContext(doc.group, doc.key, doc.epoch, deviceId));
    if (secret.length !== 32) return null;
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
    return { name: m.name, color: typeof m.color === 'string' ? m.color : '#8E5CE6', members: m.members.filter((x) => typeof x === 'string'), personal: m.personal };
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
