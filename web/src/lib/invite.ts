/**
 * Ajout d'un appareil au cercle, en 3 temps :
 *  1. Un membre crée une invitation (QR code ou lien) : un secret d'invitation à usage unique,
 *     valable 15 minutes. Il ne contient PAS la clé du cercle.
 *  2. Le nouvel appareil envoie une demande chiffrée contenant sa clé publique.
 *     Les deux écrans affichent un code de 5 émojis : on vérifie qu'ils sont identiques.
 *  3. Le membre approuve : le secret de l'espace est chiffré pour la clé publique du nouvel appareil
 *     (seul cet appareil peut la lire, même si le lien d'invitation a fuité), et les clés des cercles lui
 *     sont remises : par l'admin pour une nouvelle personne, par le membre lui-même pour son propre appareil.
 */
import { b64url, fromB64url, randomBytes, randomId } from './bytes';
import { deriveInviteKeys, openFromDevice, openJSON, safetyCode, sealJSON, sealToDevice, type InviteKeys } from './crypto';
import { deviceLabel, type Engine } from './engine';
import { RELAY_URL } from './sync';

/** `device` = empreinte des deux clés publiques (vérifiée par celui qui approuve). */
export type JoinRequest = { label: string; pub: JsonWebKey; spub?: JsonWebKey; device?: string };
/** Réponse : secret de l'espace (chiffré pour l'appareil) et identité de membre à utiliser. */
type JoinResponse = { s: string; member?: string };
type Bytes = Uint8Array<ArrayBuffer>;

const box = (keys: InviteKeys, name: string) => `${RELAY_URL}/i/${keys.inviteId}/${name}`;
const pubId = (pub: JsonWebKey) => `${pub.x}.${pub.y}`;

async function getBox<T>(keys: InviteKeys, name: 'request' | 'response'): Promise<T | null> {
  const res = await fetch(box(keys, name));
  if (res.status === 204) return null;
  if (res.status === 410) throw new Error('Invitation expirée ou déjà utilisée');
  if (!res.ok) throw new Error(`Relais : ${res.status}`);
  const { data } = (await res.json()) as { data: string };
  return openJSON<T>(keys.key, data, `invite:${keys.inviteId}:${name}`);
}

async function postBox(keys: InviteKeys, name: 'request' | 'response', value: unknown) {
  const data = await sealJSON(keys.key, value, `invite:${keys.inviteId}:${name}`);
  const res = await fetch(box(keys, name), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  });
  if (!res.ok) throw new Error(res.status === 409 ? 'Invitation déjà utilisée' : `Relais : ${res.status}`);
}

/* ------------------------------------------------------------ côté membre qui invite */

export type Invitation = { secret: Bytes; keys: InviteKeys; link: string; expiresAt: number };

export async function createInvitation(): Promise<Invitation> {
  const secret = randomBytes(32);
  const base = `${location.origin}${location.pathname}`;
  return { secret, keys: await deriveInviteKeys(secret), link: `${base}#/join/${b64url(secret)}`, expiresAt: Date.now() + 15 * 60_000 };
}

export const pollJoinRequest = (inv: Invitation) => getBox<JoinRequest>(inv.keys, 'request');

export const requestSafetyCode = (secret: Bytes, pub: JsonWebKey) => safetyCode('invite', secret, pubId(pub));

/**
 * Approuve une demande. `who` : 'me' (un autre de mes appareils), ou les cercles où faire entrer une nouvelle
 * personne (admin), ou un membre existant et ses cercles (admin : nouvel appareil de cette personne).
 */
export async function approveJoin(engine: Engine, inv: Invitation, req: JoinRequest, who: 'me' | { member?: string; circles: string[] }) {
  if (!engine.circle || !engine.memberId) throw new Error('Aucun cercle');
  if (!req.device || !req.spub || !(await engine.vault.pinDevice(req.device, { pub: req.pub, spub: req.spub })))
    throw new Error("Cet appareil utilise une ancienne version de l'appli : mettez-la à jour, puis recommencez");
  let member: string;
  if (who === 'me') {
    member = engine.memberId;
    await engine.vault.approveOwnDevice(req.device);
  } else {
    member = who.member ?? randomId();
    for (const c of who.circles) await engine.vault.admit(c, member, req.device);
  }
  const sealed = await sealToDevice(req.pub, engine.circle.secret, `invite:${inv.keys.inviteId}`);
  await postBox(inv.keys, 'response', { s: sealed, member } satisfies JoinResponse);
}

/* ------------------------------------------------------------ côté nouvel appareil */

export function parseInviteLink(text: string): Bytes | null {
  const m = text.match(/#\/join\/([A-Za-z0-9_-]{43})/) ?? text.trim().match(/^([A-Za-z0-9_-]{43})$/);
  return m ? fromB64url(m[1]) : null;
}

export async function sendJoinRequest(engine: Engine, secret: Bytes) {
  if (!RELAY_URL) throw new Error("Aucun relais configuré : impossible de rejoindre un cercle");
  const keys = await deriveInviteKeys(secret);
  const id = engine.identity;
  await postBox(keys, 'request', { label: deviceLabel(), pub: id.publicJwk, spub: id.signJwk, device: id.deviceId } satisfies JoinRequest);
  return { keys, code: await safetyCode('invite', secret, pubId(engine.identity.publicJwk)) };
}

/** Attend l'approbation ; renvoie le secret de l'espace et le membre, ou null si pas encore approuvé. */
export async function pollApproval(engine: Engine, keys: InviteKeys): Promise<{ secret: Bytes; member: string } | null> {
  const res = await getBox<JoinResponse>(keys, 'response');
  if (!res) return null;
  if (typeof res.member !== 'string') throw new Error("L'appareil qui vous invite utilise une ancienne version de l'appli : il doit la mettre à jour");
  const secret = await openFromDevice(engine.identity.privateKey, res.s, `invite:${keys.inviteId}`);
  await fetch(`${RELAY_URL}/i/${keys.inviteId}/done`, { method: 'POST' }).catch(() => {});
  return { secret, member: res.member };
}
