/**
 * Synchronisation avec le relais aveugle.
 * Tout ce qui part d'ici est chiffré avec la clé du cercle ; le relais ne fait que stocker
 * et rediffuser des paquets opaques, numérotés dans l'ordre d'arrivée.
 */
import * as idb from './idb';
import { openBytes, openJSON, sealBytes, sealJSON, type CircleKeys } from './crypto';
import type { DocRecord, Op, Replica } from './replica';

export const RELAY_URL: string = (import.meta.env.VITE_RELAY_URL ?? '').replace(/\/$/, '');

export type SyncStatus = 'local' | 'connecting' | 'online' | 'offline' | 'denied' | 'closed';
type Payload = { ops?: Op[]; records?: DocRecord[] };

const MAX_OPS_PER_BATCH = 300;
const SNAPSHOT_EVERY = 300;

export async function relayFetch(keys: CircleKeys, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${RELAY_URL}/c/${keys.circleId}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${keys.token}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Relais : ${res.status}`);
  return res;
}

export async function registerCircle(keys: CircleKeys): Promise<{ closed: boolean }> {
  const res = await fetch(`${RELAY_URL}/c/${keys.circleId}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: keys.token }),
  });
  if (!res.ok) throw new Error(res.status === 403 ? 'Accès refusé par le relais' : `Relais : ${res.status}`);
  return res.json();
}

export class SyncClient {
  status: SyncStatus = RELAY_URL ? 'connecting' : 'local';
  /** Paquets illisibles (mauvaise clé ou altération) : affiché dans l'écran Sécurité. */
  rejected = 0;
  private ws: WebSocket | null = null;
  private lastSeq = 0;
  private sinceSnap = 0;
  private ready = false;
  private inflight: { id: string; resolve: (seq: number) => void; reject: (e: Error) => void }[] = [];
  private flushing = false;
  private retry = 1000;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private statusListeners = new Set<(s: SyncStatus) => void>();
  private readyWaiters: (() => void)[] = [];
  private registered = false;

  constructor(
    readonly keys: CircleKeys,
    private replica: Replica,
  ) {}

  private aad = (purpose: string) => `${this.keys.circleId}:${purpose}`;
  private kv = (name: string) => `sync:${this.keys.circleId}:${name}`;

  onStatus(l: (s: SyncStatus) => void) {
    this.statusListeners.add(l);
    return () => {
      this.statusListeners.delete(l);
    };
  }
  private setStatus(s: SyncStatus) {
    this.status = s;
    this.statusListeners.forEach((l) => l(s));
  }

  /** Résolu quand l'appareil a rattrapé tout l'historique du relais. */
  whenReady(): Promise<void> {
    if (this.ready || !RELAY_URL) return Promise.resolve();
    return new Promise((r) => this.readyWaiters.push(r));
  }

  async start() {
    if (!RELAY_URL) return;
    this.lastSeq = (await idb.get<number>('kv', this.kv('seq'))) ?? 0;
    this.sinceSnap = (await idb.get<number>('kv', this.kv('sinceSnap'))) ?? 0;
    window.addEventListener('online', this.reconnectNow);
    document.addEventListener('visibilitychange', this.onVisible);
    this.connect();
  }

  stop() {
    this.stopped = true;
    window.removeEventListener('online', this.reconnectNow);
    document.removeEventListener('visibilitychange', this.onVisible);
    if (this.timer) clearTimeout(this.timer);
    if (this.ping) clearInterval(this.ping);
    this.ws?.close();
  }

  private onVisible = () => {
    if (document.visibilityState === 'visible' && (!this.ws || this.ws.readyState > 1)) this.reconnectNow();
  };
  private reconnectNow = () => {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.retry = 1000;
    if (!this.ws || this.ws.readyState > 1) this.connect();
  };

  private async connect() {
    if (this.stopped) return;
    this.setStatus('connecting');
    try {
      if (!this.registered) {
        const r = await registerCircle(this.keys);
        this.registered = true;
        if (r.closed) this.setStatus('closed');
      }
    } catch (err) {
      this.setStatus(String(err).includes('refusé') ? 'denied' : 'offline');
      return this.scheduleReconnect();
    }
    const ws = new WebSocket(`${RELAY_URL.replace(/^http/, 'ws')}/c/${this.keys.circleId}/ws`);
    this.ws = ws;
    this.ready = false;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', token: this.keys.token, device: this.replica.deviceId, since: this.lastSeq }));
      this.retry = 1000;
    };
    // Les messages sont traités strictement dans l'ordre.
    let chain = Promise.resolve();
    ws.onmessage = (e) => {
      chain = chain.then(() => this.handle(JSON.parse(e.data))).catch((err) => console.warn('synchro', err));
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ready = false;
      if (this.ping) clearInterval(this.ping);
      this.inflight.splice(0).forEach((f) => f.reject(new Error('Connexion perdue')));
      this.flushing = false;
      if (e.code === 4003) {
        this.setStatus('denied');
        return;
      }
      if (this.status !== 'closed') this.setStatus('offline');
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.connect(), this.retry);
    this.retry = Math.min(this.retry * 2, 30_000);
  }

  private async setSeq(seq: number) {
    if (seq <= this.lastSeq) return;
    this.lastSeq = seq;
    this.sinceSnap++;
    await idb.putMany('kv', [
      [this.kv('seq'), this.lastSeq],
      [this.kv('sinceSnap'), this.sinceSnap],
    ]);
  }

  private async decrypt(data: string, purpose: string): Promise<Payload | null> {
    try {
      return await openJSON<Payload>(this.keys.key, data, this.aad(purpose));
    } catch {
      this.rejected++;
      return null;
    }
  }

  private async handle(m: { t: string; seq?: number; data?: string; id?: string; closed?: boolean; error?: string }) {
    switch (m.t) {
      case 'snapshot': {
        const p = await this.decrypt(m.data!, 'snapshot');
        if (p?.records) await this.replica.mergeRecords(p.records);
        this.lastSeq = Math.max(this.lastSeq, m.seq!);
        this.sinceSnap = 0;
        await idb.putMany('kv', [
          [this.kv('seq'), this.lastSeq],
          [this.kv('sinceSnap'), 0],
        ]);
        break;
      }
      case 'batch': {
        const p = await this.decrypt(m.data!, 'batch');
        if (p?.records) await this.replica.mergeRecords(p.records);
        if (p?.ops) await this.replica.applyRemote(p.ops);
        await this.setSeq(m.seq!);
        break;
      }
      case 'ready':
        this.ready = true;
        if ((m.seq ?? 0) < this.lastSeq) {
          // Le relais a perdu ou effacé l'historique : on repart de zéro et on renvoie tout.
          this.lastSeq = 0;
          await idb.put('kv', this.kv('seq'), 0);
          this.send({ records: this.replica.allRecords((r) => r.c !== '_rotation') }).catch(() => {});
        }
        await this.setSeq(m.seq ?? 0);
        this.setStatus(m.closed ? 'closed' : 'online');
        this.readyWaiters.splice(0).forEach((r) => r());
        this.ping = setInterval(() => this.ws?.readyState === 1 && this.ws.send('{"t":"ping"}'), 25_000);
        this.flush();
        this.maybeSnapshot();
        break;
      case 'ack': {
        const i = this.inflight.findIndex((f) => f.id === m.id);
        if (i >= 0) this.inflight.splice(i, 1)[0].resolve(m.seq!);
        await this.setSeq(m.seq!);
        this.maybeSnapshot();
        break;
      }
      case 'error': {
        const i = this.inflight.findIndex((f) => f.id === m.id);
        if (i >= 0) this.inflight.splice(i, 1)[0].reject(new Error(m.error));
        if (m.error === 'closed') this.setStatus('closed');
        break;
      }
    }
  }

  private send(payload: Payload): Promise<number> {
    return new Promise(async (resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== 1 || !this.ready) return reject(new Error('Hors ligne'));
      const id = crypto.randomUUID();
      const data = await sealJSON(this.keys.key, payload, this.aad('batch'));
      this.inflight.push({ id, resolve, reject });
      ws.send(JSON.stringify({ t: 'push', id, data }));
    });
  }

  /** Envoie les modifications locales en attente (persistées : rien n'est perdu hors ligne). */
  async flush() {
    if (this.flushing || !this.ready || this.status === 'closed') return;
    this.flushing = true;
    try {
      for (;;) {
        const pending = await idb.entries<Op>('outbox', MAX_OPS_PER_BATCH);
        if (!pending.length) break;
        await this.send({ ops: pending.map(([, op]) => op) });
        await idb.del('outbox', IDBKeyRange.bound(pending[0][0], pending[pending.length - 1][0]));
      }
    } catch {
      /* hors ligne : on réessaiera à la reconnexion */
    } finally {
      this.flushing = false;
    }
  }

  /** Envoie des documents complets (nouveau cercle, restauration de sauvegarde). */
  async pushRecords(records: DocRecord[]) {
    await this.whenReady();
    const CHUNK = 200;
    for (let i = 0; i < records.length; i += CHUNK) await this.send({ records: records.slice(i, i + CHUNK) });
  }

  /** Compaction : remplace l'historique du relais par un instantané chiffré. */
  private async maybeSnapshot() {
    if (this.sinceSnap < SNAPSHOT_EVERY || !this.ready || this.lastSeq < 1) return;
    const outboxEmpty = !(await idb.entries('outbox', 1)).length;
    if (!outboxEmpty) return;
    const records = this.replica.allRecords((r) => r.c !== '_rotation');
    const data = await sealJSON(this.keys.key, { records }, this.aad('snapshot'));
    if (data.length > 1_800_000) return;
    this.ws?.send(JSON.stringify({ t: 'snapshot', seq: this.lastSeq, data }));
    this.sinceSnap = 0;
    await idb.put('kv', this.kv('sinceSnap'), 0);
  }

  /* --------------------------------------------- photos chiffrées */

  async uploadBlob(id: string, bytes: Uint8Array) {
    const body = await sealBytes(this.keys.key, bytes, this.aad(`blob:${id}`));
    await relayFetch(this.keys, `/blobs/${id}`, { method: 'PUT', body });
  }

  async downloadBlob(id: string): Promise<Uint8Array> {
    const res = await relayFetch(this.keys, `/blobs/${id}`);
    return openBytes(this.keys.key, new Uint8Array(await res.arrayBuffer()), this.aad(`blob:${id}`));
  }
}
