/**
 * Orchestrateur : identité de l'appareil, cercle familial, réplique locale, synchronisation.
 */
import * as idb from './idb';
import { b64url, fromB64url, fromUtf8, randomId, utf8 } from './bytes';
import {
  deriveCircleKeys,
  newDeviceKeys,
  newSecret,
  openFromDevice,
  passphraseOpen,
  passphraseSeal,
  safetyCode,
  sealToDevice,
  type CircleKeys,
} from './crypto';
import { Replica, type DocRecord } from './replica';
import { RELAY_URL, registerCircle, relayFetch, SyncClient } from './sync';

export type Identity = { deviceId: string; privateKey: CryptoKey; publicJwk: JsonWebKey };
/** Ce qui est stocké localement pour le cercle (lu aussi par le service worker). */
export type StoredCircle = CircleKeys & { secret: Uint8Array };

export type Member = { name: string; color: string; kind?: 'child' | 'adult' };
export type Device = { memberId: string; label: string; pub: JsonWebKey; push?: boolean; revoked?: boolean };
export type FamilySettings = { name: string; accent?: string; homeModules?: string[] };
type Rotation = { from: string; envelopes: Record<string, string>; by: string };

export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Appareil';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navigateur';
  return `${os} · ${br}`;
}

type EngineListener = () => void;

export class Engine {
  replica: Replica;
  sync: SyncClient | null = null;
  circle: StoredCircle | null = null;
  memberId: string | null = null;
  /** Cet appareil a été retiré du cercle (clé renouvelée sans lui). */
  removed = false;
  private listeners = new Set<EngineListener>();

  private constructor(readonly identity: Identity) {
    this.replica = new Replica(identity.deviceId);
    this.replica.onLocalOps = () => this.sync?.flush();
    this.replica.onChange((cols) => {
      if (cols.has('_rotation')) this.checkRotation();
    });
  }

  static async boot(): Promise<Engine> {
    let identity = await idb.get<Identity>('kv', 'identity');
    if (!identity) {
      identity = { deviceId: randomId(), ...(await newDeviceKeys()) };
      await idb.put('kv', 'identity', identity);
    }
    const e = new Engine(identity);
    await e.replica.load();
    e.circle = (await idb.get<StoredCircle>('kv', 'circle')) ?? null;
    e.memberId = (await idb.get<string>('kv', 'memberId')) ?? null;
    e.removed = (await idb.get<boolean>('kv', 'removed')) ?? false;
    e.replica.memberId = e.memberId;
    // Demande au navigateur de ne pas effacer les données locales en cas de manque d'espace.
    navigator.storage?.persist?.().catch(() => {});
    if (e.circle) await e.startSync();
    return e;
  }

  subscribe(l: EngineListener) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
  private emit() {
    this.listeners.forEach((l) => l());
  }

  get deviceId() {
    return this.identity.deviceId;
  }

  private async startSync() {
    this.sync?.stop();
    this.sync = new SyncClient(this.circle!, this.replica);
    this.sync.onStatus(() => this.emit());
    await this.sync.start();
    this.sync.whenReady().then(() => {
      this.checkRotation();
      this.flushPendingBlobs();
    });
  }

  private async setCircle(secret: Uint8Array<ArrayBuffer>) {
    const keys = await deriveCircleKeys(secret);
    this.circle = { ...keys, secret };
    await idb.put('kv', 'circle', this.circle);
  }

  async setMember(memberId: string) {
    this.memberId = memberId;
    this.replica.memberId = memberId;
    await idb.put('kv', 'memberId', memberId);
    this.emit();
  }

  /* ------------------------------------------------------------ création / arrivée */

  async createCircle(familyName: string, memberName: string, color: string) {
    await this.setCircle(newSecret());
    const memberId = randomId();
    await this.setMember(memberId);
    await this.replica.upsert<Member>('members', memberId, { name: memberName, color });
    await this.replica.upsert<FamilySettings>('settings', 'family', { name: familyName });
    await this.registerDevice();
    if (RELAY_URL) await registerCircle(this.circle!).catch(() => {});
    await this.startSync();
    this.emit();
  }

  /** Appelé quand une invitation a été approuvée : on reçoit le secret du cercle. */
  async joinCircle(secret: Uint8Array<ArrayBuffer>) {
    await this.setCircle(secret);
    await this.startSync();
    await this.sync!.whenReady();
    this.emit();
  }

  async registerDevice() {
    await this.replica.upsert<Device>('devices', this.deviceId, {
      memberId: this.memberId!,
      label: deviceLabel(),
      pub: this.identity.publicJwk,
    });
  }

  async circleSafetyCode(): Promise<string> {
    return this.circle ? safetyCode('circle', this.circle.secret) : '';
  }

  /* ------------------------------------------------------------ photos */

  async putBlob(bytes: Uint8Array, mime: string): Promise<string> {
    const id = randomId();
    await idb.put('blobs', id, { mime, bytes });
    const pending = (await idb.get<string[]>('kv', 'pendingBlobs')) ?? [];
    await idb.put('kv', 'pendingBlobs', [...pending, id]);
    this.flushPendingBlobs();
    return id;
  }

  async getBlob(id: string): Promise<Blob | null> {
    const local = await idb.get<{ mime: string; bytes: Uint8Array<ArrayBuffer> }>('blobs', id);
    if (local) return new Blob([local.bytes], { type: local.mime });
    if (!this.sync || !RELAY_URL) return null;
    try {
      const bytes = await this.sync.downloadBlob(id);
      const mime = sniffMime(bytes);
      await idb.put('blobs', id, { mime, bytes });
      return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime });
    } catch {
      return null;
    }
  }

  async deleteBlob(id: string) {
    await idb.del('blobs', id);
    if (this.quotaFull) {
      this.quotaFull = false;
      this.emit();
    }
    if (this.circle && RELAY_URL) await relayFetch(this.circle, `/blobs/${id}`, { method: 'DELETE' }).catch(() => {});
  }

  /** Le relais a refusé une photo faute de place. */
  quotaFull = false;
  private blobFlushing = false;
  async flushPendingBlobs() {
    if (this.blobFlushing || !this.sync || !RELAY_URL) return;
    this.blobFlushing = true;
    try {
      let pending = (await idb.get<string[]>('kv', 'pendingBlobs')) ?? [];
      for (const id of [...pending]) {
        const local = await idb.get<{ bytes: Uint8Array }>('blobs', id);
        if (local) await this.sync.uploadBlob(id, local.bytes);
        pending = pending.filter((p) => p !== id);
        await idb.put('kv', 'pendingBlobs', pending);
      }
    } catch (err) {
      // 507 = espace de la famille plein sur le relais ; sinon hors ligne : réessai plus tard.
      if (String(err).includes('507') && !this.quotaFull) {
        this.quotaFull = true;
        this.emit();
      }
    } finally {
      this.blobFlushing = false;
    }
  }

  /* ------------------------------------------------------------ renouvellement de clé */

  /**
   * Retire des appareils (téléphone perdu, membre parti) :
   * un nouveau secret est créé et transmis UNIQUEMENT aux appareils restants,
   * chiffré pour chacun avec sa clé publique. Les appareils retirés gardent ce qu'ils
   * avaient déjà, mais ne reçoivent plus rien.
   */
  async rotateKey(revokedDeviceIds: string[]) {
    if (!this.circle || !this.sync) throw new Error('Aucun cercle');
    if (!RELAY_URL) throw new Error('Le renouvellement de clé nécessite le relais');
    await this.sync.whenReady();
    const oldCircle = this.circle;
    const oldSync = this.sync;
    const secret = newSecret();

    // 1. Les photos doivent être disponibles localement pour être recopiées.
    const photoIds = this.replica
      .list<{ blobId?: string }>('photos')
      .map((p) => p.blobId)
      .filter((x): x is string => !!x);
    for (const id of photoIds) await this.getBlob(id);

    // 2. Marquer les appareils retirés (cette modification part aussi dans le nouveau cercle).
    for (const id of revokedDeviceIds) await this.replica.update<Device>('devices', id, { revoked: true, push: false });

    // 3. Enveloppes : le nouveau secret chiffré pour chaque appareil restant.
    const envelopes: Record<string, string> = {};
    for (const d of this.replica.list<Device>('devices')) {
      if (d.revoked || d.id === this.deviceId || revokedDeviceIds.includes(d.id) || !d.pub) continue;
      envelopes[d.id] = await sealToDevice(d.pub, secret, `rotation:${oldCircle.circleId}`);
    }
    await this.replica.create<Rotation>('_rotation', { from: oldCircle.circleId, envelopes, by: this.deviceId });
    await oldSync.flush();

    // 4. Bascule vers le nouveau cercle et envoi de l'état complet.
    await this.setCircle(secret);
    await registerCircle(this.circle!);
    await this.startSync();
    await this.sync!.pushRecords(this.replica.allRecords((r) => r.c !== '_rotation'));
    for (const id of photoIds) {
      const local = await idb.get<{ bytes: Uint8Array }>('blobs', id);
      if (local) await this.sync!.uploadBlob(id, local.bytes);
    }
    // 5. L'ancien cercle passe en lecture seule (effacé par le relais après 30 jours).
    await relayFetch(oldCircle, '/close', { method: 'POST' }).catch(() => {});
    this.emit();
  }

  private rotating = false;
  private async checkRotation() {
    if (!this.circle || this.rotating) return;
    const current = this.circle.circleId;
    const rot = this.replica.list<Rotation>('_rotation').find((r) => r.from === current && r.by !== this.deviceId);
    if (!rot) return;
    this.rotating = true;
    try {
      const env = rot.envelopes?.[this.deviceId];
      if (!env) {
        // Nous ne faisons pas partie des appareils conservés.
        this.removed = true;
        await idb.put('kv', 'removed', true);
        this.sync?.stop();
        this.emit();
        return;
      }
      const secret = await openFromDevice(this.identity.privateKey, env, `rotation:${current}`);
      await this.sync?.flush();
      await this.setCircle(secret);
      await this.startSync();
      this.emit();
    } catch (err) {
      console.warn('Renouvellement de clé impossible', err);
    } finally {
      this.rotating = false;
    }
  }

  /* ------------------------------------------------------------ sauvegardes */

  async exportBackup(passphrase: string, withPhotos: boolean): Promise<Blob> {
    const records = this.replica.allRecords((r) => r.c !== '_rotation' && r.c !== 'devices');
    const blobs: Record<string, { mime: string; data: string }> = {};
    if (withPhotos) {
      for (const p of this.replica.list<{ blobId?: string }>('photos')) {
        const b = p.blobId && (await this.getBlob(p.blobId));
        if (b) blobs[p.blobId!] = { mime: b.type, data: b64url(new Uint8Array(await b.arrayBuffer())) };
      }
    }
    const text = await passphraseSeal(passphrase, utf8.encode(JSON.stringify({ v: 1, at: new Date().toISOString(), records, blobs })));
    return new Blob([text], { type: 'application/json' });
  }

  async importBackup(passphrase: string, file: File) {
    let data: { records: DocRecord[]; blobs?: Record<string, { mime: string; data: string }> };
    try {
      data = JSON.parse(fromUtf8.decode(await passphraseOpen(passphrase, await file.text())));
    } catch {
      throw new Error('Phrase secrète incorrecte ou fichier invalide');
    }
    for (const [id, b] of Object.entries(data.blobs ?? {})) {
      await idb.put('blobs', id, { mime: b.mime, bytes: fromB64url(b.data) });
      const pending = (await idb.get<string[]>('kv', 'pendingBlobs')) ?? [];
      await idb.put('kv', 'pendingBlobs', [...pending, id]);
    }
    await this.replica.mergeRecords(data.records, true);
    if (this.sync && RELAY_URL) {
      this.sync.pushRecords(data.records).catch(() => {});
      this.flushPendingBlobs();
    }
  }

  /* ------------------------------------------------------------ effacement */

  /** Supprime tout ce que le relais détient pour ce cercle (les données restent sur les appareils). */
  async wipeRelay() {
    if (this.circle && RELAY_URL) await relayFetch(this.circle, '', { method: 'DELETE' });
  }

  /** Efface toutes les données de CET appareil. */
  async wipeDevice() {
    this.sync?.stop();
    await idb.clear('kv', 'docs', 'outbox', 'blobs');
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    for (const r of regs) await (await r.pushManager?.getSubscription())?.unsubscribe();
  }
}

function sniffMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}
