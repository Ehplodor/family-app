/**
 * Coffre de l'appareil : toutes les données partagées, dans des cercles, signées et chiffrées.
 *
 * Couches :
 *  - l'ESPACE (clé du relais, voir engine.ts) ne transporte que des paquets ; on n'y voit que des appareils
 *    anonymes (`v2.devices` : clés publiques, signées par l'appareil lui-même) ;
 *  - chaque CERCLE (« Famille », « Parents », « Moi seul »…) a sa clé, remise à chaque appareil autorisé
 *    (`v2.keys`), sa description chiffrée et sa liste de membres signée par son admin (`v2.circles`) ;
 *  - chaque ÉLÉMENT (`v2.<collection>/<id>`) est chiffré pour un ou plusieurs cercles et signé par l'appareil
 *    qui l'écrit ; il a un propriétaire (membre).
 *
 * Tout ce qui est reçu est vérifié ICI, sur l'appareil : signature, autorisation de l'auteur, règles de
 * modification (circles.ts). Ce qui ne passe pas est ignoré, et la dernière version valable est gardée.
 */
import { b64url, fromB64url, randomId } from './bytes';
import { canonical, deriveGroupKeyId, jwkId, newSecret, sign } from './crypto';
import {
  RULES,
  V2,
  canWrite,
  checkAdmission,
  checkDeviceDoc,
  deviceKeysOk,
  checkDoc,
  checkVeto,
  col,
  isSigned,
  latestRoster,
  payloadShapeOk,
  ruleOf,
  signAdmission,
  signDoc,
  signRoster,
  type Admission,
  type DeviceDoc,
  type DeviceLookup,
  type ItemPayload,
  type ReliefProposal,
  type Roster,
  type Signed,
  type SignedRoster,
} from './circles';
import {
  checkLink,
  checkProof,
  grantProof,
  isId,
  keyLink,
  newGroupKey,
  openGroupSecret,
  openPrivate,
  resolveCurrent,
  sealGroupSecret,
  sealPrivate,
  type GroupKeyDoc,
  type HeldKey,
  type PrivateBox,
  type Resolved,
} from './groups';
import { openJSON, sealJSON } from './crypto';
import { toDoc, type Doc, type Replica } from './replica';

/* ------------------------------------------------------------------ Types publics */

export type Identity = { deviceId: string; privateKey: CryptoKey; signKey: CryptoKey; publicJwk: JsonWebKey; signJwk: JsonWebKey };

/** Petit stockage propre à l'appareil : IndexedDB dans l'appli, mémoire dans les tests. */
export type LocalStore = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  entries<T>(prefix: string): Promise<[string, T][]>;
};

/** Ce que la clé d'administration permet de faire (stockée sur l'appareil de l'admin). */
export type AdminKeys = { spub: JsonWebKey; wrapped: string; key: CryptoKey };
/** Accès à la clé d'administration de CE membre (peut demander l'empreinte ou le visage). */
export type AdminKeyring = { get(): Promise<AdminKeys | null> };

export type CircleInfo = {
  id: string;
  name: string;
  color: string;
  /** Cercle « Moi seul » de ce membre. */
  personal?: string;
  members: string[];
  admin: string;
  /** Le membre de cet appareil est l'admin. */
  isAdmin: boolean;
  /** Version de la liste des membres. */
  rosterV: number;
  /** Clé d'administration en vigueur (publique) et sa version chiffrée par la masterkey de l'admin. */
  adminKey: { spub: JsonWebKey; wrapped: string };
  /** Clé en vigueur détenue (on peut écrire). */
  writable: boolean;
  /** Clés concurrentes : écriture bloquée jusqu'au renouvellement. */
  conflict: boolean;
  /** Cet appareil n'a plus la clé en vigueur (exclu, ou appareil déclaré perdu). */
  outdated: boolean;
};

/** Élément lisible : ses champs + cercles, propriétaire. */
export type Item<T> = Doc<T> & { groups: string[]; owner: string };

type DevicePin = { pub: JsonWebKey; spub: JsonWebKey };
type StoredSecret = { group: string; epoch: number; secret: string; by?: string };
type Good = { s: Signed<{ box: PrivateBox }>; d: ItemPayload; c: string; i: string };
type MetaPlain = { name: string; color: string; personal?: string; rosters: SignedRoster[]; x?: 1 };
type CircleDocP = { mk: string; meta: string };
type KeyDocP = {
  group: string;
  key: string;
  epoch: number;
  device: string;
  member: string;
  env: string;
  proof: string;
  links?: { pk: string; link: string }[];
  /** Validation de l'admin (entrée d'un membre ou d'un appareil). */
  asig?: string;
  /** Clés publiques de l'appareil qui reçoit (vérifiables par son identifiant). */
  dk?: DeviceDoc;
};
type LostP = { device: string; lost: boolean };
type ReliefDocP = { proposal: ReliefProposal; votes: { device: string; member: string; sig: string }[]; veto?: string; roster?: SignedRoster };

/** Collections de l'appli dont le contenu est un élément de cercle. */
export const ITEM_COLLECTIONS = Object.keys(RULES);

const K = {
  secrets: 'v.secrets',
  pins: 'v.pins',
  devpins: 'v.devpins',
  rosters: 'v.rosters',
  chains: 'v.chains',
  meta: 'v.meta',
  hidden: 'v.hidden',
  grants: 'v.grants',
  lost: 'v.lost',
  spubs: 'v.spubs',
  past: 'v.past',
  vetoes: 'v.vetoes',
  item: 'v.item:',
} as const;

type Local = {
  secrets: Record<string, StoredSecret>;
  pins: Record<string, string>;
  devpins: Record<string, DevicePin>;
  rosters: Record<string, Roster>;
  chains: Record<string, SignedRoster[]>;
  meta: Record<string, { name: string; color: string; personal?: string; x?: 1 }>;
  hidden: string[];
  /** Autorisations vues (gardées même si le document est écrasé ensuite). */
  grants: Record<string, Signed<KeyDocP>[]>;
  /** Pertes déclarées valables : appareil → { horloge, auteur, déclaration signée (pour la republier) }. */
  lost: Record<string, { at: string; by: string; s?: Signed<LostP> }>;
  /** Clés d'administration successives de chaque cercle. */
  spubs: Record<string, JsonWebKey[]>;
  /** Membres passés et présents de chaque cercle. */
  past: Record<string, string[]>;
  /** Relèves refusées par l'admin (proposition sous forme canonique). */
  vetoes: string[];
};

const pkey = (c: string, i: string) => `${c}/${i}`;

/* ------------------------------------------------------------------ Le coffre */

export class Vault {
  /** Clés détenues (vérifiées). */
  held = new Map<string, HeldKey>();
  private devices = new Map<string, DevicePin>();
  private lost = new Map<string, string>(); // appareil → horloge de la déclaration
  private state = new Map<string, Resolved>();
  private rosters = new Map<string, Roster>();
  private circleInfo = new Map<string, CircleInfo>();
  /** Membre de chaque appareil autorisé, par cercle et par clé. */
  private keyHolders = new Map<string, Map<string, string>>(); // keyId → (device → member)
  private keyCreated = new Map<string, string>(); // keyId → horloge de création
  private keySuccessor = new Map<string, string>(); // keyId → horloge de création de la clé suivante
  private memberOfDevice = new Map<string, string>();
  private items = new Map<string, Good>();
  private local: Local | null = null;
  private listeners = new Set<() => void>();
  private version = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private cache = new Map<string, unknown>();
  private opened = new Map<string, HeldKey | null>();
  private proofs = new Map<string, boolean>();
  private verified = new Map<string, boolean>();
  /** Calculé au moins une fois. */
  ready = false;

  constructor(
    private replica: Replica,
    readonly identity: Identity,
    private memberId: () => string | null,
    private store: LocalStore,
    private adminKeyring: AdminKeyring,
  ) {
    replica.onChange((cols) => {
      if ([...cols].some((c) => c.startsWith(V2))) this.refresh();
    });
  }

  /* ------------------------------------------------------------ abonnements */

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

  /* ------------------------------------------------------------ stockage local */

  private async loadLocal(): Promise<Local> {
    if (this.local) return this.local;
    const g = <T,>(k: string, d: T) => this.store.get<T>(k).then((v) => v ?? d);
    this.local = {
      secrets: await g(K.secrets, {}),
      pins: await g(K.pins, {}),
      devpins: await g(K.devpins, {}),
      rosters: await g(K.rosters, {}),
      chains: await g(K.chains, {}),
      meta: await g(K.meta, {}),
      hidden: await g(K.hidden, []),
      grants: await g(K.grants, {}),
      lost: await g(K.lost, {}),
      spubs: await g(K.spubs, {}),
      past: await g(K.past, {}),
      vetoes: await g(K.vetoes, []),
    };
    for (const [k, v] of await this.store.entries<Good>(K.item)) {
      const key = k.slice(K.item.length);
      if (v?.d && v.s) this.items.set(key, v);
    }
    return this.local;
  }
  private save(key: keyof Local) {
    return this.store.put(K[key], this.local![key]);
  }

  /** Documents bruts d'une collection v2 (y compris ceux « supprimés » sans signature : ignorés). */
  private raw(name: string): { id: string; s: unknown }[] {
    const c = col(name);
    return this.replica
      .allRecords((r) => r.c === c)
      .map((r) => ({ id: r.id, s: r.f.s?.v }));
  }

  /** Vérifie la signature d'un document écrit par un appareil connu (mise en cache). */
  private async signedBy(name: string, id: string, s: unknown): Promise<boolean> {
    if (!isSigned(s)) return false;
    const ck = `${name}/${id}/${s.sig}`;
    const hit = this.verified.get(ck);
    if (hit !== undefined) return hit;
    const dev = this.devices.get(s.by);
    const ok = !!dev && (await checkDoc(dev.spub, col(name), id, s));
    this.verified.set(ck, ok);
    return ok;
  }

  /** Un document écrit par un appareil déclaré perdu après sa perte ne compte pas. */
  private beforeLoss(device: string, at: string) {
    const t = this.lost.get(device);
    return !t || at < t;
  }

  /* ------------------------------------------------------------ calcul de l'état */

  private async compute() {
    const local = await this.loadLocal();
    const me = this.identity.deviceId;
    const dirty = new Set<keyof Local>();

    // 0. Appareils : l'identifiant est l'empreinte de la clé de signature (voir deviceIdOf) ; gardés une fois vus.
    for (const d of this.raw('devices')) {
      if (local.devpins[d.id]) continue;
      const doc = await checkDeviceDoc(d.id, d.s);
      if (!doc) continue;
      local.devpins[d.id] = { pub: doc.pub, spub: doc.spub };
      dirty.add('devpins');
    }
    // Les clés voyagent aussi avec les autorisations (si le document de l'appareil a été écrasé).
    for (const d of this.raw('keys')) {
      const p = (d.s as Signed<KeyDocP>)?.p;
      if (typeof p?.device !== 'string' || local.devpins[p.device]) continue;
      const doc = await deviceKeysOk(p.device, p.dk);
      if (!doc) continue;
      local.devpins[p.device] = doc;
      dirty.add('devpins');
    }
    this.devices = new Map(Object.entries(local.devpins));

    // 1. Clés reçues : enveloppes signées par l'appareil qui les remet.
    // Une autorisation vue est gardée : un appareil malveillant qui écrase le document ne l'efface pas.
    for (const d of this.raw('keys')) {
      const s = d.s as Signed<KeyDocP>;
      if (!isSigned(s) || (local.grants[d.id] ?? []).some((x) => x.sig === s.sig)) continue;
      if (!(await this.signedBy('keys', d.id, s))) continue;
      const p = s.p;
      if (!p || !isId(p.group) || !isId(p.key) || typeof p.device !== 'string' || typeof p.member !== 'string' || d.id !== `${p.key}${p.device}`) continue;
      local.grants[d.id] = [...(local.grants[d.id] ?? []), s].slice(-4);
      dirty.add('grants');
    }
    const keyDocs: (KeyDocP & { by: string; at: string; id: string; sig: string })[] = [];
    for (const [id, list] of Object.entries(local.grants))
      for (const s of list) if (this.devices.has(s.by) && this.beforeLoss(s.by, s.at)) keyDocs.push({ ...s.p, by: s.by, at: s.at, id, sig: s.sig });
    const held = new Map<string, HeldKey>();
    for (const [keyId, s] of Object.entries(local.secrets)) {
      const known = this.held.get(keyId);
      if (known) {
        held.set(keyId, known);
        continue;
      }
      const secret = fromB64url(s.secret);
      if (secret.length === 32 && (await deriveGroupKeyId(secret)) === keyId) held.set(keyId, await newGroupKey(s.group, s.epoch, secret));
    }
    for (const d of keyDocs) {
      if (d.device !== me || held.has(d.key)) continue;
      const cached = this.opened.get(d.sig);
      const k = cached !== undefined ? cached : await openGroupSecret(this.identity.privateKey, { ...d } as GroupKeyDoc, me);
      this.opened.set(d.sig, k);
      if (k && k.group === d.group) {
        held.set(k.keyId, k);
        local.secrets[k.keyId] = { group: k.group, epoch: k.epoch, secret: b64url(k.secret), by: d.by };
        dirty.add('secrets');
      }
    }
    this.held = held;

    // 2. Pertes déclarées (vérifiées plus bas, une fois les membres connus).
    const lostDocs: { id: string; s: Signed<LostP> }[] = [];
    for (const d of this.raw('lost')) if (await this.signedBy('lost', d.id, d.s)) lostDocs.push({ id: d.id, s: d.s as Signed<LostP> });
    const lostBefore = JSON.stringify(local.lost);

    // 3. Cercles : descriptions (avec la liste des membres signée par l'admin).
    const circleDocs = new Map<string, Signed<CircleDocP>>();
    for (const d of this.raw('circles')) if (isId(d.id) && (await this.signedBy('circles', d.id, d.s))) circleDocs.set(d.id, d.s as Signed<CircleDocP>);
    const reliefDocs = new Map<string, Signed<ReliefDocP>[]>();
    for (const d of this.raw('relief')) {
      if (!(await this.signedBy('relief', d.id, d.s))) continue;
      const s = d.s as Signed<ReliefDocP>;
      const c = s.p?.proposal?.circle;
      if (isId(c)) reliefDocs.set(c, [...(reliefDocs.get(c) ?? []), s]);
    }

    const byGroup = new Map<string, HeldKey[]>();
    for (const k of held.values()) byGroup.set(k.group, [...(byGroup.get(k.group) ?? []), k]);

    // Pour chaque cercle dont on a au moins une clé : description, liste des membres, autorisés.
    this.memberOfDevice = new Map();
    this.keyHolders = new Map();
    this.keyCreated = new Map();
    this.keySuccessor = new Map();
    const state = new Map<string, Resolved>();
    const rosters = new Map<string, Roster>();
    const info = new Map<string, CircleInfo>();
    const now = Date.now();
    // Les membres d'appareils, connus via les autorisations, servent à vérifier les relèves.
    const lookup: DeviceLookup = (device: string) => {
      const pin = this.devices.get(device);
      return pin ? { member: this.memberOfDevice.get(device) ?? null, spub: pin.spub } : null;
    };

    for (const [group, keys] of byGroup) {
      // a. Description : lisible avec n'importe quelle clé détenue du cercle.
      const doc = circleDocs.get(group);
      let meta: MetaPlain | null = null;
      if (doc && held.has(doc.p?.mk)) {
        try {
          const m = await openJSON<MetaPlain>(held.get(doc.p.mk)!.key, doc.p.meta, `circle-meta:${group}`);
          if (m && typeof m.name === 'string') meta = m;
        } catch {
          /* illisible : on garde la dernière valable */
        }
      }
      // b. Liste des membres : on accumule toutes les versions vues, la chaîne de signatures décide.
      const chain = local.chains[group] ?? [];
      for (const sr of [...(meta?.rosters ?? []), ...(reliefDocs.get(group) ?? []).map((r) => r.p.roster).filter((x): x is SignedRoster => !!x)]) {
        if (sr?.r && !chain.some((c) => c.sig === sr.sig)) {
          chain.push(sr);
          local.chains[group] = chain;
          dirty.add('chains');
        }
      }
      // Une opposition doit être signée par la clé d'admin remplacée ; une fois vue, elle est gardée.
      const vetoed = async (prev: Roster, p: ReliefProposal) => {
        const key = canonical(p);
        if (local.vetoes.includes(key)) return true;
        for (const r of reliefDocs.get(group) ?? []) {
          if (typeof r.p.veto !== 'string' || canonical(r.p.proposal) !== key || !(await checkVeto(prev.spub, p, r.p.veto))) continue;
          local.vetoes.push(key);
          dirty.add('vetoes');
          return true;
        }
        return false;
      };
      const docs = keyDocs.filter((d) => d.group === group);
      const sorted = [...keys].sort((a, b) => a.epoch - b.epoch);
      // D'abord sans relève (il faut savoir qui sont les membres votants), puis avec.
      let path = await latestRoster(group, chain, local.rosters[group] ?? null, () => null, now, vetoed);
      if (!path) continue;
      let roster = path[path.length - 1];
      const known = (r: Roster) => {
        const spubs = local.spubs[group] ?? [];
        if (!spubs.some((x) => jwkId(x) === jwkId(r.spub))) {
          local.spubs[group] = [...spubs, r.spub];
          dirty.add('spubs');
        }
        const past = local.past[group] ?? [];
        const added = r.members.filter((m) => !past.includes(m));
        if (added.length) {
          local.past[group] = [...past, ...added];
          dirty.add('past');
        }
      };
      path.forEach(known);
      await this.holdersOf(sorted, roster, docs, local);
      path = await latestRoster(group, chain, roster, lookup, now, vetoed);
      if (path && path.length > 1) {
        path.forEach(known);
        roster = path[path.length - 1];
        await this.holdersOf(sorted, roster, docs, local);
      }
      if (local.rosters[group]?.v !== roster.v) {
        local.rosters[group] = roster;
        dirty.add('rosters');
      }
      rosters.set(group, roster);

      // c. Clé en vigueur.
      const knowers = new Map<string, Set<string>>();
      for (const [keyId, s] of Object.entries(local.secrets)) if (s.by) knowers.set(keyId, new Set([s.by]));
      const pin = local.pins[group] ?? sorted.find((k) => this.keyHolders.get(k.keyId)?.has(me))?.keyId;
      const r = await resolveCurrent(keys, docs.map((d) => ({ ...d }) as GroupKeyDoc), pin, this.proofs, knowers);
      if (r.pinned && local.pins[group] !== r.pinned.keyId) {
        local.pins[group] = r.pinned.keyId;
        dirty.add('pins');
      }
      // On n'écrit qu'avec une clé dont on est un autorisé valable.
      if (r.current && !this.keyHolders.get(r.current.keyId)?.has(me)) r.current = null;
      state.set(group, r);

      // d. Description valable : écrite par un autorisé avec la clé en vigueur ; sinon la dernière gardée.
      const cur = r.current ?? r.pinned;
      let good = local.meta[group];
      if (meta && doc && cur && doc.p.mk === cur.keyId && this.keyHolders.get(cur.keyId)?.has(doc.by) && this.beforeLoss(doc.by, doc.at)) {
        const deleting = meta.x === 1;
        const writer = this.keyHolders.get(cur.keyId)!.get(doc.by);
        if (!deleting || writer === roster.admin) {
          const next = { name: meta.name, color: typeof meta.color === 'string' ? meta.color : '#8E5CE6', ...(meta.personal ? { personal: meta.personal } : {}), ...(deleting ? { x: 1 as const } : {}) };
          if (JSON.stringify(next) !== JSON.stringify(good)) {
            local.meta[group] = next;
            good = next;
            dirty.add('meta');
          }
        }
      }
      if (!good || good.x) continue;
      // Remplacée ? Une clé suivante, liée à la nôtre, existe et nous ne l'avons pas.
      let outdated = false;
      if (cur) {
        for (const d of docs) {
          if (d.epoch !== cur.epoch + 1 || held.has(d.key)) continue;
          for (const l of d.links ?? []) if (l?.pk === cur.keyId && (await checkLink(cur, { keyId: d.key, epoch: d.epoch }, l.link))) outdated = true;
        }
      }
      const myMember = this.memberId();
      info.set(group, {
        id: group,
        name: good.name,
        color: good.color,
        personal: good.personal,
        members: roster.members,
        admin: roster.admin,
        isAdmin: !!myMember && roster.admin === myMember,
        rosterV: roster.v,
        adminKey: { spub: roster.spub, wrapped: roster.wrapped },
        writable: !!r.current && !outdated,
        conflict: !!r.conflict,
        outdated,
      });
    }

    // 4. Pertes valables : déclarées par un appareil du même membre, ou par l'admin d'un cercle de ce membre.
    //    Une déclaration vue est gardée ; seul un AUTRE appareil (non perdu) peut rendre l'accès, plus tard.
    //    Une déclaration faite par un appareil APRÈS sa propre perte ne compte pas : sinon un téléphone volé
    //    pourrait déclarer perdus tous les autres appareils de son membre (ou de ses cercles, s'il est admin).
    //    Traitées dans l'ordre de l'horloge, pour que la plus ancienne des deux déclarations croisées l'emporte.
    lostDocs.sort((a, b) => (a.s.at < b.s.at ? -1 : a.s.at > b.s.at ? 1 : 0));
    const lostBy = (device: string, at: string) => {
      const l = local.lost[device];
      return !!l && l.at <= at;
    };
    for (const { id, s } of lostDocs) {
      if (s.p?.device !== id) continue;
      const author = this.memberOfDevice.get(s.by);
      const target = this.memberOfDevice.get(id);
      if (!author || !target) continue;
      const allowed = author === target || [...rosters.values()].some((r) => r.admin === author && r.members.includes(target));
      if (!allowed) continue;
      if (s.by !== id && lostBy(s.by, s.at)) continue;
      const cur = local.lost[id];
      if (s.p.lost && !cur) local.lost[id] = { at: s.at, by: s.by, s };
      else if (!s.p.lost && cur && s.by !== id && s.at > cur.at && !local.lost[s.by]) delete local.lost[id];
    }
    // Déclarations gardées d'un tour précédent, mais faites par un appareil déjà perdu à ce moment-là.
    for (let changed = true; changed; ) {
      changed = false;
      for (const [id, v] of Object.entries(local.lost)) {
        if (v.by !== id && lostBy(v.by, v.at)) {
          delete local.lost[id];
          changed = true;
        }
      }
    }
    if (JSON.stringify(local.lost) !== lostBefore) {
      dirty.add('lost');
      // Les autorisations dépendent des pertes : on recalcule une fois de plus.
      this.again = true;
    }
    this.lost = new Map(Object.entries(local.lost).map(([d, v]) => [d, v.at]));
    // Déclaration écrasée dans la réplique (par l'appareil perdu lui-même, ou par un document illisible) :
    // les appareils qui ne l'ont pas encore vue (hors ligne, nouveaux) ne sauraient jamais qu'il est perdu.
    // On republie la déclaration signée d'origine (valable telle quelle, quel que soit l'appareil qui la renvoie).
    const republish: Signed<LostP>[] = [];
    const rawLost = new Map(this.raw('lost').map((d) => [d.id, d.s]));
    for (const [id, v] of Object.entries(local.lost)) {
      if (!v.s) continue;
      const cur = rawLost.get(id);
      if (isSigned(cur) && cur.sig === v.s.sig) continue;
      let bad: boolean;
      if (!isSigned(cur)) bad = true;
      else if ((cur.p as LostP | undefined)?.lost === true) bad = false;
      else bad = cur.by === id || lostBy(cur.by, cur.at) || !(await this.signedBy('lost', id, cur));
      if (bad) republish.push(v.s);
    }

    this.state = state;
    this.rosters = rosters;
    this.circleInfo = info;

    // 5. Éléments.
    await this.computeItems();

    for (const k of dirty) await this.save(k);
    this.ready = true;
    this.emit();
    for (const s of republish) await this.replica.upsert(col('lost'), s.p.device, { s });
  }

  /**
   * Autorisés d'une clé (appareil → membre). Une autorisation (enveloppe signée par S pour l'appareil D du
   * membre M) est valable si M est dans la liste des membres et :
   *  - l'admin l'a validée (signature de la clé d'administration) ; ou
   *  - S est déjà un autorisé du MÊME membre M (un membre approuve son propre nouvel appareil) ; ou
   *  - c'est un renouvellement : D et S étaient autorisés pour la clé précédente, D comme membre M.
   * La preuve faite avec la clé montre que S la connaît.
   */
  private async holdersOf(sorted: HeldKey[], roster: Roster, docs: (KeyDocP & { by: string; at: string })[], local: Local) {
    const spubs = local.spubs[roster.circle] ?? [roster.spub];
    const past = local.past[roster.circle] ?? roster.members;
    for (const k of sorted) await this.computeHolders(k, docs, spubs, past);
    // La clé la plus récente (sans clé suivante) : seulement les membres ACTUELS.
    for (const k of sorted) {
      if (this.keySuccessor.has(k.keyId)) continue;
      const h = this.keyHolders.get(k.keyId);
      for (const [d, m] of h ?? []) if (!roster.members.includes(m)) h!.delete(d);
    }
  }

  private async computeHolders(k: HeldKey, docs: (KeyDocP & { by: string; at: string })[], spubs: JsonWebKey[], past: string[]) {
    // Membres passés compris : ce qu'un membre exclu a écrit AVANT son exclusion reste valable.
    const grants = docs.filter((d) => d.key === k.keyId && past.includes(d.member) && this.devices.has(d.device));
    const prevHolders = new Map<string, string>();
    for (const g of grants) {
      for (const l of g.links ?? []) {
        const prev = this.held.get(l.pk);
        if (!prev || !(await checkLink(prev, k, l.link))) continue;
        for (const [dev, m] of this.keyHolders.get(prev.keyId) ?? []) prevHolders.set(dev, m);
        // Horloge de création de cette clé = celle de l'enveloppe la plus ancienne qui la lie.
        const t = this.keyCreated.get(k.keyId);
        if (!t || g.at < t) this.keyCreated.set(k.keyId, g.at);
        const succ = this.keySuccessor.get(prev.keyId);
        if (!succ || g.at < succ) this.keySuccessor.set(prev.keyId, g.at);
      }
    }
    const holders = new Map<string, string>();
    const proofOk = async (g: { device: string; proof: string }) => {
      const ck = `${k.keyId}|${g.device}|${g.proof}`;
      let ok = this.proofs.get(ck);
      if (ok === undefined) {
        ok = await checkProof(k, g.device, g.proof);
        this.proofs.set(ck, ok);
      }
      return ok;
    };
    let changed = true;
    while (changed) {
      changed = false;
      for (const g of grants) {
        if (holders.has(g.device)) continue;
        if (!(await proofOk(g))) continue;
        const adm: Admission = { circle: k.group, key: k.keyId, device: g.device, member: g.member };
        const ok =
          (g.asig !== undefined && (await this.admitted(spubs, adm, g.asig))) ||
          holders.get(g.by) === g.member ||
          (prevHolders.get(g.device) === g.member && prevHolders.has(g.by));
        if (!ok) continue;
        // Un appareil n'appartient qu'à un seul membre.
        const known = this.memberOfDevice.get(g.device);
        if (known && known !== g.member) continue;
        holders.set(g.device, g.member);
        this.memberOfDevice.set(g.device, g.member);
        changed = true;
      }
    }
    if (!this.keyCreated.has(k.keyId)) {
      const first = grants.filter((g) => holders.has(g.device)).sort((a, b) => (a.at < b.at ? -1 : 1))[0];
      if (first) this.keyCreated.set(k.keyId, first.at);
    }
    this.keyHolders.set(k.keyId, holders);
  }

  /** Validation par une des clés d'administration successives du cercle (mise en cache). */
  private async admitted(spubs: JsonWebKey[], a: Admission, sig: string) {
    for (const spub of spubs) {
      const ck = `${jwkId(spub)}|${canonical(a)}|${sig}`;
      let ok = this.verified.get(ck);
      if (ok === undefined) this.verified.set(ck, (ok = await checkAdmission(spub, a, sig)));
      if (ok) return true;
    }
    return false;
  }

  /** Éléments : nouvelle version acceptée si signée par un autorisé, permise par les règles, et plus récente. */
  private async computeItems() {
    const usable = new Map([...this.held].filter(([, k]) => this.state.has(k.group)));
    const seen = new Set<string>();
    for (const name of ITEM_COLLECTIONS) {
      for (const d of this.raw(name)) {
        const key = pkey(name, d.id);
        seen.add(key);
        const good = this.items.get(key);
        if (!isSigned(d.s) || good?.s.sig === d.s.sig) continue;
        const s = d.s as Signed<{ box: PrivateBox }>;
        if (good && s.at <= good.s.at) continue;
        if (!this.beforeLoss(s.by, s.at)) continue;
        if (!(await this.signedBy(name, d.id, s))) continue;
        const payload = await openPrivate<ItemPayload>(name, d.id, s.p?.box, usable);
        if (!payloadShapeOk(payload)) continue;
        // L'auteur doit être autorisé, comme membre M, pour une clé qui emballe l'élément, dans un de ses cercles
        // (et, si cette clé a été remplacée depuis, l'élément doit dater d'avant).
        let author: string | null = null;
        for (const keyId of Object.keys(s.p.box.w ?? {})) {
          const k = usable.get(keyId);
          if (!k || !payload.g.includes(k.group)) continue;
          const m = this.keyHolders.get(keyId)?.get(s.by);
          if (!m) continue;
          const succ = this.keySuccessor.get(keyId);
          if (succ && s.at >= succ) continue;
          author = m;
          break;
        }
        if (!author) continue;
        if (!canWrite(name, good?.d ?? null, payload, author)) continue;
        const next: Good = { s, d: payload, c: name, i: d.id };
        this.items.set(key, next);
        await this.store.put(K.item + key, next);
      }
    }
  }

  /* ------------------------------------------------------------ lecture */

  private cached<T>(key: string, build: () => T): T {
    if (!this.cache.has(key)) this.cache.set(key, build());
    return this.cache.get(key) as T;
  }

  /** Cercles lisibles par cet appareil (« Moi seul » en premier). */
  circles(): CircleInfo[] {
    return this.cached('circles', () =>
      [...this.circleInfo.values()].sort((a, b) => (a.personal ? 0 : 1) - (b.personal ? 0 : 1) || a.name.localeCompare(b.name)),
    );
  }
  circle(id: string): CircleInfo | undefined {
    return this.circleInfo.get(id);
  }

  /** Éléments lisibles d'une collection (sans ceux supprimés, ni ceux masqués « pour moi »). */
  list<T>(name: string): Item<T>[] {
    return this.cached(`list:${name}`, () => {
      const hidden = new Set(this.local?.hidden ?? []);
      const out: Item<T>[] = [];
      for (const [key, g] of this.items) {
        if (g.c !== name || g.d.x || hidden.has(key)) continue;
        out.push(this.toItem<T>(g));
      }
      out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
      return out;
    });
  }

  get<T>(name: string, id: string): Item<T> | undefined {
    const g = this.items.get(pkey(name, id));
    if (!g || g.d.x || this.local?.hidden.includes(pkey(name, id))) return undefined;
    return this.toItem<T>(g);
  }

  private toItem<T>(g: Good): Item<T> {
    const base = toDoc<T>({ id: g.i, c: g.c, f: { _: { v: 0, t: g.s.at } }, ct: g.d.t0, cb: g.d.o, cbt: g.d.t0 });
    return { ...(g.d.d as T), id: base.id, createdAt: base.createdAt, updatedAt: base.updatedAt, groups: g.d.g, owner: g.d.o, createdBy: g.d.o } as Item<T>;
  }

  /** Membre d'un appareil (d'après ses autorisations dans les cercles lisibles ici). */
  memberOf(device: string): string | null {
    return this.memberOfDevice.get(device) ?? null;
  }

  /** Appareils autorisés dans un cercle (clé en vigueur), hors appareils perdus : appareil → membre. */
  holders(circle: string): Map<string, string> {
    const k = this.state.get(circle)?.current ?? this.state.get(circle)?.pinned;
    const out = new Map<string, string>();
    for (const [d, m] of (k && this.keyHolders.get(k.keyId)) ?? []) if (!this.lost.has(d)) out.set(d, m);
    return out;
  }

  /** Appareil autorisé AUJOURD'HUI dans au moins un de mes cercles (membre actuel, appareil non perdu). */
  isActive(device: string): boolean {
    for (const c of this.circleInfo.keys()) if (this.holders(c).has(device)) return true;
    return false;
  }

  /**
   * Appareils qui ont eu accès à un cercle mais ne l'ont plus (membre exclu, appareil perdu) : leurs rappels
   * planifiés pour ce cercle doivent être effacés du relais.
   */
  formerHolders(circle: string): string[] {
    const cur = this.holders(circle);
    const out = new Set<string>();
    for (const k of this.chainOf(circle)) for (const d of this.keyHolders.get(k.keyId)?.keys() ?? []) if (!cur.has(d)) out.add(d);
    return [...out];
  }

  /** Appareils de membres de mes cercles (pour l'écran Cercles). */
  knownDevices(): { id: string; member: string; lost: boolean }[] {
    return [...this.memberOfDevice].map(([id, member]) => ({ id, member, lost: this.lost.has(id) }));
  }

  /** Membres qui voient au moins un des cercles donnés. */
  membersOf(circles: string[]): Set<string> {
    const out = new Set<string>();
    for (const c of circles) for (const m of this.rosters.get(c)?.members ?? []) out.add(m);
    return out;
  }

  /** Cet appareil peut-il modifier ces champs de l'élément (ou le supprimer pour tous si `remove`) ? */
  canEdit(name: string, id: string, fields?: string[], remove = false): boolean {
    const g = this.items.get(pkey(name, id));
    const me = this.memberId();
    if (!g || !me) return false;
    if (g.d.o === me) return true;
    if (remove) return false;
    const rule = ruleOf(name);
    if (rule === 'all') return true;
    if (rule === 'owner') return false;
    return !!fields && fields.every((f) => rule.includes(f));
  }

  /** Signature d'un document v2 par un appareil connu (pour les documents hors coffre : déménagement…). */
  checkSigned(name: string, id: string, s: unknown): Promise<boolean> {
    return this.signedBy(name, id, s);
  }

  /** Clés publiques d'un appareil reçues directement (demande d'entrée) : vérifiées par son identifiant. */
  async pinDevice(id: string, keys: unknown): Promise<boolean> {
    const doc = await deviceKeysOk(id, keys);
    if (!doc) return false;
    const local = await this.loadLocal();
    if (!local.devpins[id]) {
      local.devpins[id] = doc;
      await this.save('devpins');
    }
    this.devices.set(id, local.devpins[id]);
    return true;
  }

  /** Tous les appareils connus (clés vérifiées). */
  allDevices(): [string, DeviceDoc][] {
    return [...this.devices];
  }

  /** Clés publiques épinglées d'un appareil. */
  deviceKeys(id: string): DeviceDoc | undefined {
    return this.devices.get(id);
  }

  /* ------------------------------------------------------------ écriture */

  private now() {
    return this.replica.clock.now();
  }

  private async put<T>(name: string, id: string, p: T) {
    const s = await signDoc(this.identity.signKey, col(name), id, this.identity.deviceId, this.now(), p);
    await this.replica.upsert(col(name), id, { s });
    return s;
  }

  /** Publie (ou republie) le document de cet appareil : ses deux clés publiques, rien d'autre. */
  async publishDevice() {
    const id = this.identity.deviceId;
    const cur = this.raw('devices').find((d) => d.id === id);
    if (cur && (await checkDeviceDoc(id, cur.s))) return;
    await this.put<DeviceDoc>('devices', id, { pub: this.identity.publicJwk, spub: this.identity.signJwk });
    await this.refresh();
  }

  private currentKey(circle: string): HeldKey | null {
    const c = this.circleInfo.get(circle);
    if (!c || !c.writable) return null;
    return this.state.get(circle)?.current ?? null;
  }

  /** Cercles où ranger un nouvel élément par défaut (réglage de l'appareil, sinon le premier cercle partagé). */
  defaultCircles: () => string[] = () => {
    const shared = this.circles().find((c) => !c.personal && c.writable);
    const mine = this.circles().find((c) => c.personal && c.writable);
    return [(shared ?? mine)?.id].filter((x): x is string => !!x);
  };

  /** Enregistre une version d'un élément (chiffrée pour ses cercles, signée). */
  private async write(name: string, id: string, payload: ItemPayload) {
    const keys: HeldKey[] = [];
    const foreign: string[] = [];
    for (const g of payload.g) {
      const k = this.currentKey(g);
      if (k) keys.push(k);
      else foreign.push(g);
    }
    const prev = this.items.get(pkey(name, id));
    const keep: Record<string, string> = {};
    if (foreign.length) {
      // Cercle dont cet appareil n'a pas la clé : on garde son enveloppe (et la clé de l'élément).
      for (const [keyId, wrapped] of Object.entries(prev?.s.p.box.w ?? {})) {
        const owner = this.groupOfKey(keyId);
        if (owner && foreign.includes(owner) && !keys.some((k) => k.group === owner)) keep[keyId] = wrapped;
      }
      if (!keys.length && !Object.keys(keep).length) throw new Error("Cet appareil n'a pas accès à ce cercle");
      if (Object.keys(keep).length < foreign.length) throw new Error("Cet appareil n'a pas accès à l'un des cercles choisis");
    }
    const box = await sealPrivate(name, id, payload, keys, { keep, previous: prev?.s.p.box, held: this.held });
    const s = await this.put(name, id, { box });
    const g: Good = { s, d: payload, c: name, i: id };
    this.items.set(pkey(name, id), g);
    await this.store.put(K.item + pkey(name, id), g);
    this.emit();
  }

  private groupOfKey(keyId: string): string | null {
    const s = this.local?.secrets[keyId];
    if (s) return s.group;
    for (const d of this.raw('keys')) {
      const p = (d.s as Signed<KeyDocP>)?.p;
      if (p?.key === keyId) return p.group;
    }
    return null;
  }

  /** `t0` : date de création d'origine (reprise des données de l'ancien format). */
  async create<T extends object>(name: string, data: T, opts: { groups?: string[]; id?: string; t0?: string } = {}): Promise<Item<T>> {
    const me = this.memberId();
    if (!me) throw new Error('Profil inconnu');
    const groups = [...new Set(opts.groups?.length ? opts.groups : this.defaultCircles())];
    if (!groups.length) throw new Error('Aucun cercle où enregistrer');
    const id = opts.id ?? randomId();
    await this.write(name, id, { g: groups, o: me, t0: opts.t0 ?? this.now(), d: clean(data) });
    return this.get<T>(name, id)!;
  }

  async update<T extends object>(name: string, id: string, patch: Partial<T>, groups?: string[]) {
    const prev = this.items.get(pkey(name, id));
    const me = this.memberId();
    if (!prev || prev.d.x || !me) throw new Error('Élément introuvable');
    const next: ItemPayload = { ...prev.d, g: groups?.length ? [...new Set(groups)] : prev.d.g, d: { ...prev.d.d, ...clean(patch) } };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next.d[k];
    if (!canWrite(name, prev.d, next, me)) throw new Error("Vous ne pouvez pas modifier cet élément : seul son auteur le peut");
    await this.write(name, id, next);
  }

  /** Crée ou met à jour un élément dont l'identifiant est connu (profil, préférences…). */
  async upsert<T extends object>(name: string, id: string, patch: Partial<T>, groups?: string[]) {
    if (this.items.get(pkey(name, id)) && !this.items.get(pkey(name, id))!.d.x) await this.update(name, id, patch, groups);
    else await this.create(name, patch as T, { id, groups });
  }

  /**
   * Supprimer : pour tout le monde si on est le propriétaire (marque de suppression chiffrée et signée),
   * sinon seulement pour soi (l'élément est masqué sur cet appareil).
   */
  async remove(name: string, id: string): Promise<'all' | 'me'> {
    const prev = this.items.get(pkey(name, id));
    const me = this.memberId();
    if (!prev || !me) return 'me';
    if (prev.d.o === me) {
      await this.write(name, id, { ...prev.d, d: {}, x: 1 });
      return 'all';
    }
    await this.hide(name, id);
    return 'me';
  }

  async hide(name: string, id: string) {
    const local = await this.loadLocal();
    if (!local.hidden.includes(pkey(name, id))) local.hidden.push(pkey(name, id));
    await this.save('hidden');
    this.emit();
  }

  /* ------------------------------------------------------------ clés des cercles */

  /** Remet une clé à un appareil : enveloppe pour sa clé publique ÉPINGLÉE + preuve + liens + validation admin. */
  private async grantKey(k: HeldKey, device: string, member: string, opts: { links?: { pk: string; link: string }[]; admin?: CryptoKey } = {}) {
    const pin = this.devices.get(device);
    if (!pin || this.lost.has(device)) return;
    const p: KeyDocP = {
      group: k.group,
      key: k.keyId,
      epoch: k.epoch,
      device,
      member,
      env: await sealGroupSecret(pin.pub, k.secret, k.group, k.keyId, k.epoch, device),
      proof: await grantProof(k, device),
      dk: { pub: pin.pub, spub: pin.spub },
      ...(opts.links?.length ? { links: opts.links } : {}),
      ...(opts.admin ? { asig: await signAdmission(opts.admin, { circle: k.group, key: k.keyId, device, member }) } : {}),
    };
    await this.put('keys', `${k.keyId}${device}`, p);
  }

  private async keepKey(k: HeldKey, pin: boolean) {
    const local = await this.loadLocal();
    this.held.set(k.keyId, k);
    local.secrets[k.keyId] = { group: k.group, epoch: k.epoch, secret: b64url(k.secret), by: this.identity.deviceId };
    await this.save('secrets');
    if (pin) {
      local.pins[k.group] = k.keyId;
      await this.save('pins');
    }
  }

  /** Toutes les clés détenues d'un cercle, de la plus ancienne à la plus récente. */
  private chainOf(circle: string): HeldKey[] {
    return [...this.held.values()].filter((k) => k.group === circle).sort((a, b) => a.epoch - b.epoch);
  }

  private async writeMeta(circle: string, k: HeldKey, meta: MetaPlain) {
    const sealed = await sealJSON(k.key, meta, `circle-meta:${circle}`);
    await this.put<CircleDocP>('circles', circle, { mk: k.keyId, meta: sealed });
  }

  private chain(circle: string): SignedRoster[] {
    return this.local?.chains[circle] ?? [];
  }

  /**
   * Crée un cercle dont ce membre est l'admin. `members` : membres de départ (leurs appareils seront
   * autorisés ensuite, par validation de l'admin).
   */
  async createCircle(meta: { name: string; color: string; personal?: string }, id = randomId(), members?: string[]): Promise<string> {
    const me = this.memberId();
    if (!me) throw new Error('Profil inconnu');
    const admin = await this.adminKeyring.get();
    if (!admin) throw new Error("Clé d'administration indisponible");
    const k = await newGroupKey(id, 0, newSecret());
    await this.keepKey(k, true);
    const roster: Roster = { circle: id, v: 1, members: [...new Set([me, ...(members ?? [])])], admin: me, spub: admin.spub, wrapped: admin.wrapped };
    const sr = await signRoster(admin.key, roster);
    const local = await this.loadLocal();
    local.chains[id] = [sr];
    local.rosters[id] = roster;
    await this.save('chains');
    await this.save('rosters');
    await this.grantKey(k, this.identity.deviceId, me, { admin: admin.key });
    await this.writeMeta(id, k, { ...meta, rosters: [sr] });
    await this.refresh();
    return id;
  }

  /** Renomme ou recolore un cercle (tout membre). */
  async updateCircle(id: string, patch: { name?: string; color?: string }) {
    const c = this.circleInfo.get(id);
    const k = this.currentKey(id);
    if (!c || !k) throw new Error("Cet appareil n'a pas accès à ce cercle");
    await this.writeMeta(id, k, { name: patch.name ?? c.name, color: patch.color ?? c.color, ...(c.personal ? { personal: c.personal } : {}), rosters: this.chain(id) });
    await this.refresh();
  }

  /** Nouvelle clé (époque suivante), liée aux précédentes, remise aux appareils indiqués (+ celui-ci). */
  private async renewKey(circle: string, keep: Map<string, string>, admin?: CryptoKey): Promise<HeldKey> {
    const r = this.state.get(circle);
    const prevs = r?.conflict ? r.conflict.map((c) => c.key) : [r?.current ?? r?.pinned].filter((x): x is HeldKey => !!x);
    if (!prevs.length) throw new Error("Cet appareil n'a pas accès à ce cercle");
    const epoch = Math.max(...prevs.map((p) => p.epoch)) + 1;
    const k = await newGroupKey(circle, epoch, newSecret());
    const links: { pk: string; link: string }[] = [];
    for (const p of prevs) if (p.epoch === epoch - 1) links.push({ pk: p.keyId, link: await keyLink(p, k) });
    await this.keepKey(k, true);
    const me = this.identity.deviceId;
    const myMember = this.memberId()!;
    await this.grantKey(k, me, myMember, { links, admin });
    for (const [device, member] of keep) if (device !== me) await this.grantKey(k, device, member, { links, admin });
    return k;
  }

  /** Publie une nouvelle version signée de la liste des membres (admin seulement). */
  private async publishRoster(circle: string, change: (r: Roster) => Roster, signer?: CryptoKey) {
    const cur = this.rosters.get(circle);
    if (!cur) throw new Error('Cercle introuvable');
    const admin = await this.adminKeyring.get();
    if (!admin || jwkId(admin.spub) !== jwkId(cur.spub)) throw new Error("Seul l'admin du cercle peut faire cela");
    const next = { ...change(cur), circle, v: cur.v + 1 };
    const sr = await signRoster(signer ?? admin.key, next);
    const local = await this.loadLocal();
    local.chains[circle] = [...(local.chains[circle] ?? []), sr];
    local.rosters[circle] = next;
    await this.save('chains');
    await this.save('rosters');
    this.rosters.set(circle, next);
    return { roster: next, admin };
  }

  /**
   * Admin : fait entrer un membre (et son appareil) dans un cercle. Toutes les clés du cercle lui sont remises
   * (pour lire aussi ce qui a été écrit avant), chacune validée par la clé d'administration.
   */
  async admit(circle: string, member: string, device: string) {
    const c = this.circleInfo.get(circle);
    if (!c) throw new Error('Cercle introuvable');
    let admin: AdminKeys | null;
    if (!c.members.includes(member)) admin = (await this.publishRoster(circle, (r) => ({ ...r, members: [...r.members, member] }))).admin;
    else admin = await this.adminKeyring.get();
    if (!admin || !c.isAdmin) throw new Error("Seul l'admin du cercle peut faire entrer quelqu'un");
    for (const k of this.chainOf(circle)) await this.grantKey(k, device, member, { admin: admin.key });
    const k = this.currentKey(circle);
    if (k) await this.writeMeta(circle, k, { name: c.name, color: c.color, ...(c.personal ? { personal: c.personal } : {}), rosters: this.chain(circle) });
    await this.refresh();
  }

  /** Un membre approuve son propre nouvel appareil : toutes les clés de tous ses cercles lui sont remises. */
  async approveOwnDevice(device: string) {
    const me = this.memberId();
    if (!me) throw new Error('Profil inconnu');
    for (const c of this.circles()) {
      if (!c.members.includes(me)) continue;
      for (const k of this.chainOf(c.id)) if (this.keyHolders.get(k.keyId)?.get(this.identity.deviceId) === me) await this.grantKey(k, device, me);
    }
    await this.refresh();
  }

  /** Admin : exclut un membre. Nouvelle clé, remise aux seuls appareils restants. */
  async exclude(circle: string, member: string) {
    const c = this.circleInfo.get(circle);
    if (!c || !c.isAdmin) throw new Error("Seul l'admin du cercle peut exclure quelqu'un");
    if (member === c.admin) throw new Error("L'admin ne peut pas s'exclure : transmettez d'abord le rôle");
    const { admin } = await this.publishRoster(circle, (r) => ({ ...r, members: r.members.filter((m) => m !== member) }));
    const keep = new Map([...this.holders(circle)].filter(([, m]) => m !== member));
    const k = await this.renewKey(circle, keep, admin.key);
    await this.writeMeta(circle, k, { name: c.name, color: c.color, ...(c.personal ? { personal: c.personal } : {}), rosters: this.chain(circle) });
    await this.refresh();
  }

  /**
   * Admin : transmet le rôle à un autre membre. La nouvelle liste nomme sa clé d'administration (publiée dans
   * son profil), signée par l'ancienne clé, qui ne sera plus acceptée ensuite.
   */
  async transferAdmin(circle: string, member: string, spub: JsonWebKey, wrapped: string) {
    const c = this.circleInfo.get(circle);
    if (!c || !c.isAdmin || !c.members.includes(member)) throw new Error('Transmission impossible');
    await this.publishRoster(circle, (r) => ({ ...r, admin: member, spub, wrapped }));
    const k = this.currentKey(circle);
    if (k) await this.writeMeta(circle, k, { name: c.name, color: c.color, ...(c.personal ? { personal: c.personal } : {}), rosters: this.chain(circle) });
    await this.refresh();
  }

  /** Renouvelle la clé (conflit, appareil perdu) : remise aux appareils autorisés restants. */
  async renew(circle: string) {
    const c = this.circleInfo.get(circle);
    const r = this.state.get(circle);
    if (!c || !r) throw new Error("Cet appareil n'a pas accès à ce cercle");
    let keep: Map<string, string>;
    if (r.conflict) {
      // Seuls les appareils autorisés pour TOUTES les clés concurrentes.
      const sets = r.conflict.map((x) => this.keyHolders.get(x.key.keyId) ?? new Map<string, string>());
      keep = new Map([...sets[0]].filter(([d]) => sets.every((s) => s.has(d))));
    } else keep = this.holders(circle);
    for (const d of this.lost.keys()) keep.delete(d);
    const k = await this.renewKey(circle, keep);
    await this.writeMeta(circle, k, { name: c.name, color: c.color, ...(c.personal ? { personal: c.personal } : {}), rosters: this.chain(circle) });
    await this.refresh();
  }

  /** Supprime un cercle (admin seulement, suppression chiffrée). */
  async deleteCircle(circle: string) {
    const c = this.circleInfo.get(circle);
    const k = this.currentKey(circle);
    if (!c || !k || !c.isAdmin || c.personal) throw new Error('Ce cercle ne peut pas être supprimé');
    if (this.usage(circle)) throw new Error("Ce cercle contient encore des éléments : déplacez-les ou supprimez-les d'abord");
    await this.writeMeta(circle, k, { name: c.name, color: c.color, rosters: this.chain(circle), x: 1 });
    await this.refresh();
  }

  usage(circle: string): number {
    let n = 0;
    for (const g of this.items.values()) if (!g.d.x && g.d.g.includes(circle)) n++;
    return n;
  }

  /* ------------------------------------------------------------ appareils perdus */

  /** Déclare un appareil perdu (le sien, ou celui d'un membre de ses cercles si on en est l'admin). */
  async declareLost(device: string, lost = true) {
    await this.put<LostP>('lost', device, { device, lost });
    await this.refresh();
    // Retrouvé : les clés renouvelées entre-temps lui sont remises (par son membre, ou par l'admin).
    if (!lost) {
      const member = this.memberOf(device);
      if (member && member === this.memberId()) await this.approveOwnDevice(device);
      else if (member) for (const c of this.circles()) if (c.isAdmin && c.members.includes(member)) await this.admit(c.id, member, device);
    }
    // L'appareil perdu ne doit plus rien lire de nouveau : nouvelle clé dans les cercles où il était autorisé.
    if (lost)
      for (const c of this.circles()) {
        const k = this.state.get(c.id)?.current;
        if (c.writable && k && this.keyHolders.get(k.keyId)?.has(device)) await this.renew(c.id);
      }
  }
  isLost(device: string) {
    return this.lost.has(device);
  }

  /* ------------------------------------------------------------ relève */

  /** Propose un nouvel admin (le membre de cet appareil, avec sa clé d'administration). */
  async proposeRelief(circle: string): Promise<void> {
    const roster = this.rosters.get(circle);
    const me = this.memberId();
    const admin = await this.adminKeyring.get();
    if (!roster || !me || !admin || roster.admin === me) throw new Error('Relève impossible');
    const proposal: ReliefProposal = { circle, from: roster.v, candidate: me, spub: admin.spub, at: Date.now() };
    await this.put<ReliefDocP>('relief', `${circle}${me}`, { proposal, votes: [] });
    await this.refresh();
  }

  /** Les propositions de relève en cours dans un cercle. */
  reliefs(circle: string): { id: string; proposal: ReliefProposal; votes: number; voters: number; mine: boolean; vetoed: boolean }[] {
    const roster = this.rosters.get(circle);
    if (!roster) return [];
    const voters = roster.members.filter((m) => m !== roster.admin).length;
    const me = this.memberId();
    const out = [];
    for (const d of this.raw('relief')) {
      const s = d.s as Signed<ReliefDocP>;
      const p = s?.p?.proposal;
      if (!p || p.circle !== circle || p.from !== roster.v) continue;
      out.push({
        id: d.id,
        proposal: p,
        votes: new Set((s.p.votes ?? []).map((v) => v.member)).size,
        voters,
        mine: (s.p.votes ?? []).some((v) => v.member === me),
        vetoed: typeof s.p.veto === 'string',
      });
    }
    return out;
  }

  /** Vote pour une relève (signature de cet appareil). */
  async voteRelief(docId: string) {
    const d = this.raw('relief').find((x) => x.id === docId);
    const s = d?.s as Signed<ReliefDocP> | undefined;
    const me = this.memberId();
    if (!s || !me) throw new Error('Proposition introuvable');
    const sig = await sign(this.identity.signKey, 'family-app/relief', { member: me, proposal: s.p.proposal });
    const votes = [...(s.p.votes ?? []).filter((v) => v.member !== me), { device: this.identity.deviceId, member: me, sig }];
    await this.put<ReliefDocP>('relief', docId, { ...s.p, votes });
    await this.refresh();
  }

  /** L'admin s'oppose à une relève (il a encore sa clé). */
  async vetoRelief(docId: string) {
    const d = this.raw('relief').find((x) => x.id === docId);
    const s = d?.s as Signed<ReliefDocP> | undefined;
    const admin = await this.adminKeyring.get();
    if (!s || !admin) throw new Error('Opposition impossible');
    const veto = await sign(admin.key, 'family-app/veto', s.p.proposal);
    await this.put<ReliefDocP>('relief', docId, { ...s.p, veto });
    await this.refresh();
  }

  /** Le candidat, au bout des 7 jours, publie la nouvelle liste (signée par SA clé, avec la relève). */
  async completeRelief(docId: string) {
    const d = this.raw('relief').find((x) => x.id === docId);
    const s = d?.s as Signed<ReliefDocP> | undefined;
    const admin = await this.adminKeyring.get();
    const me = this.memberId();
    if (!s || !admin || s.p.proposal.candidate !== me) throw new Error('Relève impossible');
    const cur = this.rosters.get(s.p.proposal.circle);
    if (!cur) throw new Error('Cercle introuvable');
    const r: Roster = { ...cur, v: cur.v + 1, admin: me, spub: admin.spub, wrapped: admin.wrapped };
    const sr: SignedRoster = { ...(await signRoster(admin.key, r)), relief: { proposal: s.p.proposal, votes: s.p.votes } };
    await this.put<ReliefDocP>('relief', docId, { ...s.p, roster: sr });
    await this.refresh();
  }

  /* ------------------------------------------------------------ sauvegarde et migration */

  exportSecrets(): Record<string, StoredSecret> {
    return { ...(this.local?.secrets ?? {}) };
  }

  /** Restauration d'une sauvegarde (protégée par phrase secrète) : clés remises à cet appareil. */
  async importSecrets(secrets: Record<string, StoredSecret>) {
    const local = await this.loadLocal();
    for (const [keyId, s] of Object.entries(secrets ?? {})) {
      if (!isId(keyId) || !isId(s?.group) || typeof s.secret !== 'string') continue;
      const raw = fromB64url(s.secret);
      if (raw.length !== 32 || (await deriveGroupKeyId(raw)) !== keyId) continue;
      local.secrets[keyId] = { group: s.group, epoch: s.epoch, secret: s.secret };
    }
    await this.save('secrets');
    this.held.clear();
    await this.refresh();
  }

  /** Nombre d'éléments lisibles (pour la migration et les tests). */
  count(name?: string) {
    return [...this.items.values()].filter((g) => !g.d.x && (!name || g.c === name)).length;
  }
}

function clean(data: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!['id', 'createdBy', 'createdAt', 'updatedAt', 'groups', 'owner'].includes(k) && v !== undefined) out[k] = v;
  return out;
}
