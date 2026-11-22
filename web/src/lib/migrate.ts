/**
 * Passage de l'ancien format (une famille = un espace, données en clair dans l'espace) au nouveau (cercles
 * signés). Décidé avec le propriétaire : changement IMPOSÉ. Les applis pas encore à jour restent sur l'ancien
 * espace, fermé : elles ne communiquent plus jusqu'à leur mise à jour.
 *
 *  1. L'admin (le créateur de la famille, ou à défaut le plus ancien membre) lance la mise à jour : un nouvel
 *     espace est créé, son secret est chiffré pour chaque ancien appareil (document `v2.move` laissé dans
 *     l'ancien espace), et le cercle « Famille » est créé avec le nom actuel de la famille et tous ses membres.
 *  2. Chaque appareil mis à jour suit (à son ouverture), publie ses clés ; l'appareil de l'admin le fait entrer
 *     dans « Famille » (en le reconnaissant à sa clé de l'ancien format).
 *  3. Chaque membre republie SES données (il en reste l'auteur) ; l'admin republie celles des personnes qui
 *     n'ont plus d'appareil. Les identifiants et dates de création sont gardés.
 */
import * as idb from './idb';
import { jwkId } from './crypto';
import { RULES } from './circles';
import type { Replica, DocRecord } from './replica';
import type { Engine, Member, StoredCircle } from './engine';
import { openBytes } from './crypto';
import { relayFetch } from './sync';

type OldDevice = { memberId: string; label?: string; pub?: JsonWebKey; revoked?: boolean };
type OldInfo = { devices: { id: string; member: string; pub: JsonWebKey; label?: string }[]; members: string[]; famName: string };

/** Collections de l'ancien format à reprendre (toutes celles du tableau des droits, sauf les nouvelles). */
export const OLD_COLLECTIONS = Object.keys(RULES).filter((c) => c !== 'deviceInfo' && c !== 'members');

const live = (r: Replica, c: string) => r.allRecords((x) => x.c === c && !x.del);
const fields = (rec: DocRecord) => Object.fromEntries(Object.entries(rec.f).map(([k, fc]) => [k, fc.v]));

/** Admin de la migration : créateur de la famille, sinon le plus ancien membre. */
export function migrationAdmin(r: Replica): string | null {
  const settings = r.allRecords((x) => x.c === 'settings' && x.id === 'family')[0];
  if (settings?.cb) return settings.cb;
  const members = live(r, 'members').sort((a, b) => (a.ct < b.ct ? -1 : 1));
  return members[0]?.id ?? null;
}

/** La famille est-elle encore à l'ancien format (des données à reprendre) ? */
export const hasOldData = (r: Replica) => r.allRecords((x) => x.c === 'members' && !x.del).length > 0;

export function oldInfo(r: Replica): OldInfo {
  const devices = live(r, 'devices')
    .map((rec) => ({ id: rec.id, ...(fields(rec) as OldDevice) }))
    .filter((d) => !d.revoked && !!d.pub && typeof d.memberId === 'string')
    .map((d) => ({ id: d.id, member: d.memberId, pub: d.pub!, label: d.label }));
  const members = live(r, 'members').map((m) => m.id);
  const famName = String(r.allRecords((x) => x.c === 'settings' && x.id === 'family')[0]?.f.name?.v ?? 'Famille') || 'Famille';
  return { devices, members, famName };
}

/**
 * Éléments à republier par CE membre : ceux dont il est l'auteur ; pour l'admin, aussi ceux des personnes
 * sans appareil (enfants, anciens membres) et ceux sans auteur. Les réveils : seulement ceux de cet appareil.
 */
export function itemsToMigrate(r: Replica, me: string, isAdmin: boolean, oldDeviceId: string | null) {
  const info = oldInfo(r);
  const withDevice = new Set(info.devices.map((d) => d.member));
  const mine = (rec: DocRecord) => rec.cb === me || (isAdmin && (!rec.cb || !withDevice.has(rec.cb)));
  const out: { c: string; id: string; data: Record<string, unknown>; t0: string; personal?: boolean }[] = [];
  for (const c of OLD_COLLECTIONS) {
    for (const rec of live(r, c)) {
      const data = fields(rec);
      if (c === 'alarms') {
        if (data.deviceId !== oldDeviceId) continue;
      } else if (c === 'prefs') {
        if (rec.id !== me) continue;
      } else if (c === 'settings') {
        if (!isAdmin) continue;
        delete data.name; // le nom de la famille devient celui du cercle
      } else if (!mine(rec)) continue;
      out.push({ c, id: rec.id, data, t0: rec.cbt ?? rec.ct, personal: c === 'alarms' });
    }
  }
  // Profils d'enfants (et de membres sans appareil) : repris par l'admin.
  if (isAdmin)
    for (const rec of live(r, 'members'))
      if (rec.id !== me && !withDevice.has(rec.id)) out.push({ c: 'members', id: rec.id, data: fields(rec), t0: rec.cbt ?? rec.ct });
  return out;
}

/* ------------------------------------------------------------------ Étapes */

/** Admin : lance la migration (nouvel espace, cercle « Famille »). */
export async function startMigration(engine: Engine) {
  const r = engine.replica;
  const me = engine.memberId;
  if (!me || !engine.circle) throw new Error('Profil inconnu');
  const info = oldInfo(r);
  await idb.put('kv', 'migration', { info, admin: true, old: engine.circle, done: false });
  await engine.adminKeys.get();
  // Clés de cet appareil publiées dans l'ancien espace : les autres vérifient ainsi la signature du déménagement.
  await engine.vault.publishDevice();
  await engine.sync?.flush();
  await engine.moveSpace(
    info.devices.map((d) => ({ id: d.id, pub: d.pub })),
    {
      migration: true,
      beforeSwitch: async () => {
        const fam = await engine.vault.createCircle({ name: info.famName, color: '#8E5CE6' }, undefined, info.members);
        await idb.put('kv', 'migration', { info, admin: true, old: (await idb.get<{ old: StoredCircle }>('kv', 'migration'))!.old, fam, done: false });
      },
    },
  );
  await continueMigration(engine);
}

/** Appareil qui suit : garde la trace de l'ancien espace (pour les photos) avant de changer. */
export async function rememberOldSpace(engine: Engine) {
  if (!engine.circle || (await idb.get('kv', 'migration'))) return;
  await idb.put('kv', 'migration', { info: oldInfo(engine.replica), admin: false, old: engine.circle, done: false });
}

let running = false;
let again = false;
/**
 * À chaque changement, une fois dans le nouvel espace : l'admin fait entrer les anciens appareils qui se
 * présentent ; chacun republie ses données dès qu'il peut écrire dans « Famille ».
 */
export async function continueMigration(engine: Engine) {
  const m = await idb.get<{ info: OldInfo; admin: boolean; old: StoredCircle; fam?: string; done: boolean }>('kv', 'migration');
  if (!m || !engine.migrated) return;
  if (running) {
    // Un appareil s'est peut-être présenté pendant ce tour : on refera un tour à la fin.
    again = true;
    return;
  }
  running = true;
  again = false;
  try {
    const v = engine.vault;
    const famId = m.fam ?? v.circles().find((c) => c.isAdmin && !c.personal)?.id;
    if (m.admin && famId) {
      const fam = v.circle(famId);
      if (fam?.isAdmin) {
        const holders = v.holders(famId);
        for (const [id, keys] of v.allDevices()) {
          if (holders.has(id) || id === engine.deviceId) continue;
          const old = m.info.devices.find((d) => jwkId(d.pub) === jwkId(keys.pub));
          if (old) await v.admit(famId, old.member, id).catch((err) => console.warn('Migration : entrée', err));
        }
      }
    }
    if (m.done || !engine.memberId) return;
    const fam = v.circles().find((c) => !c.personal && c.writable);
    if (!fam) return;
    // Profil (nom, couleur) et appareil, puis les données dont on est l'auteur.
    const oldMe = engine.replica.allRecords((x) => x.c === 'members' && x.id === engine.memberId)[0];
    if (oldMe && !v.get('members', engine.memberId)) await engine.saveProfile(fields(oldMe) as Partial<Member>);
    const myDev = m.info.devices.find((d) => d.id === engine.oldDeviceId);
    if (!v.get('deviceInfo', engine.deviceId)) await engine.registerDevice(myDev?.label);
    const personal = v.circles().find((c) => c.personal === engine.memberId && c.writable);
    for (const it of itemsToMigrate(engine.replica, engine.memberId, m.admin, engine.oldDeviceId)) {
      if (v.get(it.c, it.id)) continue;
      const data = { ...it.data };
      if (it.c === 'alarms') data.deviceId = engine.deviceId;
      if (it.c === 'photos' && typeof data.blobId === 'string') data.blobId = await movePhoto(engine, m.old, data.blobId);
      await v.create(it.c, data, { id: it.id, t0: it.t0, groups: it.personal && personal ? [personal.id] : [fam.id] }).catch((err) => console.warn('Migration', it.c, err));
    }
    await idb.put('kv', 'migration', { ...((await idb.get<typeof m>('kv', 'migration')) ?? m), done: true });
  } finally {
    running = false;
    if (again) setTimeout(() => continueMigration(engine).catch((err) => console.warn('Migration', err)), 0);
  }
}

/** Photo de l'ancien format (chiffrée avec la clé de l'ancien espace) : recopiée avec sa propre clé. */
async function movePhoto(engine: Engine, old: StoredCircle, blobId: string): Promise<string> {
  let local = await idb.get<{ mime: string; bytes: Uint8Array }>('blobs', blobId);
  if (!local) {
    try {
      const res = await relayFetch(old, `/blobs/${blobId}`);
      const bytes = await openBytes(old.key, new Uint8Array(await res.arrayBuffer()), `${old.circleId}:blob:${blobId}`);
      local = { mime: 'image/jpeg', bytes };
    } catch {
      return blobId;
    }
  }
  return engine.putBlob(local.bytes, local.mime);
}
