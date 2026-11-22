/**
 * Cercles restreints : état de CET appareil (clés détenues, cercles lisibles, éléments privés déchiffrés)
 * et opérations (créer un cercle, autoriser un appareil, retirer un membre, enregistrer un élément privé).
 * La cryptographie et les règles sont dans groups.ts (fonctions pures, testées).
 *
 * Résistance aux appareils malveillants (version modifiée de l'appli) :
 *  - clés : épinglées, et gardées sur l'appareil une fois vérifiées (une enveloppe effacée ou abîmée n'y change rien) ;
 *  - éléments privés et descriptions : la dernière version valide est gardée sur l'appareil ; une version
 *    illisible, effacée « à la main » ou écrite avec une ancienne clé ne la remplace pas ;
 *  - suppressions : elles aussi chiffrées (un appareil sans accès ne peut rien supprimer) ;
 *  - clés publiques des appareils : épinglées à la première vue. Un appareil dont la clé publique change
 *    ensuite (quelqu'un essaie de recevoir les clés à sa place) est « suspect » : plus rien ne lui est remis ;
 *  - enveloppes signées par l'appareil qui les remet (voir deviceAuth) : on sait qui nous a donné une clé.
 */
import { b64url, fromB64url, randomId } from './bytes';
import { checkDeviceAuth, deriveGroupKeyId, deviceAuth, newSecret } from './crypto';
import * as idb from './idb';
import type { Device, Member } from './engine';
import {
  authContext,
  checkLink,
  grantCode,
  grantProof,
  isId,
  keyLink,
  latestKey,
  newGroupKey,
  openGroupMeta,
  openGroupSecret,
  openPrivate,
  pendingDevices,
  personalGroupId,
  resolveCurrent,
  sealGroupMeta,
  sealGroupSecret,
  sealPrivate,
  type GroupDoc,
  type GroupKeyDoc,
  type GroupMeta,
  type HeldKey,
  type PrivateBox,
  type PrivateDoc,
  type Resolved,
} from './groups';
import { toDoc, type Doc, type Replica } from './replica';

export const PRIVATE_EVENTS = 'privateEvents';
/** Messages d'une conversation réservée à un cercle (chiffrés comme les évènements privés). */
export const PRIVATE_MESSAGES = 'privateMessages';
const PRIVATE_COLLECTIONS = [PRIVATE_EVENTS, PRIVATE_MESSAGES];
const SOURCES = new Set(['groups', 'groupKeys', ...PRIVATE_COLLECTIONS, 'devices', 'members']);
const pkey = (collection: string, id: string) => `${collection}/${id}`;

/**
 * Accès de cet appareil à un cercle : `ok`, `outdated` (une clé plus récente, liée à la nôtre, existe et cet
 * appareil ne l'a pas reçue : retiré du cercle, ou à autoriser de nouveau).
 */
export type GroupAccess = 'ok' | 'outdated';
export type GroupInfo = GroupMeta & {
  id: string;
  access: GroupAccess;
  keyEpoch: number;
  /** Clés concurrentes qu'on ne sait pas départager : écriture bloquée, à renouveler. */
  conflict?: boolean;
  /** Description illisible avec la clé en vigueur : à renommer. */
  broken?: boolean;
};
export type DeviceRow = Doc<Device>;
/** Élément privé déchiffré : ses champs + les cercles qui le voient. */
export type PrivatePayload = { groups: string[]; deleted?: boolean } & Record<string, unknown>;
/** Accès proposé à un nouvel appareil (à accepter après comparaison du code). */
export type GroupOffer = { group: string; keyId: string; name: string; color: string; personal?: string; by: string; code: string };

type Identity = { deviceId: string; privateKey: CryptoKey };
/** Petit stockage local (propre à l'appareil) : IndexedDB `kv` dans l'appli, en mémoire dans les tests. */
export type LocalStore = { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> };
const idbStore: LocalStore = {
  get: <T,>(key: string) => idb.get<T>('kv', key).catch(() => undefined),
  put: (key, value) => idb.put('kv', key, value).catch(() => {}),
};

/** `by` : appareil qui nous a remis la clé (signature vérifiée), compté parmi ceux qui la connaissent. */
type StoredSecret = { group: string; epoch: number; secret: string; by?: string };
type GoodMeta = { meta: string; mk: string };
type Local = {
  groupPins: Record<string, string>;
  groupSecrets: Record<string, StoredSecret>;
  groupGoodMeta: Record<string, GoodMeta>;
  groupGoodItems: Record<string, PrivateBox>;
  /** Clé publique de chaque appareil, épinglée à la première vue (crv, x, y). */
  groupDevicePubs: Record<string, string>;
};
const pubFingerprint = (j: JsonWebKey | undefined) =>
  j && typeof j.x === 'string' && typeof j.y === 'string' ? JSON.stringify({ crv: j.crv, x: j.x, y: j.y }) : null;

export class GroupManager {
  /** Clés détenues par cet appareil, par identifiant de clé. */
  held = new Map<string, HeldKey>();
  /** Clés des cercles acceptés (hors accès simplement proposés). */
  private usable = new Map<string, HeldKey>();
  /** Cercles dont cet appareil peut lire la description. */
  groups = new Map<string, GroupInfo>();
  /** Éléments privés lisibles par cet appareil. */
  private items = new Map<string, { box: unknown; data: PrivatePayload }>();
  private state = new Map<string, Resolved>();
  private offerList: GroupOffer[] = [];
  private opened = new Map<string, { env: string; auth?: string; by: string; key: HeldKey | null }>();
  private proofs = new Map<string, boolean>();
  /** Clés publiques épinglées, et appareils dont la clé publique a changé depuis. */
  private pubs = new Map<string, JsonWebKey>();
  private suspectIds = new Set<string>();
  private listeners = new Set<() => void>();
  private version = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private cache = new Map<string, unknown>();
  /** Données locales (épingles, clés vérifiées, dernières versions valides), chargées une fois. */
  private local: Local | null = null;

  constructor(
    private replica: Replica,
    private identity: Identity,
    private memberId: () => string | null,
    private store: LocalStore = idbStore,
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

  /** Documents d'une collection, y compris ceux « supprimés » (une suppression non chiffrée ne compte pas). */
  private records<T>(collection: string): Doc<T>[] {
    return this.replica
      .allRecords((r) => r.c === collection)
      .sort((a, b) => (a.ct < b.ct ? -1 : a.ct > b.ct ? 1 : 0))
      .map((r) => toDoc<T>(r));
  }
  private keyDocs(): Doc<GroupKeyDoc>[] {
    return this.records<GroupKeyDoc>('groupKeys');
  }

  private async loadLocal(): Promise<Local> {
    if (this.local) return this.local;
    const [groupPins, groupSecrets, groupGoodMeta, groupGoodItems, groupDevicePubs] = await Promise.all([
      this.store.get<Local['groupPins']>('groupPins'),
      this.store.get<Local['groupSecrets']>('groupSecrets'),
      this.store.get<Local['groupGoodMeta']>('groupGoodMeta'),
      this.store.get<Local['groupGoodItems']>('groupGoodItems'),
      this.store.get<Local['groupDevicePubs']>('groupDevicePubs'),
    ]);
    this.local = {
      groupPins: groupPins ?? {},
      groupSecrets: groupSecrets ?? {},
      groupGoodMeta: groupGoodMeta ?? {},
      groupGoodItems: groupGoodItems ?? {},
      groupDevicePubs: groupDevicePubs ?? {},
    };
    return this.local;
  }
  private save(local: Local, key: keyof Local) {
    return this.store.put(key, local[key]);
  }

  private async compute() {
    const me = this.identity.deviceId;
    const local = await this.loadLocal();
    const dirty = new Set<keyof Local>();

    // 0. Clés publiques des appareils : épinglées à la première vue ; un changement ensuite rend l'appareil suspect.
    const pubs = new Map<string, JsonWebKey>();
    const suspects = new Set<string>();
    for (const d of this.replica.list<Device>('devices')) {
      const fp = pubFingerprint(d.pub);
      if (!fp) continue;
      const pinned = local.groupDevicePubs[d.id];
      if (!pinned) {
        local.groupDevicePubs[d.id] = fp;
        dirty.add('groupDevicePubs');
      } else if (pinned !== fp) suspects.add(d.id);
      const j = JSON.parse(local.groupDevicePubs[d.id]) as { crv?: string; x: string; y: string };
      pubs.set(d.id, { kty: 'EC', crv: j.crv ?? 'P-256', x: j.x, y: j.y });
    }
    this.pubs = pubs;
    this.suspectIds = suspects;

    // 1. Clés détenues : celles déjà vérifiées et gardées sur l'appareil, plus les enveloppes adressées à cet
    //    appareil (le secret doit correspondre à l'identifiant de la clé, dérivé du secret).
    const held = new Map<string, HeldKey>();
    for (const [keyId, s] of Object.entries(local.groupSecrets)) {
      const known = this.held.get(keyId);
      if (known) {
        held.set(keyId, known);
        continue;
      }
      const secret = fromB64url(s.secret);
      if (secret.length === 32 && (await deriveGroupKeyId(secret)) === keyId) held.set(keyId, await newGroupKey(s.group, s.epoch, secret));
    }
    const keys = this.keyDocs();
    for (const d of keys) {
      if (d.device !== me || held.has(d.key)) continue;
      const cached = this.opened.get(d.id);
      let k: HeldKey | null;
      if (cached && cached.env === d.env && cached.auth === d.auth && cached.by === d.by) k = cached.key;
      else {
        // Enveloppe acceptée seulement si elle est signée par l'appareil qui dit la remettre.
        const byPub = typeof d.by === 'string' ? pubs.get(d.by) : undefined;
        const signed =
          !!byPub && !suspects.has(d.by) && (await checkDeviceAuth(this.identity.privateKey, byPub, d.auth, authContext(d.group, d.key, d.epoch, me, d.by)));
        k = signed ? await openGroupSecret(this.identity.privateKey, d, me) : null;
      }
      this.opened.set(d.id, { env: d.env, auth: d.auth, by: d.by, key: k });
      if (k && k.group === d.group) {
        held.set(k.keyId, k);
        local.groupSecrets[k.keyId] = { group: k.group, epoch: k.epoch, secret: b64url(k.secret), by: d.by };
        dirty.add('groupSecrets');
      }
    }
    const knowers = new Map<string, Set<string>>();
    for (const [keyId, s] of Object.entries(local.groupSecrets)) if (typeof s.by === 'string') knowers.set(keyId, new Set([s.by]));

    // 2. Clé en vigueur de chaque cercle (épingle, chaîne de clés, départage) et accès proposés.
    const state = new Map<string, Resolved>();
    const byGroup = new Map<string, HeldKey[]>();
    for (const k of held.values()) byGroup.set(k.group, [...(byGroup.get(k.group) ?? []), k]);
    for (const [group, list] of byGroup) {
      const docs = keys.filter((d) => d.group === group);
      const r = await resolveCurrent(list, docs, local.groupPins[group], this.proofs, knowers);
      if (r.pinned && local.groupPins[group] !== r.pinned.keyId) {
        local.groupPins[group] = r.pinned.keyId;
        dirty.add('groupPins');
      }
      state.set(group, r);
    }

    // 3. Cercles lisibles : la description n'est acceptée qu'avec la clé en vigueur ; sinon, la dernière valide.
    const groups = new Map<string, GroupInfo>();
    const offers: GroupOffer[] = [];
    const groupDocs = new Map(this.records<GroupDoc>('groups').map((g) => [g.id, g]));
    for (const [id, r] of state) {
      if (!isId(id)) continue;
      const g = groupDocs.get(id);
      if (r.offers.length) {
        // Nouvel appareil : rien n'est adopté sans comparaison du code avec l'appareil qui a donné l'accès.
        for (const k of r.offers) {
          const meta = g?.mk === k.keyId ? await openGroupMeta(g, held, id) : null;
          if (meta?.deleted) continue;
          const doc = keys.find((d) => d.key === k.keyId && d.device === me);
          offers.push({
            group: id,
            keyId: k.keyId,
            name: meta?.name ?? 'Cercle',
            color: meta?.color ?? '#8A8F98',
            personal: meta?.personal,
            by: doc ? this.deviceLabel(doc.by) : 'un appareil',
            code: await grantCode(k, me),
          });
        }
        continue;
      }
      const valid = new Set([...(r.current ? [r.current.keyId] : []), ...(r.conflict ?? []).map((c) => c.key.keyId)]);
      let meta: GroupMeta | null = null;
      if (g && typeof g.mk === 'string' && valid.has(g.mk)) {
        meta = await openGroupMeta(g, held, id);
        const good = local.groupGoodMeta[id];
        if (meta && (good?.meta !== g.meta || good?.mk !== g.mk)) {
          local.groupGoodMeta[id] = { meta: g.meta as string, mk: g.mk };
          dirty.add('groupGoodMeta');
        }
      }
      const good = local.groupGoodMeta[id];
      if (!meta && good && valid.has(good.mk)) meta = await openGroupMeta({ meta: good.meta, mk: good.mk }, held, id);
      if (meta?.deleted) continue;
      const cur = r.current ?? r.pinned;
      if (!cur) continue;
      // Remplacée ? Seulement si une clé de l'époque suivante est liée à la nôtre (vérifiable avec notre clé).
      let replaced = false;
      for (const d of keys) {
        if (replaced) break;
        if (d.group !== id || d.epoch !== cur.epoch + 1 || held.has(d.key)) continue;
        for (const l of d.links ?? []) {
          if (l?.pk === cur.keyId && (await checkLink(cur, { keyId: d.key, epoch: d.epoch }, l.link))) {
            replaced = true;
            break;
          }
        }
      }
      const info = { id, access: (replaced ? 'outdated' : 'ok') as GroupAccess, keyEpoch: cur.epoch, conflict: !!r.conflict };
      if (meta) groups.set(id, { ...meta, ...info });
      else if (g?.meta && !replaced) groups.set(id, { name: 'Cercle (description illisible)', color: '#8A8F98', members: [], ...info, broken: true });
    }

    // 4. Éléments privés : la version la plus récente si elle est valide, sinon la dernière version valide.
    //    Seulement avec les clés des cercles acceptés (une clé simplement proposée ne sert à rien lire).
    const usable = new Map([...held].filter(([, k]) => !!state.get(k.group)?.pinned));
    const items = new Map<string, { box: unknown; data: PrivatePayload }>();
    for (const col of PRIVATE_COLLECTIONS) {
      for (const doc of this.records<PrivateDoc>(col)) {
        const k = pkey(col, doc.id);
        const good = local.groupGoodItems[k];
        const cur = this.items.get(k);
        let entry: { box: unknown; data: PrivatePayload } | null = null;
        if (cur && cur.box === doc.box && this.usable.size === usable.size) entry = cur;
        else if (doc.box) {
          const data = await openPrivate<PrivatePayload>(col, doc.id, doc.box, usable);
          const accepted = !good || JSON.stringify(good) === JSON.stringify(doc.box) || this.wrappedWithCurrent(doc.box, data?.groups ?? [], state);
          if (data && Array.isArray(data.groups) && accepted) entry = { box: doc.box, data };
        }
        if (entry) {
          if (JSON.stringify(good) !== JSON.stringify(entry.box)) {
            local.groupGoodItems[k] = entry.box as PrivateBox;
            dirty.add('groupGoodItems');
          }
        } else if (good) {
          const data = await openPrivate<PrivatePayload>(col, doc.id, good, usable);
          if (data && Array.isArray(data.groups)) entry = { box: good, data };
        }
        if (entry) items.set(k, entry);
      }
    }

    for (const key of dirty) await this.save(local, key);
    this.held = held;
    this.usable = usable;
    this.state = state;
    this.groups = groups;
    this.offerList = offers;
    this.items = items;
    this.emit();
  }

  /** Une nouvelle version d'un élément doit être chiffrée avec la clé EN VIGUEUR d'au moins un de ses cercles. */
  private wrappedWithCurrent(box: PrivateBox, groups: string[], state: Map<string, Resolved>): boolean {
    const keys = Object.keys(box?.w ?? {});
    return groups.some((g) => {
      const r = state.get(g);
      const ok = [r?.current?.keyId, ...(r?.conflict ?? []).map((c) => c.key.keyId)].filter(Boolean);
      return keys.some((k) => ok.includes(k));
    });
  }

  private deviceLabel(id: string): string {
    const d = this.replica.get<Device>('devices', id);
    if (!d) return 'un appareil';
    const m = this.replica.get<Member>('members', d.memberId);
    return `${d.label || 'Appareil'}${m ? ` (${m.name})` : ''}`;
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

  /** Accès proposés à cet appareil (nouvel appareil), à accepter après comparaison du code. */
  offers(): GroupOffer[] {
    return this.offerList;
  }

  /** Évènements privés lisibles, au format des documents de la réplique. */
  privateEvents<T>(): Doc<T & { groups: string[] }>[] {
    return this.privateDocs<T>(PRIVATE_EVENTS);
  }

  /** Éléments privés lisibles d'une collection (dans l'ordre de création). */
  privateDocs<T>(collection: string): Doc<T & { groups: string[] }>[] {
    return this.cached(`docs:${collection}`, () => {
      const out: Doc<T & { groups: string[] }>[] = [];
      for (const doc of this.records<object>(collection)) {
        const data = this.items.get(pkey(collection, doc.id))?.data;
        if (!data || data.deleted) continue;
        const { groups, deleted: _deleted, ...fields } = data;
        void _deleted;
        out.push({ ...(fields as T), groups, id: doc.id, createdBy: doc.createdBy, createdAt: doc.createdAt, updatedAt: doc.updatedAt } as Doc<T & { groups: string[] }>);
      }
      return out;
    });
  }

  /** Clé avec laquelle chiffrer pour un cercle (null : pas d'accès, accès retiré, ou conflit non résolu). */
  private currentKey(group: string): HeldKey | null {
    const g = this.groups.get(group);
    if (g && g.access !== 'ok') return null;
    return this.state.get(group)?.current ?? null;
  }

  /** Appareils de la famille qui attendent l'accès à un cercle (à autoriser d'un geste). */
  pending(group: string): DeviceRow[] {
    const g = this.groups.get(group);
    const r = this.state.get(group);
    if (!g || g.access !== 'ok' || !r?.current) return [];
    return pendingDevices(g, r.holders, this.replica.list<Device>('devices') as DeviceRow[]).filter((d) => !this.suspectIds.has(d.id));
  }

  /** Appareils autorisés d'un cercle (autorisation prouvée avec la clé en vigueur). */
  holders(group: string): DeviceRow[] {
    const ids = this.state.get(group)?.holders;
    if (!ids) return [];
    return (this.replica.list<Device>('devices') as DeviceRow[]).filter((d) => ids.has(d.id) && !d.revoked);
  }

  /** Appareils dont la clé publique a changé depuis qu'on les connaît : plus aucune clé ne leur est remise. */
  suspects(): DeviceRow[] {
    return (this.replica.list<Device>('devices') as DeviceRow[]).filter((d) => this.suspectIds.has(d.id) && !d.revoked);
  }

  /** Code de vérification d'un appareil autorisé (à comparer avec celui affiché sur cet appareil). */
  async codeFor(group: string, deviceId: string): Promise<string | null> {
    const k = this.state.get(group)?.current;
    return k ? grantCode(k, deviceId) : null;
  }

  /** Nombre d'appareils en attente, tous cercles confondus, plus les accès proposés à cet appareil. */
  pendingCount(): number {
    return this.cached('pendingCount', () => this.list().reduce((n, g) => n + this.pending(g.id).length, 0) + this.offerList.length);
  }

  /** Mon cercle personnel : accessible, proposé (code à comparer), en attente, ou pas encore créé. */
  async personalStatus(): Promise<'none' | 'ok' | 'offer' | 'waiting'> {
    const memberId = this.memberId();
    if (!memberId) return 'none';
    const id = await personalGroupId(memberId);
    if (this.groups.get(id)?.access === 'ok') return 'ok';
    if (this.offerList.some((o) => o.group === id)) return 'offer';
    return latestKey(this.keyDocs(), id) ? 'waiting' : 'none';
  }

  /* ------------------------------------------------------------ cercles */

  /** Remet une clé à un appareil : enveloppe pour sa clé publique + preuve d'autorisation (+ liens éventuels). */
  private async writeKey(k: HeldKey, device: { id: string }, links?: { pk: string; link: string }[]) {
    // Toujours la clé publique épinglée, jamais une clé publique remplacée depuis.
    const pub = this.pubs.get(device.id);
    if (!pub || this.suspectIds.has(device.id)) return;
    const me = this.identity.deviceId;
    const env = await sealGroupSecret(pub, k.secret, k.group, k.keyId, k.epoch, device.id);
    const auth = await deviceAuth(this.identity.privateKey, pub, authContext(k.group, k.keyId, k.epoch, device.id, me));
    const proof = await grantProof(k, device.id);
    await this.replica.upsert<GroupKeyDoc>('groupKeys', `${k.keyId}${device.id}`, {
      group: k.group,
      key: k.keyId,
      epoch: k.epoch,
      device: device.id,
      env,
      by: me,
      auth,
      proof,
      ...(links?.length ? { links } : {}),
    });
  }

  /** Garde une clé sur cet appareil et, si demandé, l'épingle comme clé en vigueur du cercle. */
  private async keep(k: HeldKey, pin: boolean) {
    const local = await this.loadLocal();
    this.held.set(k.keyId, k);
    local.groupSecrets[k.keyId] = { group: k.group, epoch: k.epoch, secret: b64url(k.secret) };
    await this.save(local, 'groupSecrets');
    if (pin) {
      local.groupPins[k.group] = k.keyId;
      await this.save(local, 'groupPins');
    }
  }

  private me(): { id: string } {
    if (!this.pubs.has(this.identity.deviceId)) throw new Error('Appareil non enregistré');
    return { id: this.identity.deviceId };
  }

  /**
   * Nouvelle clé pour un cercle (création, retrait d'un membre, conflit) : remise aux appareils indiqués + celui-ci.
   * Une clé renouvelée est liée aux précédentes : les autres appareils ne l'adoptent qu'à cette condition.
   */
  private async newKey(group: string, recipients: DeviceRow[], prevs: HeldKey[] = []): Promise<HeldKey> {
    const epoch = prevs.length ? Math.max(...prevs.map((p) => p.epoch)) + 1 : 0;
    const k = await newGroupKey(group, epoch, newSecret());
    const links: { pk: string; link: string }[] = [];
    for (const p of prevs) if (p.epoch === epoch - 1) links.push({ pk: p.keyId, link: await keyLink(p, k) });
    await this.keep(k, true);
    await this.writeKey(k, this.me(), links);
    for (const d of recipients) if (d.id !== this.identity.deviceId && !d.revoked) await this.writeKey(k, d, links);
    return k;
  }

  private async writeMeta(id: string, k: HeldKey, meta: GroupMeta) {
    const sealed = await sealGroupMeta(k, meta);
    const local = await this.loadLocal();
    local.groupGoodMeta[id] = { meta: sealed, mk: k.keyId };
    await this.save(local, 'groupGoodMeta');
    await this.replica.upsert<GroupDoc>('groups', id, { meta: sealed, mk: k.keyId });
  }

  async create(meta: GroupMeta, id = randomId()): Promise<string> {
    const memberId = this.memberId();
    if (!memberId) throw new Error('Profil inconnu');
    const members = meta.members.includes(memberId) ? meta.members : [memberId, ...meta.members];
    const k = await this.newKey(id, []);
    await this.writeMeta(id, k, { ...meta, members });
    await this.refresh();
    return id;
  }

  /**
   * Modifie un cercle. Retirer un membre renouvelle la clé : elle n'est remise qu'aux appareils qui avaient
   * déjà accès ET qui appartiennent encore à un membre du cercle. En cas de conflit de clés, le renouvellement
   * ne garde que les appareils autorisés pour TOUTES les clés concurrentes. Renvoie les membres retirés.
   */
  async update(id: string, patch: Partial<Pick<GroupMeta, 'name' | 'color' | 'members'>>): Promise<string[]> {
    const g = this.groups.get(id);
    const r = this.state.get(id);
    if (!g || !r || g.access !== 'ok' || !(r.current || r.conflict)) throw new Error("Cet appareil n'a pas accès à ce cercle");
    const members = patch.members ?? g.members;
    if (g.personal && (members.length !== 1 || members[0] !== g.personal)) throw new Error('Le cercle personnel ne contient que vous');
    if (!members.length) throw new Error('Un cercle a au moins un membre');
    const removed = g.members.filter((m) => !members.includes(m));
    const devices = this.replica.list<Device>('devices') as DeviceRow[];
    let k = r.current;
    if (r.conflict) {
      const common = r.conflict.map((c) => c.holders).reduce((a, b) => new Set([...a].filter((x) => b.has(x))));
      const keep = devices.filter((d) => common.has(d.id) && members.includes(d.memberId));
      k = await this.newKey(id, keep, r.conflict.map((c) => c.key));
    } else if (removed.length) {
      const keep = this.holders(id).filter((d) => members.includes(d.memberId));
      k = await this.newKey(id, keep, [r.current!]);
    }
    const meta: GroupMeta = { name: patch.name ?? g.name, color: patch.color ?? g.color, members, ...(g.personal ? { personal: g.personal } : {}) };
    await this.writeMeta(id, k!, meta);
    await this.refresh();
    return removed;
  }

  /** Supprime un cercle (seulement s'il ne sert plus à aucun évènement lisible ici). Suppression chiffrée. */
  async remove(id: string) {
    const g = this.groups.get(id);
    const k = this.currentKey(id);
    if (!g || g.personal || !k) throw new Error('Ce cercle ne peut pas être supprimé');
    if (this.usage(id)) throw new Error("Ce cercle sert encore à des évènements : retirez-le d'abord de ces évènements");
    await this.writeMeta(id, k, { name: '', color: '', members: [], deleted: true });
    await this.refresh();
  }

  /** Nombre d'évènements visibles par ce cercle. */
  usage(id: string): number {
    let n = 0;
    for (const [k, { data }] of this.items) if (k.startsWith(`${PRIVATE_EVENTS}/`) && !data.deleted && data.groups.includes(id)) n++;
    return n;
  }

  /**
   * Donne l'accès à un appareil qui l'attend (geste explicite d'un appareil qui a déjà accès). Renvoie le code
   * de vérification que le nouvel appareil doit afficher avant d'accepter.
   */
  async grant(group: string, deviceId: string): Promise<string> {
    const k = this.currentKey(group);
    const d = this.pending(group).find((x) => x.id === deviceId);
    if (!k || !d) throw new Error('Autorisation impossible');
    await this.writeKey(k, d);
    await this.refresh();
    return grantCode(k, deviceId);
  }

  /** Nouvel appareil : accepte un accès proposé (après avoir comparé le code avec l'autre appareil). */
  async acceptOffer(group: string, keyId: string) {
    const k = this.held.get(keyId);
    if (!k || k.group !== group || !this.offerList.some((o) => o.keyId === keyId)) throw new Error('Accès introuvable');
    await this.keep(k, true);
    await this.refresh();
  }

  /**
   * Crée le cercle personnel de ce membre s'il n'existe pas encore (par son appareil le plus ancien seulement).
   * Si la description est illisible avec la clé en vigueur, la réécrit.
   */
  async ensurePersonal(name = 'Moi seul') {
    const memberId = this.memberId();
    if (!memberId || !this.replica.get<Device>('devices', this.identity.deviceId)?.pub) return;
    const id = await personalGroupId(memberId);
    await this.refresh();
    const member = this.replica.get<Member>('members', memberId);
    const meta: GroupMeta = { name, color: member?.color ?? '#8E5CE6', members: [memberId], personal: memberId };
    if (!latestKey(this.keyDocs(), id)) {
      // Seul l'appareil le plus ancien du membre crée son cercle personnel : un appareil qui vient de choisir ce
      // profil (peut-être pour se faire passer pour lui) ne doit pas devenir le « propriétaire » de ses clés.
      if (this.oldestDeviceOf(memberId) !== this.identity.deviceId) return;
      await this.create(meta, id);
      return;
    }
    const k = this.currentKey(id);
    if (k && this.groups.get(id)?.broken) {
      await this.writeMeta(id, k, meta);
      await this.refresh();
    }
  }

  /** Appareil (non retiré) le plus ancien d'un membre. */
  oldestDeviceOf(memberId: string): string | null {
    const mine = (this.replica.list<Device>('devices') as DeviceRow[]).filter((d) => d.memberId === memberId && !d.revoked && d.pub);
    // Ordre de création exact (horloge logique hybride, unique par appareil), pas seulement la date à la milliseconde.
    const clock = new Map(this.replica.allRecords((r) => r.c === 'devices').map((r) => [r.id, r.cbt ?? r.ct]));
    mine.sort((a, b) => (clock.get(a.id) ?? '').localeCompare(clock.get(b.id) ?? '') || (a.id < b.id ? -1 : 1));
    return mine[0]?.id ?? null;
  }

  /** Clés détenues (pour la sauvegarde chiffrée). */
  exportSecrets(): { group: string; key: string; epoch: number; secret: Uint8Array }[] {
    return [...this.usable.values()].map((k) => ({ group: k.group, key: k.keyId, epoch: k.epoch, secret: k.secret }));
  }

  /** Restauration d'une sauvegarde (protégée par phrase secrète, donc de confiance) : clés gardées et épinglées. */
  async importSecrets(list: { group: string; key: string; epoch: number; secret: Uint8Array<ArrayBuffer> }[]) {
    await this.refresh();
    const newest = new Map<string, HeldKey>();
    for (const s of list) {
      if (!isId(s.group) || !isId(s.key) || !Number.isInteger(s.epoch) || s.secret?.length !== 32) continue;
      if ((await deriveGroupKeyId(s.secret)) !== s.key) continue;
      const k = await newGroupKey(s.group, s.epoch, s.secret);
      const cur = newest.get(k.group);
      if (!cur || k.epoch > cur.epoch) newest.set(k.group, k);
      await this.keep(k, false);
    }
    for (const k of newest.values()) {
      await this.keep(k, true);
      await this.writeKey(k, this.me());
    }
    await this.refresh();
  }

  /* ------------------------------------------------------------ éléments privés */

  /** Cercles d'un évènement privé lisible ici (sinon null). */
  groupsOf(id: string): string[] | null {
    return this.items.get(pkey(PRIVATE_EVENTS, id))?.data.groups ?? null;
  }

  /** Enregistre un évènement visible seulement par des cercles (voir savePrivate). */
  async saveEvent(id: string, data: object, groups: string[]) {
    await this.savePrivate(PRIVATE_EVENTS, id, data, groups);
  }

  /** Envoie un message dans la conversation d'un cercle. */
  async sendMessage(group: string, text: string) {
    if (!this.currentKey(group)) throw new Error("Cet appareil n'a pas accès à ce cercle");
    await this.savePrivate(PRIVATE_MESSAGES, randomId(), { text }, [group]);
  }

  /**
   * Enregistre un élément chiffré pour des cercles. Une nouvelle clé d'élément est tirée à chaque enregistrement,
   * sauf si l'élément est aussi visible par un cercle dont cet appareil n'a pas la clé (on conserve alors son
   * enveloppe et la clé de l'élément).
   */
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
    const previous = (this.items.get(pkey(collection, id))?.box as PrivateBox | undefined) ?? undefined;
    const keep: Record<string, string> = {};
    if (foreign.length) {
      const keyDocs = this.keyDocs();
      for (const [keyId, wrapped] of Object.entries(previous?.w ?? {})) {
        const owner = keyDocs.find((k) => k.key === keyId)?.group;
        if (owner && foreign.includes(owner) && !keys.some((k) => k.group === owner)) keep[keyId] = wrapped;
      }
      if (!Object.keys(keep).length) throw new Error("Cet appareil n'a pas accès à l'un des cercles choisis");
    }
    const payload: PrivatePayload = { ...(data as Record<string, unknown>), groups: unique };
    const box = await sealPrivate(collection, id, payload, keys, { keep, previous, held: this.usable });
    // Lisible immédiatement (rappels, notifications d'activité) sans attendre le déchiffrement.
    this.items.set(pkey(collection, id), { box, data: payload });
    const local = await this.loadLocal();
    local.groupGoodItems[pkey(collection, id)] = box;
    await this.save(local, 'groupGoodItems');
    this.cache.clear();
    const exists = this.replica.allRecords((r) => r.c === collection && r.id === id).length > 0;
    if (exists) await this.replica.update<PrivateDoc>(collection, id, { box });
    else await this.replica.create<PrivateDoc>(collection, { box }, id);
  }

  /**
   * Supprime un évènement privé : son contenu est remplacé par une marque de suppression, elle aussi chiffrée
   * (un appareil sans accès ne peut donc rien supprimer).
   */
  async removeEvent(id: string) {
    const groups = this.groupsOf(id);
    if (!groups) throw new Error('Évènement introuvable');
    await this.savePrivate(PRIVATE_EVENTS, id, { deleted: true }, groups);
  }

  /** Membres qui peuvent voir un ensemble de cercles (union), d'après les cercles lisibles ici. */
  membersOf(groups: string[]): Set<string> {
    const out = new Set<string>();
    for (const g of groups) for (const m of this.groups.get(g)?.members ?? []) out.add(m);
    return out;
  }
}
