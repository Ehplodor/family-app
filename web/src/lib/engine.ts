/**
 * Orchestrateur : identité de l'appareil, espace de synchronisation, coffre (cercles), réplique locale.
 *
 *  - L'ESPACE est le canal chiffré partagé sur le relais (un secret commun à tous les appareils de la
 *    famille) : il ne fait que transporter des paquets. On n'y écrit que des documents signés (`v2.*`).
 *  - Le COFFRE (vault.ts) range chaque donnée dans un ou plusieurs cercles, vérifie signatures et droits.
 */
import * as idb from './idb';
import { b64url, fromB64url, fromUtf8, randomId, utf8 } from './bytes';
import {
  deriveCircleKeys,
  importItemKey,
  newDeviceKeys,
  newItemKey,
  newSecret,
  newSigningKeys,
  openBytes,
  openFromDevice,
  passphraseOpen,
  passphraseSeal,
  safetyCode,
  sealBytes,
  sealToDevice,
  type CircleKeys,
} from './crypto';
import { Replica, type DocRecord } from './replica';
import { V2, col, deviceIdOf, isSigned, signDoc, type Signed } from './circles';
import { Vault, type Identity as VaultIdentity } from './vault';
import { LocalAdminKeyring } from './adminKey';
import { continueMigration, rememberOldSpace } from './migrate';
import { Data } from './data';
import { RELAY_URL, registerCircle, relayFetch, SyncClient } from './sync';

export type Identity = VaultIdentity;
/** Ce qui est stocké localement pour l'espace (lu aussi par le service worker). */
export type StoredCircle = CircleKeys & { secret: Uint8Array };

/** Profil d'un membre (élément du membre, visible par tous ses cercles). */
export type Member = { name: string; color: string; kind?: 'child' | 'adult'; admin?: { spub: JsonWebKey; wrapped: string } };
/** Informations d'un appareil (élément de son membre) : nom affiché, notifications activées. */
export type Device = { memberId: string; label: string; push?: boolean; revoked?: boolean };
export type FamilySettings = { name: string; accent?: string; homeModules?: string[] };
/** Déménagement vers un nouvel espace : nouveau secret chiffré pour chaque appareil gardé. */
export type Move = { from: string; env: Record<string, string>; migration?: 1 };

export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Appareil';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navigateur';
  return `${os} · ${br}`;
}

/** Les collections partagées du nouveau format (les seules transmises une fois la famille migrée). */
const isV2 = (c: string) => c.startsWith(V2);

type EngineListener = () => void;

export class Engine {
  replica: Replica;
  vault: Vault;
  data: Data;
  adminKeys: LocalAdminKeyring;
  sync: SyncClient | null = null;
  circle: StoredCircle | null = null;
  memberId: string | null = null;
  /** Cet appareil n'a pas été gardé lors d'un déménagement de l'espace. */
  removed = false;
  /** L'espace actuel est au nouveau format (cercles signés). Sinon : famille à migrer (voir migrate.ts). */
  migrated = false;
  /** Identifiant d'appareil dans l'ancien format (avant la migration). */
  oldDeviceId: string | null = null;
  private listeners = new Set<EngineListener>();

  private constructor(readonly identity: Identity) {
    this.replica = new Replica(identity.deviceId);
    this.adminKeys = new LocalAdminKeyring(() => this.memberId);
    this.vault = new Vault(this.replica, identity, () => this.memberId, vaultStore(), this.adminKeys);
    this.data = new Data(this);
    this.replica.onLocalOps = () => this.sync?.flush();
    this.replica.onChange((cols) => {
      if (cols.has(col('move'))) this.checkMove();
    });
    this.vault.subscribe(() => this.afterVaultChange());
  }

  static async boot(): Promise<Engine> {
    let identity = await idb.get<Identity & { signKey?: CryptoKey }>('kv', 'identity');
    let oldDeviceId = (await idb.get<string>('kv', 'oldDeviceId')) ?? null;
    if (!identity?.signKey) {
      // Nouvel appareil, ou appareil de l'ancien format : clés de signature, et identifiant = empreinte des clés.
      const dk = identity?.privateKey ? { privateKey: identity.privateKey, publicJwk: identity.publicJwk } : await newDeviceKeys();
      const sk = await newSigningKeys();
      if (identity?.deviceId) {
        oldDeviceId = identity.deviceId;
        await idb.put('kv', 'oldDeviceId', oldDeviceId);
      }
      identity = { ...dk, signKey: sk.signKey, signJwk: sk.signJwk, deviceId: await deviceIdOf(sk.signJwk, dk.publicJwk) };
      await idb.put('kv', 'identity', identity);
    }
    const e = new Engine(identity as Identity);
    e.oldDeviceId = oldDeviceId;
    await e.replica.load();
    e.circle = (await idb.get<StoredCircle>('kv', 'circle')) ?? null;
    e.memberId = (await idb.get<string>('kv', 'memberId')) ?? null;
    e.removed = (await idb.get<boolean>('kv', 'removed')) ?? false;
    e.migrated = !!e.circle && (await idb.get<string>('kv', 'espaceV2')) === e.circle.circleId;
    e.replica.memberId = e.memberId;
    await e.vault.refresh();
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
  emit() {
    this.listeners.forEach((l) => l());
  }

  get deviceId() {
    return this.identity.deviceId;
  }

  private async startSync() {
    this.sync?.stop();
    this.sync = new SyncClient(this.circle!, this.replica, this.migrated ? isV2 : () => true);
    this.sync.onStatus(() => this.emit());
    await this.sync.start();
    this.sync.whenReady().then(() => {
      this.checkMove();
      this.flushPendingBlobs();
      this.ensureSelf();
    });
  }

  private async setCircle(secret: Uint8Array<ArrayBuffer>, v2: boolean) {
    const keys = await deriveCircleKeys(secret);
    this.circle = { ...keys, secret };
    await idb.put('kv', 'circle', this.circle);
    if (v2) await idb.put('kv', 'espaceV2', keys.circleId);
    this.migrated = v2;
  }

  async setMember(memberId: string) {
    this.memberId = memberId;
    this.replica.memberId = memberId;
    await idb.put('kv', 'memberId', memberId);
    await this.vault.refresh();
    this.emit();
  }

  /* ------------------------------------------------------------ création / arrivée */

  /** Nouvelle famille : un espace, le cercle « Famille » (dont on est l'admin) et le cercle « Moi seul ». */
  async createCircle(familyName: string, memberName: string, color: string) {
    const secret = newSecret();
    if (RELAY_URL) {
      // D'abord le relais : si la limite de nouvelles familles est atteinte, on n'a encore rien créé.
      // Une simple coupure réseau n'empêche pas de commencer (enregistrement au prochain essai).
      await registerCircle(await deriveCircleKeys(secret)).catch((err: Error) => {
        if (/limité|Trop de nouvelles/.test(err.message)) throw err;
      });
    }
    await this.setCircle(secret, true);
    await this.setMember(randomId());
    await this.vault.publishDevice();
    const fam = await this.vault.createCircle({ name: familyName, color: '#8E5CE6' });
    await this.ensurePersonal();
    await this.saveProfile({ name: memberName, color }, [fam]);
    await this.registerDevice();
    await this.startSync();
    this.emit();
  }

  /** Appelé quand une invitation a été approuvée : on reçoit le secret de l'espace et notre identité de membre. */
  async joinCircle(secret: Uint8Array<ArrayBuffer>, member: string) {
    await this.setCircle(secret, true);
    await this.setMember(member);
    await this.vault.publishDevice();
    await this.startSync();
    await this.sync!.whenReady();
    await this.vault.refresh();
    this.emit();
  }

  /** Profil de ce membre, visible par tous ses cercles (et sa clé d'administration publique). */
  async saveProfile(patch: Partial<Member>, groups?: string[]) {
    if (!this.memberId) return;
    const admin = await this.adminKeys.get();
    const mine = groups ?? this.memberCircles();
    const cur = this.vault.get<Member>('members', this.memberId);
    const full = { ...(cur ?? {}), ...patch, ...(admin ? { admin: { spub: admin.spub, wrapped: admin.wrapped } } : {}) } as Member;
    if (cur && cur.owner === this.memberId) await this.vault.update('members', this.memberId, full, mine);
    else if (!cur) await this.vault.create('members', full, { id: this.memberId, groups: mine });
  }

  /** Cercles où ce membre peut écrire. */
  memberCircles(): string[] {
    return this.vault
      .circles()
      .filter((c) => c.writable && !!this.memberId && c.members.includes(this.memberId))
      .map((c) => c.id);
  }

  async registerDevice(label = deviceLabel()) {
    if (!this.memberId) return;
    const groups = this.memberCircles();
    if (!groups.length) return;
    const cur = this.vault.get<Device>('deviceInfo', this.deviceId);
    if (!cur) await this.vault.create<Device>('deviceInfo', { memberId: this.memberId, label }, { id: this.deviceId, groups });
  }

  /** Cercle personnel (« Moi seul ») : créé au besoin, une fois les données reçues. */
  private async ensurePersonal() {
    const me = this.memberId;
    if (!me || this.vault.circles().some((c) => c.personal === me)) return;
    await this.vault.createCircle({ name: 'Moi seul', color: '#8E8E93', personal: me });
  }

  private selfBusy = false;
  /** Après chaque changement : profil et appareil visibles par tous les cercles du membre. */
  private async ensureSelf() {
    if (this.selfBusy || this.removed || !this.memberId || !this.migrated || !this.vault.ready) return;
    if (RELAY_URL && this.sync?.status !== 'online') return;
    this.selfBusy = true;
    try {
      await this.vault.publishDevice();
      await this.vault.refresh();
      // « Moi seul » : seulement une fois les accès reçus (un autre appareil du membre l'a peut-être déjà créé).
      if (this.memberCircles().length) await this.ensurePersonal();
      const mine = this.memberCircles();
      const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
      const profile = this.vault.get<Member>('members', this.memberId);
      if (profile && profile.owner === this.memberId && !sameSet(profile.groups, mine)) await this.saveProfile({}, mine);
      const dev = this.vault.get<Device>('deviceInfo', this.deviceId);
      if (!dev) await this.registerDevice();
      else if (!sameSet(dev.groups, mine)) await this.vault.update('deviceInfo', this.deviceId, {}, mine);
    } catch (err) {
      console.warn('Profil', err);
    } finally {
      this.selfBusy = false;
    }
  }

  private afterVaultChange() {
    if (!this.migrated) return;
    continueMigration(this)
      .catch((err) => console.warn('Migration', err))
      .finally(() => this.ensureSelf());
  }

  async circleSafetyCode(): Promise<string> {
    return this.circle ? safetyCode('circle', this.circle.secret) : '';
  }

  /* ------------------------------------------------------------ photos (chacune a sa propre clé) */

  /** Enregistre une photo ; l'identifiant renvoyé contient sa clé (rangé dans l'élément chiffré). */
  async putBlob(bytes: Uint8Array, mime: string): Promise<string> {
    const id = randomId();
    const k = await newItemKey();
    const ref = `${id}~${b64url(k.raw)}`;
    await idb.put('blobs', id, { mime, bytes });
    const pending = (await idb.get<string[]>('kv', 'pendingBlobs')) ?? [];
    await idb.put('kv', 'pendingBlobs', [...pending, ref]);
    this.flushPendingBlobs();
    return ref;
  }

  async getBlob(ref: string): Promise<Blob | null> {
    const [id, key] = ref.split('~');
    const local = await idb.get<{ mime: string; bytes: Uint8Array<ArrayBuffer> }>('blobs', id);
    if (local) return new Blob([local.bytes], { type: local.mime });
    if (!this.sync || !RELAY_URL || !key) return null;
    try {
      const res = await relayFetch(this.sync.keys, `/blobs/${id}`);
      const bytes = await openBytes(await importItemKey(fromB64url(key)), new Uint8Array(await res.arrayBuffer()), `blob:${id}`);
      const mime = sniffMime(bytes);
      await idb.put('blobs', id, { mime, bytes });
      return new Blob([bytes], { type: mime });
    } catch {
      return null;
    }
  }

  async deleteBlob(ref: string) {
    const [id] = ref.split('~');
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
    if (this.blobFlushing || !this.sync || !RELAY_URL || !this.migrated) return;
    this.blobFlushing = true;
    try {
      let pending = (await idb.get<string[]>('kv', 'pendingBlobs')) ?? [];
      for (const ref of [...pending]) {
        const [id, key] = ref.split('~');
        const local = await idb.get<{ bytes: Uint8Array }>('blobs', id);
        if (local && key) {
          const body = await sealBytes(await importItemKey(fromB64url(key)), local.bytes, `blob:${id}`);
          await relayFetch(this.sync.keys, `/blobs/${id}`, { method: 'PUT', body });
        }
        pending = pending.filter((p) => p !== ref);
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

  /* ------------------------------------------------------------ déménagement de l'espace */

  /**
   * Nouvel espace (appareil perdu : il ne recevra plus rien, même chiffré) : un nouveau secret est remis
   * UNIQUEMENT aux appareils gardés, chiffré pour chacun. `migration` : passage de l'ancien format au nouveau
   * (les enveloppes sont alors adressées aux identifiants de l'ancien format).
   */
  async moveSpace(keep: { id: string; pub: JsonWebKey }[], opts: { migration?: boolean; beforeSwitch?: () => Promise<void> } = {}) {
    if (!this.circle || !this.sync) throw new Error('Aucun espace');
    if (!RELAY_URL) throw new Error('Cette opération nécessite le relais');
    await this.sync.whenReady();
    const oldCircle = this.circle;
    const oldSync = this.sync;
    const secret = newSecret();
    const env: Record<string, string> = {};
    for (const d of keep) if (d.id !== this.deviceId && d.id !== this.oldDeviceId) env[d.id] = await sealToDevice(d.pub, secret, `move:${oldCircle.circleId}`);
    const p: Move = { from: oldCircle.circleId, env, ...(opts.migration ? { migration: 1 as const } : {}) };
    const s = await signDoc(this.identity.signKey, col('move'), oldCircle.circleId, this.deviceId, this.replica.clock.now(), p);
    await this.replica.upsert(col('move'), oldCircle.circleId, { s });
    await oldSync.flush();
    await this.setCircle(secret, true);
    await registerCircle(this.circle!, oldCircle);
    await opts.beforeSwitch?.();
    await this.startSync();
    await this.sync!.pushRecords(this.replica.allRecords((r) => isV2(r.c) && r.c !== col('move')));
    // L'ancien espace passe en lecture seule (effacé par le relais après 30 jours).
    await relayFetch(oldCircle, '/close', { method: 'POST' }).catch(() => {});
    this.emit();
  }

  /**
   * Nouvel espace pour couper l'accès au relais d'un appareil déclaré perdu (il ne recevra plus rien, même
   * chiffré) : tous les appareils connus et non perdus sont gardés.
   */
  async renewSpace() {
    const keep = this.vault
      .knownDevices()
      .filter((d) => !d.lost)
      .map((d) => ({ id: d.id, pub: this.vault.deviceKeys(d.id)?.pub }))
      .filter((d): d is { id: string; pub: JsonWebKey } => !!d.pub);
    await this.moveSpace(keep);
  }

  private moving = false;
  private async checkMove() {
    if (!this.circle || this.moving) return;
    const current = this.circle.circleId;
    const rec = this.replica.allRecords((r) => r.c === col('move') && r.id === current)[0];
    const s = rec?.f.s?.v as Signed<Move> | undefined;
    if (!s || !isSigned(s) || s.by === this.deviceId || s.p?.from !== current) return;
    // Déménagement ordinaire : décidé par un appareil d'un membre de nos cercles. Migration : tout appareil
    // de l'ancien format (même confiance qu'avant), une seule fois.
    if (!(await this.vault.checkSigned('move', current, s))) return;
    if (!s.p.migration && !this.vault.memberOf(s.by)) return;
    if (s.p.migration && this.migrated) return;
    this.moving = true;
    try {
      const env = s.p.env?.[this.deviceId] ?? (s.p.migration && this.oldDeviceId ? s.p.env?.[this.oldDeviceId] : undefined);
      if (!env) {
        this.removed = true;
        await idb.put('kv', 'removed', true);
        this.sync?.stop();
        this.emit();
        return;
      }
      const secret = await openFromDevice(this.identity.privateKey, env, `move:${current}`);
      if (s.p.migration) await rememberOldSpace(this);
      await this.sync?.flush();
      await this.setCircle(secret, true);
      await this.startSync();
      this.emit();
    } catch (err) {
      console.warn('Changement d’espace impossible', err);
    } finally {
      this.moving = false;
    }
  }

  /* ------------------------------------------------------------ sauvegardes */

  async exportBackup(passphrase: string, withPhotos: boolean): Promise<Blob> {
    const records = this.replica.allRecords((r) => isV2(r.c) && r.c !== col('move'));
    const blobs: Record<string, { mime: string; data: string }> = {};
    if (withPhotos) {
      for (const p of this.vault.list<{ blobId?: string }>('photos')) {
        const b = p.blobId && (await this.getBlob(p.blobId));
        if (b) blobs[p.blobId!] = { mime: b.type, data: b64url(new Uint8Array(await b.arrayBuffer())) };
      }
    }
    // Clés des cercles de cet appareil : sans elles, rien ne serait lisible sur un appareil restauré
    // (la sauvegarde reste protégée par la phrase secrète).
    const text = await passphraseSeal(
      passphrase,
      utf8.encode(JSON.stringify({ v: 2, at: new Date().toISOString(), records, blobs, secrets: this.vault.exportSecrets() })),
    );
    return new Blob([text], { type: 'application/json' });
  }

  async importBackup(passphrase: string, file: File) {
    let data: { v?: number; records: DocRecord[]; blobs?: Record<string, { mime: string; data: string }>; secrets?: Parameters<Vault['importSecrets']>[0] };
    try {
      data = JSON.parse(fromUtf8.decode(await passphraseOpen(passphrase, await file.text())));
    } catch {
      throw new Error('Phrase secrète incorrecte ou fichier invalide');
    }
    if (data.v !== 2) throw new Error("Sauvegarde de l'ancienne version : elle ne peut plus être restaurée");
    for (const [ref, b] of Object.entries(data.blobs ?? {})) {
      await idb.put('blobs', ref.split('~')[0], { mime: b.mime, bytes: fromB64url(b.data) });
      const pending = (await idb.get<string[]>('kv', 'pendingBlobs')) ?? [];
      await idb.put('kv', 'pendingBlobs', [...pending, ref]);
    }
    const records = (data.records ?? []).filter((r) => isV2(r?.c));
    await this.replica.mergeRecords(records, true);
    if (data.secrets) await this.vault.importSecrets(data.secrets);
    if (this.sync && RELAY_URL) {
      this.sync.pushRecords(records).catch(() => {});
      this.flushPendingBlobs();
    }
  }

  /* ------------------------------------------------------------ effacement */

  /** Supprime tout ce que le relais détient pour cet espace (les données restent sur les appareils). */
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

/** Stockage local du coffre, dans IndexedDB (préfixe `vault:`). */
function vaultStore() {
  const P = 'vault:';
  return {
    get: <T,>(k: string) => idb.get<T>('kv', P + k),
    put: (k: string, v: unknown) => idb.put('kv', P + k, v),
    del: (k: string) => idb.del('kv', P + k),
    entries: async <T,>(prefix: string) => {
      const range = IDBKeyRange.bound(P + prefix, P + prefix + '￿');
      const d = await idb.db();
      return new Promise<[string, T][]>((resolve, reject) => {
        const out: [string, T][] = [];
        const req = d.transaction('kv').objectStore('kv').openCursor(range);
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return resolve(out);
          out.push([String(c.key).slice(P.length), c.value as T]);
          c.continue();
        };
        req.onerror = () => reject(req.error);
      });
    },
  };
}

function sniffMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}
