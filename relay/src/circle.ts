import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import { sendPush, type PushSubscriptionJSON } from './webpush';
import { fetchIcs, ICS_PER_DAY, IcsError } from './ics';

/**
 * Un cercle familial = un Durable Object.
 * Tout ce qui est stocké ici est chiffré par les appareils (le relais n'a pas la clé).
 * Le relais voit seulement : identifiants aléatoires, tailles, horodatages, heures d'envoi des rappels.
 */

const MAX_BATCH = 512 * 1024; // un paquet de modifications chiffré
const MAX_SNAPSHOT = 1900 * 1024;
const MAX_BLOB = 1900 * 1024; // une photo chiffrée (réduite par l'appli avant envoi)
const DAY = 86_400_000;
const MAX_SCHEDULE = 300; // rappels planifiés par appareil
const MAX_PAYLOAD = 3000; // contenu chiffré d'une notification
const CLOSED_RETENTION = 30 * 24 * 3600 * 1000; // après rotation de clé
const MAX_QUEUE = MAX_SCHEDULE * 20; // rappels en attente pour tout le cercle (≈ 20 appareils)
const MAX_AHEAD = 40 * DAY; // l'appli planifie 14 jours à l'avance : au-delà, ce n'est pas un rappel
const DEVICE_RE = /^[0-9a-f]{32}$/;
const BLOB_RE = /^[0-9a-f]{32}$/;

type Attachment = { ok: boolean; device?: string };
type QueueItem = { device: string; at: number; payload: string; topic?: string; urgent?: boolean };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Services push des navigateurs (Chrome/Android/Samsung/Opera : Google ; Firefox : Mozilla ;
 * Safari/iPhone : Apple ; Edge sur Windows : Microsoft). Le relais refuse d'envoyer des requêtes
 * ailleurs : il ne doit pas servir de « relais d'envoi » vers n'importe quel site.
 */
const PUSH_HOSTS = ['googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
export function pushEndpointAllowed(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  // http://localhost n'est accepté que pour les tests locaux (sans effet en production).
  if (url.protocol === 'http:') return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' || url.port) return false;
  return PUSH_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
}

/**
 * Empreinte de connexion pour les limites : une adresse IPv6 est ramenée à son préfixe /64
 * (un abonné dispose en général d'un /64 entier, il pourrait sinon changer d'adresse à volonté).
 */
export function connectionKey(ip: string): string {
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comparaison en temps constant. */
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export class Circle extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
  }

  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS log (seq INTEGER PRIMARY KEY AUTOINCREMENT, device TEXT, data TEXT NOT NULL, at INTEGER);
      CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), seq INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, data BLOB NOT NULL, at INTEGER);
      CREATE TABLE IF NOT EXISTS subs (device TEXT PRIMARY KEY, sub TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT, device TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL,
        topic TEXT, urgent INTEGER DEFAULT 0, source TEXT NOT NULL, tries INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS queue_at ON queue(at);
      CREATE INDEX IF NOT EXISTS queue_device ON queue(device, source);
    `);
  }

  // ------------------------------------------------------------ utilitaires

  private meta(k: string): string | null {
    const row = this.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', k).toArray()[0];
    return row ? row.v : null;
  }
  private setMeta(k: string, v: string) {
    this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
  }
  private head(): number {
    const r = this.sql.exec<{ s: number | null }>('SELECT MAX(seq) AS s FROM log').one().s;
    const snap = this.sql.exec<{ seq: number }>('SELECT seq FROM snapshot').toArray()[0]?.seq ?? 0;
    return Math.max(r ?? 0, snap);
  }

  private async checkToken(token: unknown): Promise<boolean> {
    const stored = this.meta('auth');
    if (!stored || typeof token !== 'string' || token.length < 20) return false;
    return safeEqual(stored, await sha256Hex(token));
  }

  private async auth(request: Request) {
    const token = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!(await this.checkToken(token))) throw new HttpError(403, 'Accès refusé');
  }

  /**
   * Quota progressif : une famille qui vient d'arriver dispose de peu d'espace (20 Mo),
   * qui grandit chaque jour (+10 Mo) jusqu'au maximum (250 Mo). Une vraie famille ne s'en
   * aperçoit pas ; quelqu'un qui voudrait remplir le relais d'un coup ne le peut pas.
   */
  private get quotaBytes() {
    const max = Number(this.env.CIRCLE_QUOTA_MB || 250);
    const created = Number(this.meta('created') ?? 0);
    if (created <= 1) return max * 1024 * 1024; // cercle antérieur au quota progressif
    const days = Math.max(0, (Date.now() - created) / DAY);
    const mb = Math.min(max, Number(this.env.CIRCLE_QUOTA_START_MB || 20) + Number(this.env.CIRCLE_QUOTA_PER_DAY_MB || 10) * Math.floor(days));
    return mb * 1024 * 1024;
  }
  private get quotaIsFinal() {
    return this.quotaBytes >= Number(this.env.CIRCLE_QUOTA_MB || 250) * 1024 * 1024;
  }

  /** Compteur à fenêtre d'un jour (voir Limiter). */
  private async allow(name: string, max: number) {
    const limiter = this.env.LIMITER.get(this.env.LIMITER.idFromName(await sha256Hex(`${name}|${new Date().toISOString().slice(0, 10)}`)));
    return limiter.hit(max);
  }
  private get inactiveMs() {
    return Number(this.env.INACTIVE_DAYS || 400) * DAY;
  }

  /** Espace occupé par le cercle (journal, instantané, photos, rappels). */
  private usedBytes(): number {
    const q = (sql: string) => this.sql.exec<{ n: number | null }>(sql).one().n ?? 0;
    return (
      q('SELECT SUM(LENGTH(data)) AS n FROM log') +
      q('SELECT SUM(LENGTH(data)) AS n FROM snapshot') +
      q('SELECT SUM(LENGTH(data)) AS n FROM blobs') +
      q('SELECT SUM(LENGTH(payload)) AS n FROM queue')
    );
  }
  private checkQuota(extra: number) {
    if (this.usedBytes() + extra > this.quotaBytes) {
      const mb = Math.round(this.quotaBytes / 1048576);
      throw new HttpError(
        507,
        this.quotaIsFinal
          ? `Espace du cercle plein (${mb} Mo). Supprimez des photos.`
          : `Espace du cercle plein pour l'instant (${mb} Mo) : il augmente chaque jour pour les nouvelles familles.`,
      );
    }
  }

  private async inheritedCreation(from?: string, fromToken?: string): Promise<number | null> {
    if (typeof from !== 'string' || !/^[0-9a-f]{32}$/.test(from) || typeof fromToken !== 'string') return null;
    const me = this.meta('id');
    if (!me) return null;
    const res = await this.env.CIRCLE.get(this.env.CIRCLE.idFromName(from)).fetch(`https://relais/c/${from}/age?for=${me}`, {
      headers: { Authorization: `Bearer ${fromToken}` },
    });
    if (!res.ok) return null;
    const { created } = (await res.json()) as { created: number };
    return created || 1; // 1 = « ancien » (antérieur au quota progressif) : quota maximum
  }

  /** Dernière activité (écrite au plus deux fois par jour) : sert à effacer les cercles abandonnés. */
  private async touch() {
    const seen = Number(this.meta('seen') ?? 0);
    if (Date.now() - seen < DAY / 2) return;
    this.setMeta('seen', String(Date.now()));
    await this.rescheduleAlarm();
  }

  /** Passe le cercle en lecture seule (après un renouvellement de clé). */
  private async closeCircle() {
    if (!this.meta('closed')) this.setMeta('closed', String(Date.now()));
    this.sql.exec('DELETE FROM queue');
    this.sql.exec('DELETE FROM subs');
    this.sql.exec('DELETE FROM blobs');
    await this.rescheduleAlarm();
  }

  /**
   * Efface le contenu d'un cercle fermé mais garde une « pierre tombale » (empreinte du jeton, date de
   * fermeture) : un appareil resté hors ligne apprend que le cercle est fermé, au lieu de le recréer et
   * d'y renvoyer ses données, lisibles par l'appareil qui avait été retiré.
   */
  private purgeClosed() {
    for (const table of ['log', 'snapshot', 'blobs', 'subs', 'queue']) this.sql.exec(`DELETE FROM ${table}`);
    this.setMeta('purged', '1');
  }

  private notClosed() {
    if (this.meta('closed')) throw new HttpError(410, 'Ce cercle a été fermé (clé renouvelée)');
  }

  private async rescheduleAlarm() {
    const next = this.sql.exec<{ at: number | null }>('SELECT MIN(at) AS at FROM queue').one().at;
    const closedAt = Number(this.meta('closed') ?? 0);
    const seen = Number(this.meta('seen') ?? 0);
    const purged = !!this.meta('purged');
    const candidates = [next, closedAt && !purged ? closedAt + CLOSED_RETENTION : null, seen ? seen + this.inactiveMs : null].filter(
      (x): x is number => !!x,
    );
    if (candidates.length) await this.ctx.storage.setAlarm(Math.max(Date.now(), Math.min(...candidates)));
    else await this.ctx.storage.deleteAlarm();
  }

  // ------------------------------------------------------------ HTTP

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.route(request);
    } catch (err) {
      if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
      console.error(err);
      return Response.json({ error: 'Erreur du relais' }, { status: 500 });
    }
  }

  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, , action, arg] = url.pathname.split('/').filter(Boolean);
    const m = request.method;
    // Identifiant du cercle (sert à désigner le successeur lors d'un renouvellement de clé).
    const ownId = url.pathname.split('/').filter(Boolean)[1];
    if (ownId && !this.meta('id') && /^[0-9a-f]{32}$/.test(ownId)) this.setMeta('id', ownId);

    if (action === 'ws' && request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ ok: false } satisfies Attachment);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    // Enregistrement du cercle : le premier jeton présenté devient la référence (empreinte SHA-256 seulement).
    if (action === 'register' && m === 'POST') {
      const body = (await request.json()) as { token?: string; from?: string; fromToken?: string };
      const { token } = body;
      if (typeof token !== 'string' || token.length < 20) throw new HttpError(400, 'Jeton invalide');
      const stored = this.meta('auth');
      if (!stored) {
        // Renouvellement de clé : c'est la même famille, qui garde son ancienneté (preuve : le jeton de l'ancien cercle).
        const ip = connectionKey(request.headers.get('CF-Connecting-IP') ?? 'inconnue');
        const perIp = Number(this.env.NEW_CIRCLES_PER_IP_PER_DAY || 3);
        // Le renouvellement de clé est lui aussi limité par connexion : au-delà, il compte comme une création.
        // (Limite vérifiée AVANT de réclamer l'ancienneté, car cette réclamation ferme l'ancien cercle.)
        let inherited: number | null = null;
        if (body.from && (await this.allow(`rotation|${ip}`, perIp))) inherited = await this.inheritedCreation(body.from, body.fromToken);
        if (inherited === null) {
          // Vraie création : limitée par connexion et au total, par jour (anti-abus d'un relais public).
          const bucket = this.env.ALLOW_TEST_BUCKETS === '1' ? (request.headers.get('X-Test-Bucket') ?? '') : '';
          if (!(await this.allow(`ip|${ip}`, perIp))) {
            throw new HttpError(429, "Trop de nouvelles familles créées depuis cette connexion aujourd'hui. Réessayez demain.");
          }
          if (!(await this.allow(`global|${bucket}`, Number(this.env.NEW_CIRCLES_PER_DAY || 100)))) {
            throw new HttpError(429, "Le nombre de nouvelles familles est limité chaque jour sur ce service. Réessayez demain.");
          }
        }
        this.setMeta('auth', await sha256Hex(token));
        this.setMeta('created', String(inherited ?? Date.now()));
      } else if (!(await this.checkToken(token))) throw new HttpError(403, 'Accès refusé');
      await this.touch();
      return Response.json({ ok: true, closed: !!this.meta('closed') });
    }

    // Appel interne entre cercles (renouvellement de clé) : date de création, sur preuve du jeton.
    // Un cercle ne transmet son ancienneté qu'à UN successeur, et il est alors fermé (comme le fait
    // l'appli juste après) : impossible d'enchaîner les créations gratuites à partir d'un seul cercle.
    if (action === 'age' && m === 'GET') {
      await this.auth(request);
      const successor = url.searchParams.get('for') ?? '';
      if (!/^[0-9a-f]{32}$/.test(successor)) throw new HttpError(400, 'Successeur invalide');
      const claimed = this.meta('successor');
      if (claimed && claimed !== successor) throw new HttpError(409, 'Ancienneté déjà transmise');
      if (!claimed) this.setMeta('successor', successor);
      await this.closeCircle();
      return Response.json({ created: Number(this.meta('created') ?? 0) });
    }

    await this.auth(request);

    // Abonnement à un calendrier en ligne (voir ics.ts) : quota par cercle et par jour.
    if (action === 'ics' && m === 'POST') {
      this.notClosed();
      if (!(await this.allow(`ics|${this.meta('id') ?? ''}`, ICS_PER_DAY))) {
        throw new HttpError(429, "Trop de mises à jour de calendriers aujourd'hui. Réessayez demain.");
      }
      const body = (await request.json().catch(() => ({}))) as { url?: unknown };
      try {
        return await fetchIcs(body.url);
      } catch (err) {
        if (err instanceof IcsError) throw new HttpError(err.status, err.message);
        throw err;
      }
    }

    if (action === 'blobs' && arg && BLOB_RE.test(arg)) {
      if (m === 'GET') {
        const row = this.sql.exec<{ data: ArrayBuffer }>('SELECT data FROM blobs WHERE id = ?', arg).toArray()[0];
        if (!row) throw new HttpError(404, 'Introuvable');
        return new Response(row.data, { headers: { 'Content-Type': 'application/octet-stream' } });
      }
      if (m === 'PUT') {
        this.notClosed();
        const data = await request.arrayBuffer();
        if (!data.byteLength || data.byteLength > MAX_BLOB) throw new HttpError(413, 'Fichier trop volumineux');
        this.checkQuota(data.byteLength);
        this.sql.exec('INSERT OR REPLACE INTO blobs (id, data, at) VALUES (?, ?, ?)', arg, data, Date.now());
        return Response.json({ ok: true });
      }
      if (m === 'DELETE') {
        this.sql.exec('DELETE FROM blobs WHERE id = ?', arg);
        return Response.json({ ok: true });
      }
    }

    if (action === 'subs' && arg && DEVICE_RE.test(arg)) {
      if (m === 'PUT') {
        this.notClosed();
        const sub = (await request.json()) as PushSubscriptionJSON;
        if (typeof sub?.endpoint !== 'string' || !pushEndpointAllowed(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
          throw new HttpError(400, 'Abonnement invalide');
        }
        const clean = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
        this.sql.exec('INSERT OR REPLACE INTO subs (device, sub) VALUES (?, ?)', arg, JSON.stringify(clean));
        return Response.json({ ok: true });
      }
      if (m === 'DELETE') {
        this.sql.exec('DELETE FROM subs WHERE device = ?', arg);
        this.sql.exec('DELETE FROM queue WHERE device = ?', arg);
        return Response.json({ ok: true });
      }
    }

    // Rappels planifiés d'un appareil : la liste envoyée remplace la précédente.
    if (action === 'schedule' && arg && DEVICE_RE.test(arg) && m === 'PUT') {
      this.notClosed();
      const { items } = (await request.json()) as { items: QueueItem[] };
      if (!Array.isArray(items) || items.length > MAX_SCHEDULE) throw new HttpError(400, 'Liste de rappels invalide');
      this.sql.exec("DELETE FROM queue WHERE device = ? AND source = 'schedule'", arg);
      this.checkQueueRoom(items.length);
      for (const it of items) this.insertQueue({ ...it, device: arg }, 'schedule');
      await this.rescheduleAlarm();
      return Response.json({ ok: true, count: items.length });
    }

    // Notifications ponctuelles (activité, sécurité, « rappeler plus tard »).
    if (action === 'notify' && m === 'POST') {
      this.notClosed();
      const { items } = (await request.json()) as { items: QueueItem[] };
      if (!Array.isArray(items) || items.length > 50) throw new HttpError(400, 'Notifications invalides');
      this.checkQueueRoom(items.length);
      for (const it of items) {
        if (!DEVICE_RE.test(it.device)) throw new HttpError(400, 'Appareil invalide');
        this.insertQueue({ ...it, at: it.at ?? Date.now() }, 'notify');
      }
      await this.deliverDue();
      await this.rescheduleAlarm();
      return Response.json({ ok: true });
    }

    // Rotation de clé : le cercle passe en lecture seule puis est effacé au bout de 30 jours.
    if (action === 'close' && m === 'POST') {
      await this.closeCircle();
      return Response.json({ ok: true });
    }

    // Droit à l'effacement : supprime TOUT ce que le relais détient pour ce cercle.
    if (!action && m === 'DELETE') {
      for (const ws of this.ctx.getWebSockets()) ws.close(4001, 'Cercle supprimé');
      if (this.meta('closed')) {
        // Cercle fermé : on efface tout le contenu, mais la pierre tombale reste (voir purgeClosed).
        // Sinon, quiconque garde l'ancien jeton (appareil retiré) pourrait faire « rouvrir » le cercle.
        this.purgeClosed();
        await this.rescheduleAlarm();
        return Response.json({ ok: true });
      }
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.migrate();
      return Response.json({ ok: true });
    }

    throw new HttpError(404, 'Introuvable');
  }

  /** Nombre de rappels en attente limité : ils comptent dans l'espace du cercle, mais sans plafond on pourrait s'en servir de stockage. */
  private checkQueueRoom(extra: number) {
    const n = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM queue').one().n;
    if (n + extra > MAX_QUEUE) throw new HttpError(507, 'Trop de rappels en attente');
  }

  private insertQueue(it: QueueItem, source: string) {
    if (typeof it.payload !== 'string' || it.payload.length > MAX_PAYLOAD) throw new HttpError(400, 'Notification trop volumineuse');
    if (typeof it.at !== 'number' || !Number.isFinite(it.at)) throw new HttpError(400, 'Date invalide');
    if (it.at > Date.now() + MAX_AHEAD) return; // trop lointain : ignoré (sans faire échouer le reste de la liste)
    const topic = typeof it.topic === 'string' ? it.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) : null;
    this.sql.exec(
      'INSERT INTO queue (device, at, payload, topic, urgent, source) VALUES (?, ?, ?, ?, ?, ?)',
      it.device,
      Math.round(it.at),
      it.payload,
      topic || null,
      it.urgent ? 1 : 0,
      source,
    );
  }

  // ------------------------------------------------------------ envoi des notifications

  private async deliverDue() {
    if (!this.env.VAPID_PRIVATE_JWK || !this.env.VAPID_PUBLIC_KEY) return;
    const vapid = {
      privateJwk: JSON.parse(this.env.VAPID_PRIVATE_JWK) as JsonWebKey,
      publicKey: this.env.VAPID_PUBLIC_KEY,
      subject: this.env.VAPID_SUBJECT || 'mailto:relay@example.invalid',
    };
    const rows = this.sql
      .exec<{ id: number; device: string; payload: string; topic: string | null; urgent: number; tries: number }>(
        'SELECT id, device, payload, topic, urgent, tries FROM queue WHERE at <= ? ORDER BY at LIMIT 40',
        Date.now() + 1000,
      )
      .toArray();
    for (const r of rows) {
      const subRow = this.sql.exec<{ sub: string }>('SELECT sub FROM subs WHERE device = ?', r.device).toArray()[0];
      if (!subRow) {
        this.sql.exec('DELETE FROM queue WHERE id = ?', r.id);
        continue;
      }
      let status = 0;
      try {
        const res = await sendPush(JSON.parse(subRow.sub), r.payload, vapid, {
          urgency: r.urgent ? 'high' : 'normal',
          topic: r.topic ?? undefined,
        });
        status = res.status;
      } catch {
        status = 0;
      }
      if (status === 404 || status === 410) {
        // Abonnement expiré (appli désinstallée, permission retirée…)
        this.sql.exec('DELETE FROM subs WHERE device = ?', r.device);
        this.sql.exec('DELETE FROM queue WHERE device = ?', r.device);
      } else if ((status === 0 || status === 429 || status >= 500) && r.tries < 3) {
        this.sql.exec('UPDATE queue SET at = ?, tries = tries + 1 WHERE id = ?', Date.now() + 60_000 * (r.tries + 1), r.id);
      } else {
        this.sql.exec('DELETE FROM queue WHERE id = ?', r.id);
      }
    }
  }

  async alarm() {
    const closedAt = Number(this.meta('closed') ?? 0);
    const seen = Number(this.meta('seen') ?? 0);
    if (closedAt && Date.now() > closedAt + CLOSED_RETENTION && !this.meta('purged') && !(seen && Date.now() > seen + this.inactiveMs)) {
      // Cercle fermé depuis 30 jours : le contenu est effacé, la pierre tombale reste jusqu'à l'inactivité.
      this.purgeClosed();
      await this.rescheduleAlarm();
      return;
    }
    if (seen && Date.now() > seen + this.inactiveMs) {
      // Cercle abandonné : tout est effacé (les données restent sur les appareils).
      for (const ws of this.ctx.getWebSockets()) ws.close(4001, 'Cercle effacé');
      await this.ctx.storage.deleteAll();
      this.migrate();
      return;
    }
    await this.deliverDue();
    await this.rescheduleAlarm();
  }

  // ------------------------------------------------------------ WebSocket (synchronisation)

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== 'string' || raw.length > MAX_SNAPSHOT + 1024) return ws.close(1009, 'Message trop volumineux');
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return ws.close(1003, 'JSON invalide');
    }
    const att = (ws.deserializeAttachment() ?? { ok: false }) as Attachment;

    if (!att.ok) {
      if (msg.t !== 'hello' || !(await this.checkToken(msg.token))) return ws.close(4003, 'Accès refusé');
      const device = typeof msg.device === 'string' && DEVICE_RE.test(msg.device) ? msg.device : undefined;
      ws.serializeAttachment({ ok: true, device } satisfies Attachment);
      await this.touch();
      const since = Number(msg.since) || 0;
      const snap = this.sql.exec<{ seq: number; data: string }>('SELECT seq, data FROM snapshot').toArray()[0];
      let from = since;
      if (snap && since < snap.seq) {
        ws.send(JSON.stringify({ t: 'snapshot', seq: snap.seq, data: snap.data }));
        from = snap.seq;
      }
      for (const row of this.sql.exec<{ seq: number; data: string; device: string }>(
        'SELECT seq, data, device FROM log WHERE seq > ? ORDER BY seq',
        from,
      )) {
        ws.send(JSON.stringify({ t: 'batch', seq: row.seq, data: row.data, device: row.device }));
      }
      ws.send(JSON.stringify({ t: 'ready', seq: this.head(), closed: !!this.meta('closed') }));
      return;
    }

    if (msg.t === 'ping') return ws.send(JSON.stringify({ t: 'pong' }));

    if (msg.t === 'push') {
      if (this.meta('closed')) return ws.send(JSON.stringify({ t: 'error', id: msg.id, error: 'closed' }));
      if (typeof msg.data !== 'string' || msg.data.length > MAX_BATCH) {
        return ws.send(JSON.stringify({ t: 'error', id: msg.id, error: 'too_large' }));
      }
      if (this.usedBytes() + msg.data.length > this.quotaBytes) {
        return ws.send(JSON.stringify({ t: 'error', id: msg.id, error: 'quota' }));
      }
      const seq = this.sql
        .exec<{ seq: number }>('INSERT INTO log (device, data, at) VALUES (?, ?, ?) RETURNING seq', att.device ?? '', msg.data, Date.now())
        .one().seq;
      ws.send(JSON.stringify({ t: 'ack', id: msg.id, seq }));
      const out = JSON.stringify({ t: 'batch', seq, data: msg.data, device: att.device ?? '' });
      for (const other of this.ctx.getWebSockets()) {
        if (other === ws) continue;
        const a = other.deserializeAttachment() as Attachment | null;
        if (a?.ok) {
          try {
            other.send(out);
          } catch {
            /* socket fermée */
          }
        }
      }
      return;
    }

    // Compaction : un appareil fournit un instantané chiffré de tout l'état jusqu'à `seq`.
    if (msg.t === 'snapshot') {
      const seq = Number(msg.seq);
      if (typeof msg.data !== 'string' || msg.data.length > MAX_SNAPSHOT || !(seq > 0) || seq > this.head()) return;
      const current = this.sql.exec<{ seq: number }>('SELECT seq FROM snapshot').toArray()[0]?.seq ?? 0;
      if (seq <= current) return;
      this.sql.exec('INSERT OR REPLACE INTO snapshot (id, seq, data) VALUES (1, ?, ?)', seq, msg.data);
      this.sql.exec('DELETE FROM log WHERE seq <= ?', seq);
      return;
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code, 'bye');
    } catch {
      /* déjà fermée */
    }
  }
}
