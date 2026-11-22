/**
 * Cercles restreints : état de CET appareil (clés détenues, cercles lisibles, évènements privés déchiffrés)
 * et opérations (créer un cercle, autoriser un appareil, retirer un membre, enregistrer un évènement privé).
 * La cryptographie et les règles sont dans groups.ts (fonctions pures, testées).
 */
import { randomId } from './bytes';
import { deriveGroupKey, newSecret } from './crypto';
import type { Device, Member } from './engine';
import {
  holdersOf,
  isId,
  latestKey,
  openGroupMeta,
  openGroupSecret,
  openPrivate,
  pendingDevices,
  personalGroupId,
  sealGroupMeta,
  sealGroupSecret,
  sealPrivate,
  type GroupDoc,
  type GroupKeyDoc,
  type GroupMeta,
  type HeldKey,
  type PrivateDoc,
} from './groups';
import type { Doc, Replica } from './replica';

export const PRIVATE_EVENTS = 'privateEvents';
/** Messages d'une conversation réservée à un cercle (chiffrés comme les évènements privés). */
export const PRIVATE_MESSAGES = 'privateMessages';
const PRIVATE_COLLECTIONS = [PRIVATE_EVENTS, PRIVATE_MESSAGES];
const SOURCES = new Set(['groups', 'groupKeys', ...PRIVATE_COLLECTIONS, 'devices', 'members']);
const pkey = (collection: string, id: string) => `${collection}/${id}`;

/** Accès de cet appareil à un cercle. */
export type GroupAccess = 'ok' | 'outdated';
export type GroupInfo = GroupMeta & { id: string; access: GroupAccess; keyEpoch: number };
export type DeviceRow = Device & { id: string };
/** Évènement privé déchiffré : les champs de l'évènement + les cercles qui le voient. */
export type PrivatePayload = { groups: string[] } & Record<string, unknown>;

type Identity = { deviceId: string; privateKey: CryptoKey };

export class GroupManager {
  /** Clés détenues par cet appareil, par identifiant de clé. */
  held = new Map<string, HeldKey>();
  /** Cercles dont cet appareil peut lire la description. */
  groups = new Map<string, GroupInfo>();
  /** Évènements privés lisibles par cet appareil. */
  private events = new Map<string, { box: unknown; data: PrivatePayload }>();
  private opened = new Map<string, HeldKey | null>();
  private listeners = new Set<() => void>();
  private version = 0;
  private running: Promise<void> | null = null;
  private again = false;
  /** Cache des listes renvoyées à React (même référence tant que rien ne change). */
  private cache = new Map<string, unknown>();

  constructor(
    private replica: Replica,
    private identity: Identity,
    private memberId: () => string | null,
  ) {
    replica.onChange((cols) => {
      if ([...cols].some((c) => SOURCES.has(c))) this.refresh();
    });
  }

  /* ------------------------------------------------------------ abonnements (React) */

  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }
  getVersion = () => this.version;
  private emit() {
    this.version++;
    this.cache.clear();
    this.listeners.forEach((l) => l());
  }

  /** Recalcule l'état (sérialisé : un seul calcul à la fois, relancé si quelque chose a changé entre-temps). */
  refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.compute();
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private keyDocs(): Doc<GroupKeyDoc>[] {
    return this.replica.list<GroupKeyDoc>('groupKeys');
  }

  private async compute() {
    const me = this.identity.deviceId;
    // 1. Clés : on n'ouvre que les enveloppes adressées à cet appareil (une seule fois chacune).
    const held = new Map<string, HeldKey>();
    for (const d of this.keyDocs()) {
      if (d.device !== me) continue;
      if (!this.opened.has(d.id)) this.opened.set(d.id, await openGroupSecret(this.identity.privateKey, d, me));
      const k = this.opened.get(d.id);
      if (k && k.group === d.group) held.set(k.keyId, k);
    }
    // 2. Cercles lisibles.
    const keys = this.keyDocs();
    const groups = new Map<string, GroupInfo>();
    for (const g of this.replica.list<GroupDoc>('groups')) {
      if (!isId(g.id)) continue;
      const meta = await openGroupMeta(g, held, g.id);
      const latest = latestKey(keys, g.id);
      if (!meta || !latest) continue;
      groups.set(g.id, { ...meta, id: g.id, access: held.has(latest.key) ? 'ok' : 'outdated', keyEpoch: latest.epoch });
    }
    // 3. Éléments privés lisibles : évènements, messages (on ne redéchiffre que ce qui a changé).
    const events = new Map<string, { box: unknown; data: PrivatePayload }>();
    for (const col of PRIVATE_COLLECTIONS) {
      for (const doc of this.replica.list<PrivateDoc>(col)) {
        const k = pkey(col, doc.id);
        const cur = this.events.get(k);
        if (cur && cur.box === doc.box && this.held.size === held.size) {
          events.set(k, cur);
          continue;
        }
        const data = await openPrivate<PrivatePayload>(col, doc.id, doc.box, held);
        if (data && Array.isArray(data.groups)) events.set(k, { box: doc.box, data });
      }
    }
    this.held = held;
    this.groups = groups;
    this.events = events;
    this.emit();
  }

  /* ------------------------------------------------------------ lecture */

  private cached<T>(key: string, build: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, build());
    return this.cache.get(key) as T;
  }

  /** Cercles de cet appareil, le cercle personnel en premier. */
  list(): GroupInfo[] {
    return this.cached('list', () =>
      [...this.groups.values()].sort((a, b) => (a.personal ? 0 : 1) - (b.personal ? 0 : 1) || a.name.localeCompare(b.name)),
    );
  }

  /** Évènements privés lisibles, au format des documents de la réplique. */
  privateEvents<T>(): Doc<T & { groups: string[] }>[] {
    return this.privateDocs<T>(PRIVATE_EVENTS);
  }

  /** Éléments privés lisibles d'une collection (dans l'ordre de création). */
  privateDocs<T>(collection: string): Doc<T & { groups: string[] }>[] {
    return this.cached(`docs:${collection}`, () => {
      const out: Doc<T & { groups: string[] }>[] = [];
      for (const doc of this.replica.list<object>(collection)) {
        const base = doc;
        const id = doc.id;
        const data = this.events.get(pkey(collection, id))?.data;
        if (!data) continue;
        const { groups, ...fields } = data;
        out.push({ ...(fields as T), groups, id, createdBy: base.createdBy, createdAt: base.createdAt, updatedAt: base.updatedAt } as Doc<T & { groups: string[] }>);
      }
      return out;
    });
  }

  /** Clé en vigueur d'un cercle, si cet appareil la détient. */
  private currentKey(group: string): HeldKey | null {
    const latest = latestKey(this.keyDocs(), group);
    return latest ? (this.held.get(latest.key) ?? null) : null;
  }

  /** Appareils de la famille qui attendent l'accès à un cercle (à autoriser d'un geste). */
  pending(group: string): DeviceRow[] {
    const g = this.groups.get(group);
    if (!g || g.access !== 'ok') return [];
    return pendingDevices(g, this.keyDocs(), group, this.replica.list<Device>('devices') as DeviceRow[]);
  }

  /** Appareils qui ont la clé en vigueur d'un cercle. */
  holders(group: string): DeviceRow[] {
    const latest = latestKey(this.keyDocs(), group);
    if (!latest) return [];
    const ids = holdersOf(this.keyDocs(), latest.key);
    return (this.replica.list<Device>('devices') as DeviceRow[]).filter((d) => ids.has(d.id) && !d.revoked);
  }

  /** Nombre total d'appareils en attente, tous cercles confondus. */
  pendingCount(): number {
    return this.cached('pendingCount', () => this.list().reduce((n, g) => n + this.pending(g.id).length, 0));
  }

  /** Mon cercle personnel existe-t-il, et y ai-je accès ? (sert à afficher « en attente d'autorisation ») */
  async personalStatus(): Promise<'none' | 'ok' | 'waiting'> {
    const memberId = this.memberId();
    if (!memberId) return 'none';
    const id = await personalGroupId(memberId);
    if (this.groups.get(id)?.access === 'ok') return 'ok';
    return latestKey(this.keyDocs(), id) ? 'waiting' : 'none';
  }

  /* ------------------------------------------------------------ cercles */

  private async writeKey(group: string, keyId: string, epoch: number, secret: Uint8Array<ArrayBuffer>, device: DeviceRow | { id: string; pub: JsonWebKey }) {
    if (!device.pub) return;
    const env = await sealGroupSecret(device.pub, secret, group, keyId, epoch, device.id);
    await this.replica.upsert<GroupKeyDoc>('groupKeys', `${keyId}${device.id}`, { group, key: keyId, epoch, device: device.id, env, by: this.identity.deviceId });
  }

  private me(): { id: string; pub: JsonWebKey } {
    const d = this.replica.get<Device>('devices', this.identity.deviceId);
    if (!d?.pub) throw new Error('Appareil non enregistré');
    return { id: this.identity.deviceId, pub: d.pub };
  }

  /** Nouvelle clé pour un cercle (création, ou retrait d'un membre) : remise aux appareils indiqués + celui-ci. */
  private async newKey(group: string, epoch: number, recipients: DeviceRow[]): Promise<HeldKey> {
    const secret = newSecret();
    const keyId = randomId();
    await this.writeKey(group, keyId, epoch, secret, this.me());
    for (const d of recipients) if (d.id !== this.identity.deviceId && !d.revoked) await this.writeKey(group, keyId, epoch, secret, d);
    const k: HeldKey = { group, keyId, epoch, key: await deriveGroupKey(secret), secret };
    this.held.set(keyId, k);
    return k;
  }

  async create(meta: GroupMeta, id = randomId()): Promise<string> {
    const memberId = this.memberId();
    if (!memberId) throw new Error('Profil inconnu');
    const members = meta.members.includes(memberId) ? meta.members : [memberId, ...meta.members];
    const k = await this.newKey(id, 0, []);
    await this.replica.upsert<GroupDoc>('groups', id, { meta: await sealGroupMeta(k, { ...meta, members }), mk: k.keyId });
    await this.refresh();
    return id;
  }

  /**
   * Modifie un cercle. Retirer un membre renouvelle la clé : elle n'est remise qu'aux appareils qui avaient
   * déjà accès ET qui appartiennent encore à un membre du cercle. Renvoie les membres retirés.
   */
  async update(id: string, patch: Partial<Pick<GroupMeta, 'name' | 'color' | 'members'>>): Promise<string[]> {
    const g = this.groups.get(id);
    let k = this.currentKey(id);
    if (!g || !k) throw new Error("Cet appareil n'a pas accès à ce cercle");
    const members = patch.members ?? g.members;
    if (g.personal && (members.length !== 1 || members[0] !== g.personal)) throw new Error('Le cercle personnel ne contient que vous');
    if (!members.length) throw new Error('Un cercle a au moins un membre');
    const removed = g.members.filter((m) => !members.includes(m));
    if (removed.length) {
      const keep = this.holders(id).filter((d) => members.includes(d.memberId));
      k = await this.newKey(id, g.keyEpoch + 1, keep);
    }
    const meta: GroupMeta = { name: patch.name ?? g.name, color: patch.color ?? g.color, members, ...(g.personal ? { personal: g.personal } : {}) };
    await this.replica.upsert<GroupDoc>('groups', id, { meta: await sealGroupMeta(k, meta), mk: k.keyId });
    await this.refresh();
    return removed;
  }

  /** Supprime un cercle (seulement s'il ne sert plus à aucun évènement lisible ici). */
  async remove(id: string) {
    const g = this.groups.get(id);
    if (!g || g.personal) throw new Error('Ce cercle ne peut pas être supprimé');
    if (this.usage(id)) throw new Error("Ce cercle sert encore à des évènements : retirez-le d'abord de ces évènements");
    await this.replica.erase('groups', id, { meta: null, mk: null });
    await this.refresh();
  }

  /** Nombre d'évènements visibles par ce cercle. */
  usage(id: string): number {
    let n = 0;
    for (const [k, { data }] of this.events) if (k.startsWith(`${PRIVATE_EVENTS}/`) && data.groups.includes(id)) n++;
    return n;
  }

  /** Donne l'accès à un appareil qui l'attend (geste explicite d'un appareil qui a déjà accès). */
  async grant(group: string, deviceId: string) {
    const k = this.currentKey(group);
    const d = this.pending(group).find((x) => x.id === deviceId);
    if (!k || !d) throw new Error('Autorisation impossible');
    await this.writeKey(group, k.keyId, k.epoch, k.secret, d);
    await this.refresh();
  }

  /**
   * Crée le cercle personnel de ce membre s'il n'existe pas encore. Si un autre de ses appareils l'a déjà
   * créé, celui-ci attend d'être autorisé depuis cet autre appareil.
   */
  async ensurePersonal(name = 'Moi seul') {
    const memberId = this.memberId();
    if (!memberId || !this.replica.get<Device>('devices', this.identity.deviceId)?.pub) return;
    const id = await personalGroupId(memberId);
    await this.refresh();
    const latest = latestKey(this.keyDocs(), id);
    const member = this.replica.get<Member>('members', memberId);
    if (!latest) {
      await this.create({ name, color: member?.color ?? '#8E5CE6', members: [memberId], personal: memberId }, id);
      return;
    }
    // Deux appareils l'ont créé en même temps : celui qui a la clé en vigueur réécrit la description.
    const k = this.held.get(latest.key);
    const doc = this.replica.get<GroupDoc>('groups', id);
    if (k && (!this.groups.has(id) || doc?.mk !== k.keyId)) {
      const meta: GroupMeta = { name, color: member?.color ?? '#8E5CE6', members: [memberId], personal: memberId };
      await this.replica.upsert<GroupDoc>('groups', id, { meta: await sealGroupMeta(k, meta), mk: k.keyId });
      await this.refresh();
    }
  }

  /** Clés détenues (pour la sauvegarde chiffrée). */
  exportSecrets(): { group: string; key: string; epoch: number; secret: Uint8Array }[] {
    return [...this.held.values()].map((k) => ({ group: k.group, key: k.keyId, epoch: k.epoch, secret: k.secret }));
  }

  /** Restauration d'une sauvegarde : les clés qu'elle contient sont remises à cet appareil. */
  async importSecrets(list: { group: string; key: string; epoch: number; secret: Uint8Array<ArrayBuffer> }[]) {
    for (const s of list) {
      if (!isId(s.group) || !isId(s.key) || !Number.isInteger(s.epoch) || s.secret?.length !== 32) continue;
      if (this.held.has(s.key)) continue;
      await this.writeKey(s.group, s.key, s.epoch, s.secret, this.me());
    }
    await this.refresh();
  }

  /* ------------------------------------------------------------ évènements privés */

  /** Cercles d'un évènement privé lisible ici (sinon null). */
  groupsOf(id: string): string[] | null {
    return this.events.get(pkey(PRIVATE_EVENTS, id))?.data.groups ?? null;
  }

  /**
   * Enregistre un évènement visible seulement par des cercles. Une nouvelle clé d'élément est tirée à chaque
   * enregistrement, sauf si l'évènement est aussi visible par un cercle dont cet appareil n'a pas la clé (on
   * conserve alors son enveloppe et la clé de l'élément).
   */
  async saveEvent(id: string, data: object, groups: string[]) {
    await this.savePrivate(PRIVATE_EVENTS, id, data, groups);
  }

  /** Envoie un message dans la conversation d'un cercle. */
  async sendMessage(group: string, text: string) {
    if (!this.currentKey(group)) throw new Error("Cet appareil n'a pas accès à ce cercle");
    await this.savePrivate(PRIVATE_MESSAGES, randomId(), { text }, [group]);
  }

  /** Enregistre un élément chiffré pour des cercles (voir saveEvent). */
  async savePrivate(collection: string, id: string, data: object, groups: string[]) {
    const unique = [...new Set(groups)].filter(isId);
    if (!unique.length) throw new Error('Choisissez au moins un cercle');
    const keys: HeldKey[] = [];
    const foreign: string[] = [];
    for (const g of unique) {
      const k = this.currentKey(g);
      if (k) keys.push(k);
      else foreign.push(g);
    }
    const previous = this.replica.get<PrivateDoc>(collection, id)?.box ?? undefined;
    const keep: Record<string, string> = {};
    if (foreign.length) {
      // On garde les enveloppes des cercles dont on n'a pas la clé (identifiées par leurs clés connues).
      const keyDocs = this.keyDocs();
      for (const [keyId, wrapped] of Object.entries(previous?.w ?? {})) {
        const owner = keyDocs.find((k) => k.key === keyId)?.group;
        if (owner && foreign.includes(owner) && !keys.some((k) => k.group === owner)) keep[keyId] = wrapped;
      }
      if (!Object.keys(keep).length) throw new Error("Cet appareil n'a pas accès à l'un des cercles choisis");
    }
    const payload: PrivatePayload = { ...(data as Record<string, unknown>), groups: unique };
    const box = await sealPrivate(collection, id, payload, keys, { keep, previous: previous ?? undefined, held: this.held });
    // Lisible immédiatement (rappels, notifications d'activité) sans attendre le déchiffrement.
    this.events.set(pkey(collection, id), { box, data: payload });
    this.cache.clear();
    const exists = !!this.replica.get(collection, id);
    if (exists) await this.replica.update<PrivateDoc>(collection, id, { box });
    else await this.replica.create<PrivateDoc>(collection, { box }, id);
  }

  /** Supprime un évènement privé (le contenu chiffré est d'abord effacé des copies). */
  async removeEvent(id: string) {
    this.events.delete(pkey(PRIVATE_EVENTS, id));
    this.cache.clear();
    await this.replica.erase(PRIVATE_EVENTS, id, { box: null });
  }

  /** Membres qui peuvent voir un ensemble de cercles (union), d'après les cercles lisibles ici. */
  membersOf(groups: string[]): Set<string> {
    const out = new Set<string>();
    for (const g of groups) for (const m of this.groups.get(g)?.members ?? []) out.add(m);
    return out;
  }
}
