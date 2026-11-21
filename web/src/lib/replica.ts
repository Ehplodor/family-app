/**
 * Réplique locale des données de la famille (« local-first »).
 *
 * Chaque appareil possède une copie complète. Les modifications sont des opérations
 * horodatées avec une horloge logique hybride (HLC) ; la fusion se fait champ par champ,
 * la valeur la plus récente gagne (CRDT « last-writer-wins »). Deux appareils qui reçoivent
 * les mêmes opérations, dans n'importe quel ordre, aboutissent donc au même état,
 * même après des jours passés hors ligne.
 */
import * as idb from './idb';
import { randomId } from './bytes';

export type FieldClock = { v: unknown; t: string };
export type DocRecord = {
  id: string;
  c: string; // collection
  f: Record<string, FieldClock>;
  ct: string; // plus ancienne horloge connue pour ce document
  cb: string | null; // membre auteur
  cbt?: string; // horloge de l'opération de création (qui porte l'auteur)
  del?: string; // horloge de suppression
};
export type Op = { i: string; c: string; t: string; f?: Record<string, unknown>; d?: 1; cb?: string | null };

export type Doc<T> = T & { id: string; createdBy: string | null; createdAt: string; updatedAt: string };

const RESERVED = new Set(['id', 'createdBy', 'createdAt', 'updatedAt']);
const key = (c: string, id: string) => `${c}/${id}`;

/* ------------------------------------------------------------------ Horloge */

export class HLC {
  private ms = 0;
  private n = 0;
  constructor(private node: string) {}

  static parseMs(t: string) {
    return parseInt(t.slice(0, 9), 36);
  }
  private fmt() {
    return `${this.ms.toString(36).padStart(9, '0')}${this.n.toString(36).padStart(4, '0')}-${this.node}`;
  }
  now(): string {
    const wall = Date.now();
    if (wall > this.ms) {
      this.ms = wall;
      this.n = 0;
    } else this.n++;
    return this.fmt();
  }
  receive(t: string) {
    const ms = HLC.parseMs(t);
    const n = parseInt(t.slice(9, 13), 36);
    // On ignore les horloges aberrantes (plus d'un jour dans le futur).
    if (!Number.isFinite(ms) || ms > Date.now() + 86_400_000) return;
    if (ms > this.ms || (ms === this.ms && n > this.n)) {
      this.ms = ms;
      this.n = n;
    }
  }
}

/* ------------------------------------------------------------------ Fusion (pure, testable) */

/** Applique une opération à un document ; renvoie true si quelque chose a changé. */
export function applyOp(docs: Map<string, DocRecord>, op: Op): DocRecord | null {
  const k = key(op.c, op.i);
  let rec = docs.get(k);
  let changed = false;
  if (!rec) {
    rec = { id: op.i, c: op.c, f: {}, ct: op.t, cb: null };
    docs.set(k, rec);
    changed = true;
  } else if (op.t < rec.ct) {
    rec.ct = op.t;
    changed = true;
  }
  // L'auteur vient de l'opération de création la plus ancienne, quel que soit l'ordre d'arrivée
  // (et même si l'horloge d'un appareil retarde).
  if (op.cb !== undefined && (rec.cbt === undefined || op.t < rec.cbt)) {
    rec.cb = op.cb;
    rec.cbt = op.t;
    changed = true;
  }
  if (op.f) {
    for (const [field, v] of Object.entries(op.f)) {
      if (RESERVED.has(field)) continue;
      const cur = rec.f[field];
      if (!cur || op.t > cur.t) {
        rec.f[field] = { v, t: op.t };
        changed = true;
      }
    }
  }
  if (op.d && (!rec.del || op.t > rec.del)) {
    rec.del = op.t;
    changed = true;
  }
  return changed ? rec : null;
}

/** Fusionne un document complet (instantané, sauvegarde, rotation de clé). */
export function mergeRecord(docs: Map<string, DocRecord>, incoming: DocRecord): DocRecord | null {
  const k = key(incoming.c, incoming.id);
  const rec = docs.get(k);
  if (!rec) {
    const copy = { ...incoming, f: { ...incoming.f } };
    docs.set(k, copy);
    return copy;
  }
  let changed = false;
  if (incoming.ct < rec.ct) {
    rec.ct = incoming.ct;
    changed = true;
  }
  if (incoming.cbt !== undefined && (rec.cbt === undefined || incoming.cbt < rec.cbt)) {
    rec.cb = incoming.cb;
    rec.cbt = incoming.cbt;
    changed = true;
  }
  for (const [field, fc] of Object.entries(incoming.f)) {
    const cur = rec.f[field];
    if (!cur || fc.t > cur.t) {
      rec.f[field] = fc;
      changed = true;
    }
  }
  if (incoming.del && (!rec.del || incoming.del > rec.del)) {
    rec.del = incoming.del;
    changed = true;
  }
  return changed ? rec : null;
}

export function toDoc<T>(rec: DocRecord): Doc<T> {
  const out: Record<string, unknown> = {};
  let updated = rec.ct;
  for (const [field, fc] of Object.entries(rec.f)) {
    out[field] = fc.v;
    if (fc.t > updated) updated = fc.t;
  }
  return {
    ...(out as T),
    id: rec.id,
    createdBy: rec.cb,
    createdAt: new Date(HLC.parseMs(rec.cbt ?? rec.ct)).toISOString(),
    updatedAt: new Date(HLC.parseMs(updated)).toISOString(),
  };
}

/* ------------------------------------------------------------------ Réplique persistée */

type Listener = () => void;

export class Replica {
  docs = new Map<string, DocRecord>();
  clock: HLC;
  /** Membre utilisé comme auteur des nouvelles données. */
  memberId: string | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private anyListeners = new Set<(collections: Set<string>, local: boolean) => void>();
  private cache = new Map<string, Doc<unknown>[]>();
  /** Appelé pour chaque lot d'opérations locales à transmettre. */
  onLocalOps: ((ops: Op[]) => void) | null = null;

  constructor(readonly deviceId: string) {
    this.clock = new HLC(deviceId);
  }

  async load() {
    for (const [, rec] of await idb.entries<DocRecord>('docs')) {
      this.docs.set(key(rec.c, rec.id), rec);
      this.clock.receive(rec.ct);
      for (const fc of Object.values(rec.f)) this.clock.receive(fc.t);
    }
  }

  list<T>(collection: string): Doc<T>[] {
    let docs = this.cache.get(collection);
    if (!docs) {
      const recs = [...this.docs.values()].filter((r) => r.c === collection && !r.del);
      recs.sort((a, b) => (a.ct < b.ct ? -1 : a.ct > b.ct ? 1 : 0));
      docs = recs.map((r) => toDoc(r));
      this.cache.set(collection, docs);
    }
    return docs as Doc<T>[];
  }

  get<T>(collection: string, id: string): Doc<T> | undefined {
    const rec = this.docs.get(key(collection, id));
    return rec && !rec.del ? toDoc<T>(rec) : undefined;
  }

  subscribe(collection: string, l: Listener) {
    let set = this.listeners.get(collection);
    if (!set) this.listeners.set(collection, (set = new Set()));
    set.add(l);
    return () => {
      set!.delete(l);
    };
  }

  onChange(l: (collections: Set<string>, local: boolean) => void) {
    this.anyListeners.add(l);
    return () => {
      this.anyListeners.delete(l);
    };
  }

  private async commit(changed: DocRecord[], local: boolean) {
    if (!changed.length) return;
    const collections = new Set(changed.map((r) => r.c));
    for (const c of collections) this.cache.delete(c);
    await idb.putMany(
      'docs',
      changed.map((r) => [key(r.c, r.id), r]),
    );
    for (const c of collections) this.listeners.get(c)?.forEach((l) => l());
    this.anyListeners.forEach((l) => l(collections, local));
  }

  /** Opérations reçues d'autres appareils. */
  async applyRemote(ops: Op[]) {
    const changed = new Map<string, DocRecord>();
    for (const op of ops) {
      if (!op || typeof op.i !== 'string' || typeof op.c !== 'string' || typeof op.t !== 'string') continue;
      this.clock.receive(op.t);
      const rec = applyOp(this.docs, op);
      if (rec) changed.set(key(rec.c, rec.id), rec);
    }
    await this.commit([...changed.values()], false);
  }

  async mergeRecords(records: DocRecord[], local = false) {
    const changed: DocRecord[] = [];
    for (const r of records) {
      if (!r || typeof r.id !== 'string' || typeof r.c !== 'string' || !r.f) continue;
      this.clock.receive(r.ct);
      const rec = mergeRecord(this.docs, r);
      if (rec) changed.push(rec);
    }
    await this.commit(changed, local);
  }

  allRecords(filter?: (r: DocRecord) => boolean): DocRecord[] {
    return [...this.docs.values()].filter((r) => !filter || filter(r));
  }

  /* --------------------------------------------- modifications locales */

  private async local(ops: Op[]) {
    const changed: DocRecord[] = [];
    for (const op of ops) {
      const rec = applyOp(this.docs, op);
      if (rec) changed.push(rec);
    }
    await idb.putMany(
      'outbox',
      ops.map((op) => [undefined, op]),
    );
    await this.commit(changed, true);
    this.onLocalOps?.(ops);
  }

  async create<T extends object>(collection: string, data: T, id = randomId()): Promise<Doc<T>> {
    await this.local([{ i: id, c: collection, t: this.clock.now(), f: clean(data), cb: this.memberId }]);
    return this.get<T>(collection, id)!;
  }

  async update<T extends object>(collection: string, id: string, patch: Partial<T>) {
    await this.local([{ i: id, c: collection, t: this.clock.now(), f: clean(patch) }]);
  }

  /** Crée ou met à jour un document dont l'identifiant est connu (réglages, préférences…). */
  async upsert<T extends object>(collection: string, id: string, patch: Partial<T>) {
    const exists = this.docs.has(key(collection, id));
    await this.local([{ i: id, c: collection, t: this.clock.now(), f: clean(patch), ...(exists ? {} : { cb: this.memberId }) }]);
  }

  async remove(collection: string, id: string) {
    await this.local([{ i: id, c: collection, t: this.clock.now(), d: 1 }]);
  }

  async removeMany(collection: string, ids: string[]) {
    await this.local(ids.map((i) => ({ i, c: collection, t: this.clock.now(), d: 1 as const })));
  }
}

function clean(data: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!RESERVED.has(k) && v !== undefined) out[k] = v;
  return out;
}
