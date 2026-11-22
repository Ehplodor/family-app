/**
 * Règles du mécanisme commun à tous les cercles (fonctions pures, testées dans circles.test.ts).
 *
 *  - Toute donnée partagée est un document SIGNÉ par l'appareil qui l'écrit (ECDSA, voir crypto.ts).
 *    Une donnée non signée, ou signée par un appareil inconnu, est ignorée.
 *  - Chaque cercle a une « liste des membres » (roster) signée par la clé de son administrateur. Seul
 *    l'administrateur invite, valide l'entrée d'un membre ou l'exclut. Le rôle se transmet (signé par l'ancienne
 *    clé) ou se reprend par la relève des membres (majorité + 7 jours sans opposition).
 *  - Chaque élément a un propriétaire : lui seul le supprime pour tout le monde ; les autres membres ne
 *    modifient que ce que la règle de la collection autorise (RULES).
 */
import { canonical, jwkId, sign, verify } from './crypto';

/* ------------------------------------------------------------------ Documents signés */

/** Préfixe des collections du nouveau format (les anciennes versions de l'appli ne les lisent pas). */
export const V2 = 'v2.';
export const col = (name: string) => `${V2}${name}`;

/** Document signé : `by` = appareil auteur, `at` = horloge (croissante), `p` = contenu. */
export type Signed<T> = { by: string; at: string; p: T; sig: string };

const DOC = 'family-app/doc';

export async function signDoc<T>(key: CryptoKey, collection: string, id: string, by: string, at: string, p: T): Promise<Signed<T>> {
  return { by, at, p, sig: await sign(key, DOC, { c: collection, i: id, by, at, p }) };
}

export function isSigned(s: unknown): s is Signed<unknown> {
  const x = s as Signed<unknown>;
  return !!x && typeof x === 'object' && typeof x.by === 'string' && typeof x.at === 'string' && typeof x.sig === 'string' && 'p' in x;
}

export async function checkDoc(spub: JsonWebKey | undefined, collection: string, id: string, s: unknown): Promise<boolean> {
  if (!isSigned(s)) return false;
  return verify(spub, DOC, { c: collection, i: id, by: s.by, at: s.at, p: s.p }, s.sig);
}

/* ------------------------------------------------------------------ Appareils (espace) */

/** `v2.devices/<id>` : clés publiques de l'appareil, signé par lui-même. Rien d'autre (espace anonyme). */
export type DeviceDoc = { pub: JsonWebKey; spub: JsonWebKey };

/**
 * Identifiant d'un appareil dans les cercles : empreinte de ses deux clés publiques. Personne ne peut donc
 * publier d'autres clés sous l'identifiant d'un appareil existant, et ses clés peuvent voyager avec chaque
 * autorisation (un nouveau venu les vérifie sans dépendre du document `v2.devices`).
 */
export async function deviceIdOf(spub: JsonWebKey, pub: JsonWebKey): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`family-app/device\n${jwkId(spub)}\n${jwkId(pub)}`)));
  return [...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Les clés `k` sont-elles bien celles de l'appareil `id` ? */
export async function deviceKeysOk(id: string, k: unknown): Promise<DeviceDoc | null> {
  const p = k as DeviceDoc;
  if (!jwkId(p?.pub) || !jwkId(p?.spub) || (await deviceIdOf(p.spub, p.pub)) !== id) return null;
  return { pub: p.pub, spub: p.spub };
}

export async function checkDeviceDoc(id: string, s: unknown): Promise<DeviceDoc | null> {
  if (!isSigned(s) || s.by !== id) return null;
  const p = await deviceKeysOk(id, s.p);
  return p && (await checkDoc(p.spub, col('devices'), id, s)) ? p : null;
}

/* ------------------------------------------------------------------ Liste des membres d'un cercle */

/**
 * Version `v` de la liste des membres d'un cercle, signée par la clé d'administration en vigueur :
 *  - `admin` : membre administrateur ; `spub` : sa clé publique d'administration ;
 *  - `wrapped` : sa clé privée d'administration chiffrée par sa masterkey (pour la récupérer ailleurs).
 * Une version qui change d'administrateur est signée par l'ANCIENNE clé (transmission) ou accompagnée
 * d'une relève valide.
 */
export type Roster = { circle: string; v: number; members: string[]; admin: string; spub: JsonWebKey; wrapped: string };
export type SignedRoster = { r: Roster; sig: string; relief?: Relief };

const ROSTER = 'family-app/roster';
export const signRoster = async (adminKey: CryptoKey, r: Roster): Promise<SignedRoster> => ({ r, sig: await sign(adminKey, ROSTER, r) });

export function rosterShapeOk(r: Roster | undefined, circle: string): r is Roster {
  return (
    !!r &&
    r.circle === circle &&
    Number.isInteger(r.v) &&
    r.v >= 1 &&
    Array.isArray(r.members) &&
    r.members.every((m) => typeof m === 'string') &&
    r.members.includes(r.admin) &&
    !!jwkId(r.spub) &&
    typeof r.wrapped === 'string'
  );
}

/**
 * Relève : l'administrateur a perdu sa masterkey et ses appareils. Un membre propose un nouvel
 * administrateur (`candidate`, avec sa nouvelle clé) ; la majorité des AUTRES membres (hors ancien admin)
 * signe ; au bout de 7 jours sans opposition de l'ancienne clé, la nouvelle liste est valable.
 */
export const RELIEF_DELAY = 7 * 86400_000;
export type ReliefProposal = { circle: string; from: number; candidate: string; spub: JsonWebKey; at: number };
/** Une voix : un appareil d'un membre signe la proposition (`member` = le membre qui vote). */
export type ReliefVote = { device: string; member: string; sig: string };
export type Relief = { proposal: ReliefProposal; votes: ReliefVote[] };
const RELIEF = 'family-app/relief';
const VETO = 'family-app/veto';

export const signReliefVote = (deviceKey: CryptoKey, member: string, proposal: ReliefProposal) =>
  sign(deviceKey, RELIEF, { member, proposal });
export const signVeto = (adminKey: CryptoKey, proposal: ReliefProposal) => sign(adminKey, VETO, proposal);
export const checkVeto = (spub: JsonWebKey, proposal: ReliefProposal, sig: unknown) => verify(spub, VETO, proposal, sig);

/** Ce dont la vérification d'une relève a besoin : qui est quel membre, et sa clé de signature. */
export type DeviceLookup = (device: string) => { member: string | null; spub: JsonWebKey } | null;

export async function checkRelief(prev: Roster, relief: Relief | undefined, devices: DeviceLookup, now: number, vetoed: boolean): Promise<boolean> {
  const p = relief?.proposal;
  if (!p || p.circle !== prev.circle || p.from !== prev.v || !prev.members.includes(p.candidate) || p.candidate === prev.admin) return false;
  if (!Number.isFinite(p.at) || now - p.at < RELIEF_DELAY || vetoed) return false;
  const voters = prev.members.filter((m) => m !== prev.admin);
  const yes = new Set<string>();
  for (const v of relief!.votes ?? []) {
    const d = devices(v.device);
    if (!d || d.member !== v.member || !voters.includes(v.member) || yes.has(v.member)) continue;
    if (await verify(d.spub, RELIEF, { member: v.member, proposal: p }, v.sig)) yes.add(v.member);
  }
  return yes.size * 2 > voters.length;
}

/**
 * Listes des membres valables successives, en partant de celle épinglée sur l'appareil (ou de la première
 * vue) : la dernière de la liste renvoyée est celle en vigueur. Chaque version suivante doit être signée par
 * la clé en vigueur (y compris pour une transmission), ou s'appuyer sur une relève valable que l'admin
 * remplacé n'a pas refusée (`vetoed`, appelé avec la liste remplacée).
 */
export async function latestRoster(
  circle: string,
  chain: SignedRoster[],
  pinned: Roster | null,
  devices: DeviceLookup,
  now: number,
  vetoed: (prev: Roster, p: ReliefProposal) => Promise<boolean>,
): Promise<Roster[] | null> {
  const list = (Array.isArray(chain) ? chain : []).filter((s) => rosterShapeOk(s?.r, circle)).sort((a, b) => a.r.v - b.r.v);
  let cur: Roster | null = pinned;
  if (!cur) {
    // Première vue : la version 1 doit être signée par sa propre clé (le créateur du cercle).
    const first = list.find((s) => s.r.v === 1);
    if (!first || !(await verify(first.r.spub, ROSTER, first.r, first.sig))) return null;
    cur = first.r;
  }
  const path: Roster[] = [cur];
  for (;;) {
    const next = list.filter((s) => s.r.v === cur!.v + 1);
    let accepted: Roster | null = null;
    for (const s of next) {
      if (await verify(cur.spub, ROSTER, s.r, s.sig)) accepted = s.r;
      else if (
        s.relief &&
        jwkId(s.relief.proposal?.spub) === jwkId(s.r.spub) &&
        s.r.admin === s.relief.proposal.candidate &&
        (await verify(s.r.spub, ROSTER, s.r, s.sig)) &&
        (await checkRelief(cur, s.relief, devices, now, await vetoed(cur, s.relief.proposal)))
      )
        accepted = s.r;
      if (accepted) break;
    }
    if (!accepted) return path;
    cur = accepted;
    path.push(cur);
  }
}

/* ------------------------------------------------------------------ Entrée d'un appareil dans un cercle */

/** Signature de l'administrateur qui valide l'entrée d'un appareil d'un membre (nouveau membre ou appareil). */
const ADMIT = 'family-app/admit';
export type Admission = { circle: string; key: string; device: string; member: string };
export const signAdmission = (adminKey: CryptoKey, a: Admission) => sign(adminKey, ADMIT, a);
export const checkAdmission = (spub: JsonWebKey, a: Admission, sig: unknown) => verify(spub, ADMIT, a, sig);

/* ------------------------------------------------------------------ Éléments : propriétaire et droits */

/**
 * Qui peut modifier un élément dont il n'est pas propriétaire (seul le propriétaire le supprime pour tous) :
 *  - 'all'   : tous les membres des cercles qui le voient ;
 *  - 'owner' : seulement le propriétaire ;
 *  - liste de champs : les autres membres ne peuvent changer que ces champs.
 * Décidé avec le propriétaire de l'appli (tableau « Qui peut modifier quoi »).
 */
export type Rule = 'all' | 'owner' | string[];
export const RULES: Record<string, Rule> = {
  events: 'all',
  calendars: 'owner',
  birthdays: 'all',
  lists: 'owner',
  listItems: 'all',
  messages: 'owner',
  photos: 'owner',
  contacts: 'all',
  meals: 'all',
  recipes: 'all',
  tasks: ['done', 'due', 'lastDoneBy', 'lastDoneAt'],
  alarms: 'owner',
  budget: 'owner',
  timetable: 'all',
  lessons: 'all',
  homework: 'all',
  cards: 'all',
  schoolProfiles: 'owner',
  members: 'owner',
  deviceInfo: 'owner',
  prefs: 'owner',
  settings: 'all',
};
export const ruleOf = (collection: string): Rule => RULES[collection] ?? 'owner';

/** Contenu chiffré d'un élément : cercles qui le voient, propriétaire (membre), date de création, champs. */
export type ItemPayload = { g: string[]; o: string; t0: string; d: Record<string, unknown>; x?: 1 };

export function payloadShapeOk(p: unknown): p is ItemPayload {
  const x = p as ItemPayload;
  return (
    !!x &&
    Array.isArray(x.g) &&
    x.g.length > 0 &&
    x.g.every((g) => typeof g === 'string') &&
    typeof x.o === 'string' &&
    typeof x.t0 === 'string' &&
    !!x.d &&
    typeof x.d === 'object' &&
    !Array.isArray(x.d)
  );
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Une nouvelle version (`next`, écrite par le membre `author`) est-elle permise, sachant la dernière version
 * valable (`prev`, null pour une création ou un appareil qui n'a jamais vu l'élément) ?
 */
export function canWrite(collection: string, prev: ItemPayload | null, next: ItemPayload, author: string): boolean {
  // Première vue : création, ou élément déjà modifié par d'autres avant l'arrivée de cet appareil.
  if (!prev) return next.o === author || (!next.x && ruleOf(collection) !== 'owner');
  if (next.o !== prev.o || next.t0 !== prev.t0) return false;
  if (author === prev.o) return true;
  // Pas propriétaire : ni suppression pour tous, ni changement de visibilité.
  if (next.x || !sameSet(next.g, prev.g)) return false;
  const rule = ruleOf(collection);
  if (rule === 'all') return true;
  if (rule === 'owner') return false;
  const keys = new Set([...Object.keys(prev.d), ...Object.keys(next.d)]);
  for (const k of keys) if (!rule.includes(k) && canonical(prev.d[k]) !== canonical(next.d[k])) return false;
  return true;
}
