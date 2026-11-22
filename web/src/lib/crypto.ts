/**
 * Cryptographie du cercle familial (WebCrypto uniquement, aucune bibliothèque tierce).
 *
 *  - Secret du cercle : 256 bits aléatoires, ne quitte jamais les appareils en clair.
 *  - HKDF-SHA-256 en dérive des clés indépendantes :
 *      · identifiant du cercle (connu du relais, ne révèle rien du secret),
 *      · jeton d'accès au relais (le relais n'en garde que l'empreinte),
 *      · clé de chiffrement AES-256-GCM (jamais transmise).
 *  - Chaque message : IV aléatoire de 96 bits + données associées (cercle + usage),
 *    ce qui empêche de rejouer un message d'un contexte dans un autre.
 *  - Appareils : paire ECDH P-256 pour recevoir un secret (invitation, renouvellement de clé).
 *  - Sauvegardes : PBKDF2-SHA-256 (600 000 itérations) + AES-256-GCM.
 */
import { b64url, concat, fromB64url, fromUtf8, hex, randomBytes, utf8 } from './bytes';

const subtle = crypto.subtle;
type Bytes = Uint8Array<ArrayBuffer>;

async function hkdfBytes(secret: Bytes, info: string, length: number): Promise<Bytes> {
  const base = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8.encode('family-app/v1'), info: utf8.encode(info) },
    base,
    length * 8,
  );
  return new Uint8Array(bits);
}

async function aesKeyFrom(secret: Bytes, info: string): Promise<CryptoKey> {
  const raw = await hkdfBytes(secret, info, 32);
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export type CircleKeys = { circleId: string; token: string; key: CryptoKey };

export async function deriveCircleKeys(secret: Bytes): Promise<CircleKeys> {
  return {
    circleId: hex(await hkdfBytes(secret, 'circle-id', 16)),
    token: b64url(await hkdfBytes(secret, 'relay-token', 32)),
    key: await aesKeyFrom(secret, 'content-key'),
  };
}

export const newSecret = () => randomBytes(32);

/** Chiffre des octets. Format : "v1." + base64url(IV || texte chiffré + tag). */
export async function seal(key: CryptoKey, data: Uint8Array, aad: string): Promise<string> {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(aad) }, key, data as Bytes);
  return `v1.${b64url(concat(iv, new Uint8Array(ct)))}`;
}

export async function open(key: CryptoKey, sealed: string, aad: string): Promise<Bytes> {
  if (!sealed.startsWith('v1.')) throw new Error('Format inconnu');
  const raw = fromB64url(sealed.slice(3));
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: raw.subarray(0, 12), additionalData: utf8.encode(aad) },
    key,
    raw.subarray(12),
  );
  return new Uint8Array(pt);
}

export const sealJSON = (key: CryptoKey, value: unknown, aad: string) => seal(key, utf8.encode(JSON.stringify(value)), aad);
export const openJSON = async <T>(key: CryptoKey, sealed: string, aad: string): Promise<T> =>
  JSON.parse(fromUtf8.decode(await open(key, sealed, aad)));

/** Chiffrement binaire (photos) : IV || texte chiffré. */
export async function sealBytes(key: CryptoKey, data: Uint8Array, aad: string): Promise<Bytes> {
  const iv = randomBytes(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(aad) }, key, data as Bytes);
  return concat(iv, new Uint8Array(ct));
}
export async function openBytes(key: CryptoKey, data: Uint8Array, aad: string): Promise<Bytes> {
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: data.subarray(0, 12) as Bytes, additionalData: utf8.encode(aad) },
    key,
    data.subarray(12) as Bytes,
  );
  return new Uint8Array(pt);
}

/* ---------------------------------------------------------------- Appareils (ECDH) */

export type DeviceKeys = { privateKey: CryptoKey; publicJwk: JsonWebKey };

export async function newDeviceKeys(): Promise<DeviceKeys> {
  const kp = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])) as CryptoKeyPair;
  const jwk = await subtle.exportKey('jwk', kp.publicKey);
  return { privateKey: kp.privateKey, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
}

async function ecdhKey(privateKey: CryptoKey, publicJwk: JsonWebKey, info: string) {
  const pub = await subtle.importKey('jwk', publicJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, privateKey, 256));
  return aesKeyFrom(shared, info);
}

/** Chiffre des octets pour un appareil précis (clé éphémère + ECDH + AES-GCM). */
export async function sealToDevice(publicJwk: JsonWebKey, data: Uint8Array, context: string): Promise<string> {
  const eph = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const ephJwk = await subtle.exportKey('jwk', eph.publicKey);
  const key = await ecdhKey(eph.privateKey, publicJwk, `device-seal:${context}`);
  const box = await seal(key, data, context);
  return JSON.stringify({ e: { kty: ephJwk.kty, crv: ephJwk.crv, x: ephJwk.x, y: ephJwk.y }, b: box });
}

export async function openFromDevice(privateKey: CryptoKey, envelope: string, context: string): Promise<Bytes> {
  const { e, b } = JSON.parse(envelope) as { e: JsonWebKey; b: string };
  const key = await ecdhKey(privateKey, e, `device-seal:${context}`);
  return open(key, b, context);
}

/**
 * Signature d'un appareil POUR un autre appareil : clé partagée ECDH entre la clé privée de l'un et la clé
 * publique de l'autre (seuls ces deux appareils peuvent la calculer), puis AES-GCM sur un contenu vide avec
 * le contexte en données associées. Le destinataire sait ainsi quel appareil a écrit le message.
 */
export async function deviceAuth(privateKey: CryptoKey, peerPublicJwk: JsonWebKey, context: string): Promise<string> {
  const key = await ecdhKey(privateKey, peerPublicJwk, `device-auth:${context}`);
  return seal(key, new Uint8Array(0), context);
}

export async function checkDeviceAuth(privateKey: CryptoKey, peerPublicJwk: JsonWebKey, tag: unknown, context: string): Promise<boolean> {
  if (typeof tag !== 'string') return false;
  try {
    const key = await ecdhKey(privateKey, peerPublicJwk, `device-auth:${context}`);
    return (await open(key, tag, context)).length === 0;
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- Invitations */

export type InviteKeys = { inviteId: string; key: CryptoKey };
export async function deriveInviteKeys(inviteSecret: Bytes): Promise<InviteKeys> {
  return {
    inviteId: hex(await hkdfBytes(inviteSecret, 'invite-id', 16)),
    key: await aesKeyFrom(inviteSecret, 'invite-key'),
  };
}

/* ---------------------------------------------------------------- Codes de vérification */

const EMOJIS = [
  '🐶', '🐱', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🦉', '🦄',
  '🐝', '🦋', '🐢', '🐙', '🐬', '🐳', '🌵', '🌲', '🌻', '🍀', '🍄', '🌙', '⭐', '🔥', '🌈', '❄️',
  '🍎', '🍋', '🍌', '🍉', '🍇', '🍓', '🥕', '🌽', '🍕', '🍩', '🍪', '🎂', '☕', '⚽', '🏀', '🎸',
  '🎈', '🎁', '📚', '✏️', '🔑', '🔔', '⏰', '🚲', '🚗', '🚀', '⛵', '🏠', '⛺', '🎩', '👓', '🧩',
];

/** Code de 5 émojis (30 bits) à comparer de vive voix entre deux appareils. */
export async function safetyCode(...parts: (Uint8Array | string)[]): Promise<string> {
  const data = concat(...parts.map((p) => (typeof p === 'string' ? utf8.encode(p) : p)));
  const h = new Uint8Array(await subtle.digest('SHA-256', data));
  let bits = 0n;
  for (let i = 0; i < 4; i++) bits = (bits << 8n) | BigInt(h[i]);
  const out: string[] = [];
  for (let i = 0; i < 5; i++) out.push(EMOJIS[Number((bits >> BigInt(26 - i * 6)) & 63n)]);
  return out.join(' ');
}

/* ---------------------------------------------------------------- Sauvegardes protégées par phrase secrète */

const PBKDF2_ITERATIONS = 600_000;

export async function passphraseSeal(passphrase: string, data: Uint8Array): Promise<string> {
  const salt = randomBytes(16);
  const key = await passphraseKey(passphrase, salt, PBKDF2_ITERATIONS);
  return JSON.stringify({ v: 1, kdf: 'PBKDF2-SHA256', it: PBKDF2_ITERATIONS, salt: b64url(salt), data: await seal(key, data, 'backup') });
}

export async function passphraseOpen(passphrase: string, text: string): Promise<Bytes> {
  const f = JSON.parse(text) as { v: number; it: number; salt: string; data: string };
  if (f.v !== 1) throw new Error('Format de sauvegarde inconnu');
  const key = await passphraseKey(passphrase, fromB64url(f.salt), f.it);
  return open(key, f.data, 'backup');
}

async function passphraseKey(passphrase: string, salt: Bytes, iterations: number) {
  const base = await subtle.importKey('raw', utf8.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/* ---------------------------------------------------------------- Cercles restreints (groupes) */

/**
 * Clé AES-256-GCM d'un cercle restreint (« Parents », « Moi seul »…), dérivée de son propre secret de
 * 256 bits. Ce secret n'est transmis qu'aux appareils autorisés, chiffré pour chacun (sealToDevice).
 */
export const deriveGroupKey = (secret: Bytes) => aesKeyFrom(secret, 'group-content-key');
/**
 * Identifiant d'une clé de cercle, dérivé de son secret : une enveloppe qui annoncerait un autre secret sous
 * cet identifiant (document réécrit par un appareil malveillant) est rejetée.
 */
export const deriveGroupKeyId = async (secret: Bytes) => hex(await hkdfBytes(secret, 'group-key-id', 16));

/** Clé aléatoire à usage unique pour un élément partagé par plusieurs cercles (octets bruts + clé AES). */
export async function newItemKey(): Promise<{ raw: Bytes; key: CryptoKey }> {
  const raw = randomBytes(32);
  return { raw, key: await importItemKey(raw) };
}
export const importItemKey = (raw: Bytes) => subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

/* ---------------------------------------------------------------- Signatures (ECDSA P-256) */

/**
 * JSON canonique : clés triées, pour que la même donnée donne toujours les mêmes octets à signer.
 * `undefined` est ignoré (comme JSON.stringify).
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonical(v))).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDSA_SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

export type SigningKeys = { signKey: CryptoKey; signJwk: JsonWebKey };

/** Clé de signature d'un appareil : la clé privée n'est pas exportable. */
export async function newSigningKeys(extractable = false): Promise<SigningKeys & { pair: CryptoKeyPair }> {
  const pair = (await subtle.generateKey(ECDSA, extractable, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await subtle.exportKey('jwk', pair.publicKey);
  return { pair, signKey: pair.privateKey, signJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
}

/** Signe une donnée (JSON canonique) pour un usage précis : une signature ne vaut que dans son contexte. */
export async function sign(key: CryptoKey, context: string, value: unknown): Promise<string> {
  const sig = await subtle.sign(ECDSA_SIGN, key, utf8.encode(`${context}\n${canonical(value)}`));
  return b64url(new Uint8Array(sig));
}

const verifyKeys = new Map<string, Promise<CryptoKey | null>>();
function importVerifyKey(jwk: JsonWebKey): Promise<CryptoKey | null> {
  const id = `${jwk.x}.${jwk.y}`;
  let k = verifyKeys.get(id);
  if (!k) {
    k = subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, ECDSA, false, ['verify']).catch(() => null);
    verifyKeys.set(id, k);
  }
  return k;
}

export async function verify(jwk: JsonWebKey | undefined, context: string, value: unknown, sig: unknown): Promise<boolean> {
  if (!jwk || typeof jwk.x !== 'string' || typeof jwk.y !== 'string' || typeof sig !== 'string') return false;
  const key = await importVerifyKey(jwk);
  if (!key) return false;
  try {
    return await subtle.verify(ECDSA_SIGN, key, fromB64url(sig), utf8.encode(`${context}\n${canonical(value)}`));
  } catch {
    return false;
  }
}

/** Empreinte courte d'une clé publique (pour comparer et épingler). */
export const jwkId = (jwk: JsonWebKey | undefined) => (jwk && typeof jwk.x === 'string' && typeof jwk.y === 'string' ? `${jwk.x}.${jwk.y}` : '');

/* ---------------------------------------------------------------- Masterkey (clé d'administration) */

/**
 * La masterkey d'un administrateur : 20 octets aléatoires (160 bits), affichés en 8 groupes de 4 caractères
 * (alphabet sans caractères ambigus). Elle chiffre la clé privée d'administration du cercle : impossible à
 * deviner, elle permet de la récupérer sur un nouvel appareil.
 */
const MK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newMasterkey(): string {
  const bytes = randomBytes(20);
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += MK_ALPHABET[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join('-');
}
/** Forme normalisée (majuscules, sans tirets ni espaces) ; null si ce n'est pas une masterkey. */
export function normalizeMasterkey(text: string): string | null {
  const s = text.toUpperCase().replace(/[\s-]/g, '');
  return /^[A-HJ-NP-Z2-9]{32}$/.test(s) ? s : null;
}

async function masterkeyAes(masterkey: string, scope: string) {
  const norm = normalizeMasterkey(masterkey);
  if (!norm) throw new Error('Masterkey invalide');
  return aesKeyFrom(utf8.encode(norm), `masterkey:${scope}`);
}

/** Chiffre la clé privée d'administration (exportée une seule fois, à sa création) avec la masterkey ; `scope` = le membre. */
export async function wrapAdminKey(privateKey: CryptoKey, masterkey: string, scope: string): Promise<string> {
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', privateKey));
  return seal(await masterkeyAes(masterkey, scope), pkcs8, `admin-key:${scope}`);
}

/** Récupère la clé d'administration avec la masterkey (clé importée non exportable) ; null si elle ne correspond pas. */
export async function unwrapAdminKey(wrapped: string, masterkey: string, scope: string): Promise<CryptoKey | null> {
  try {
    const pkcs8 = await open(await masterkeyAes(masterkey, scope), wrapped, `admin-key:${scope}`);
    return await subtle.importKey('pkcs8', pkcs8, ECDSA, false, ['sign']);
  } catch {
    return null;
  }
}
