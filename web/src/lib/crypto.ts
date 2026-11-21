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
