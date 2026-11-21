/**
 * Notifications : abonnement push, envoi des rappels planifiés au relais,
 * notifications d'activité (messages, listes, agenda…) regroupées.
 *
 * Le contenu de chaque notification est chiffré avec la clé du cercle AVANT d'être confié
 * au relais : seul le service worker d'un appareil du cercle peut l'afficher.
 */
import * as idb from './idb';
import { fromB64url } from './bytes';
import { sealJSON } from './crypto';
import type { Device, Engine, Member } from './engine';
import type { Op } from './replica';
import { DEFAULT_SNOOZE, PUSH_FOLLOW_UPS, ringsBetween, type Alarm } from './alarms';
import { computeReminders, DEFAULT_PREFS, outOfQuietHours, type NotifPrefs, type ReminderData } from './reminders';
import { RELAY_URL, relayFetch } from './sync';

export type PushPayload = {
  title: string;
  body: string;
  tag: string;
  url: string;
  kind: string;
  snooze?: boolean;
  answer?: string;
  /** Réveil : champ facultatif, ignoré par les anciennes versions (qui affichent une notification simple). */
  alarm?: AlarmPush;
};
/** `at` = heure de la sonnerie d'origine : permet d'ignorer les relances une fois le réveil arrêté. */
export type AlarmPush = { id: string; at: number; snoozeMin: number; challenge: boolean };
type QueueItem = { device: string; at: number; payload: string; topic?: string; urgent?: boolean };

export const pushSupported = () =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
export const isStandalone = () =>
  matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

export function prefsOf(engine: Engine, memberId: string): NotifPrefs {
  return { ...DEFAULT_PREFS, ...(engine.replica.get<Partial<NotifPrefs>>('prefs', memberId) ?? {}) };
}

/** Courte empreinte pour regrouper/remplacer les notifications côté service push (en-tête Topic). */
async function topicOf(tag: string) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tag)));
  return [...h.slice(0, 12)].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 24);
}

/** Collections dont dépendent les rappels planifiés. */
const SCHEDULE_SOURCES = ['events', 'birthdays', 'tasks', 'meals', 'members', 'schoolProfiles', 'timetable', 'homework', 'cards', 'alarms'];
/** Les réveils sont planifiés sur 7 jours (l'appli recalcule à chaque ouverture). */
const ALARM_HORIZON = 7 * 86400_000;
const MAX_SCHEDULE = 300; // limite du relais par appareil

export class Notifier {
  private uploaded = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private needAll = false;
  private activity = new Map<string, { count: number; build: (n: number) => { payload: PushPayload; targets: string[]; urgent?: boolean } }>();
  private activityTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private engine: Engine) {
    engine.replica.onChange((cols, local) => {
      if (cols.has('devices') || cols.has('prefs') || SCHEDULE_SOURCES.some((c) => cols.has(c))) {
        this.scheduleUpload(local);
      }
    });
    const prevOnLocal = engine.replica.onLocalOps;
    engine.replica.onLocalOps = (ops) => {
      prevOnLocal?.(ops);
      this.onLocalOps(ops);
    };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushActivity();
    });
  }

  private get circle() {
    return this.engine.circle;
  }

  private devices(): (Device & { id: string })[] {
    return this.engine.replica.list<Device>('devices').filter((d) => !d.revoked);
  }

  private async encrypt(p: PushPayload) {
    return sealJSON(this.circle!.key, p, `${this.circle!.circleId}:push`);
  }

  /* ------------------------------------------------------------ abonnement de CET appareil */

  permission(): NotificationPermission | 'unsupported' {
    return pushSupported() ? Notification.permission : 'unsupported';
  }

  async enable() {
    if (!pushSupported()) throw new Error('Notifications non prises en charge par ce navigateur');
    if (!RELAY_URL || !this.circle) throw new Error('Les notifications nécessitent le relais');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Permission refusée. Vous pouvez la réactiver dans les réglages du navigateur.');
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = (await (await fetch(`${RELAY_URL}/vapid`)).json()) as { publicKey: string };
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(publicKey) });
    await this.registerSubscription(sub);
    await this.engine.replica.update<Device>('devices', this.engine.deviceId, { push: true });
  }

  private async registerSubscription(sub: PushSubscription) {
    await relayFetch(this.circle!, `/subs/${this.engine.deviceId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    });
    await idb.put('kv', 'pushCircle', this.circle!.circleId);
  }

  async disable() {
    const reg = await navigator.serviceWorker?.getRegistration();
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
    if (this.circle) await relayFetch(this.circle, `/subs/${this.engine.deviceId}`, { method: 'DELETE' }).catch(() => {});
    await this.engine.replica.update<Device>('devices', this.engine.deviceId, { push: false });
  }

  /** Après un renouvellement de clé ou au démarrage : réenregistre l'abonnement si besoin. */
  async ensureSubscription() {
    if (!pushSupported() || !RELAY_URL || !this.circle || Notification.permission !== 'granted') return;
    const me = this.engine.replica.get<Device>('devices', this.engine.deviceId);
    if (!me?.push) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    if ((await idb.get<string>('kv', 'pushCircle')) !== this.circle.circleId) await this.registerSubscription(sub);
  }

  async test() {
    await this.send([
      {
        device: this.engine.deviceId,
        at: Date.now(),
        payload: await this.encrypt({ title: '🔔 Notifications actives', body: 'Vous recevrez ici les rappels de la famille.', tag: 'test', url: '#/', kind: 'test' }),
        urgent: true,
      },
    ]);
  }

  private async send(items: QueueItem[]) {
    if (!items.length || !this.circle || !RELAY_URL) return;
    await relayFetch(this.circle, '/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
      keepalive: true,
    });
  }

  /* ------------------------------------------------------------ rappels planifiés */

  /**
   * Après une modification locale, on recalcule les rappels de TOUS les appareils
   * (les autres n'ont peut-être pas ouvert l'appli depuis) ; après une modification reçue,
   * seulement ceux de cet appareil.
   */
  scheduleUpload(all: boolean) {
    this.needAll ||= all;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const everyone = this.needAll;
      this.needAll = false;
      this.uploadSchedules(everyone).catch((err) => console.warn('rappels', err));
    }, 2000);
  }

  reminderData(): ReminderData {
    const r = this.engine.replica;
    return {
      events: r.list('events'),
      birthdays: r.list('birthdays'),
      tasks: r.list('tasks'),
      meals: r.list('meals'),
      school: {
        members: r.list('members'),
        profiles: r.list('schoolProfiles'),
        slots: r.list('timetable'),
        homework: r.list('homework'),
        cards: r.list('cards'),
      },
    } as unknown as ReminderData;
  }

  async uploadSchedules(everyone: boolean) {
    if (!this.circle || !RELAY_URL || this.engine.sync?.status !== 'online') return;
    const data = this.reminderData();
    const targets = this.devices().filter((d) => d.push && (everyone || d.id === this.engine.deviceId));
    for (const d of targets) {
      const reminders = computeReminders(data, d.memberId, prefsOf(this.engine, d.memberId));
      const alarms = this.alarmRings(d.id);
      const key = `${this.circle.circleId}:${d.id}`;
      const fingerprint = JSON.stringify([reminders, alarms]);
      if (this.uploaded.get(key) === fingerprint) continue;
      const items: QueueItem[] = [];
      // Réveils d'abord : ils passent avant les autres rappels si la liste est pleine.
      for (const { alarm, at } of alarms) {
        const payload = await this.encrypt(alarmPayload(alarm, at));
        for (const delay of PUSH_FOLLOW_UPS) items.push({ device: d.id, at: at + delay * 60_000, payload, urgent: true });
      }
      for (const r of reminders) {
        items.push({
          device: d.id,
          at: r.at,
          topic: await topicOf(r.tag),
          urgent: r.urgent,
          payload: await this.encrypt({ title: r.title, body: r.body, tag: r.tag, url: r.url, kind: r.kind, snooze: r.kind !== 'quiz', answer: r.answer }),
        });
      }
      await relayFetch(this.circle, `/schedule/${d.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items.slice(0, MAX_SCHEDULE) }),
      });
      this.uploaded.set(key, fingerprint);
    }
  }

  /** Sonneries des 7 prochains jours des réveils rangés sur un appareil. */
  private alarmRings(deviceId: string) {
    const now = Date.now();
    return this.engine.replica
      .list<Alarm>('alarms')
      .filter((a) => a.deviceId === deviceId)
      .flatMap((alarm) => ringsBetween(alarm, now, now + ALARM_HORIZON).map((at) => ({ alarm, at })));
  }

  /** Répétition (snooze) demandée depuis l'appli : une notification dans quelques minutes. */
  async snoozeAlarm(alarm: Alarm & { id: string }, at: number) {
    await this.send([{ device: this.engine.deviceId, at, payload: await this.encrypt(alarmPayload(alarm, at)), urgent: true }]);
  }

  /** Prochains rappels de cet appareil (affichés dans l'écran Notifications). */
  upcomingForMe() {
    if (!this.engine.memberId) return [];
    return computeReminders(this.reminderData(), this.engine.memberId, prefsOf(this.engine, this.engine.memberId));
  }

  /* ------------------------------------------------------------ activité (regroupée) */

  private memberName(id: string | null | undefined) {
    return (id && this.engine.replica.get<Member>('members', id)?.name) || "Quelqu'un";
  }

  /** Appareils à prévenir : ceux des autres membres (ou de tous pour la sécurité), selon leurs préférences. */
  private targets(filter: (memberId: string, prefs: NotifPrefs) => boolean, includeMe = false): string[] {
    return this.devices()
      .filter((d) => d.push && d.id !== this.engine.deviceId && (includeMe || d.memberId !== this.engine.memberId))
      .filter((d) => filter(d.memberId, prefsOf(this.engine, d.memberId)))
      .map((d) => d.id);
  }

  private queueActivity(key: string, build: (n: number) => { payload: PushPayload; targets: string[]; urgent?: boolean }, immediate = false) {
    const cur = this.activity.get(key);
    this.activity.set(key, { count: (cur?.count ?? 0) + 1, build });
    if (this.activityTimer) clearTimeout(this.activityTimer);
    // On attend un peu pour regrouper (« Julie a ajouté 5 articles » plutôt que 5 notifications).
    this.activityTimer = setTimeout(() => this.flushActivity(), immediate ? 500 : 8000);
  }

  async flushActivity() {
    if (this.activityTimer) clearTimeout(this.activityTimer);
    const pending = [...this.activity.values()];
    this.activity.clear();
    const items: QueueItem[] = [];
    for (const { count, build } of pending) {
      const { payload, targets, urgent } = build(count);
      const enc = await this.encrypt(payload);
      const topic = await topicOf(payload.tag);
      for (const device of targets) {
        const d = this.engine.replica.get<Device>('devices', device);
        const prefs = d ? prefsOf(this.engine, d.memberId) : DEFAULT_PREFS;
        items.push({ device, at: urgent ? Date.now() : outOfQuietHours(Date.now(), prefs), payload: enc, topic, urgent });
      }
    }
    for (let i = 0; i < items.length; i += 50) await this.send(items.slice(i, i + 50)).catch(() => {});
  }

  private onLocalOps(ops: Op[]) {
    if (!this.engine.memberId) return;
    const me = this.memberName(this.engine.memberId);
    const r = this.engine.replica;
    for (const op of ops) {
      const isNew = op.cb !== undefined && !op.d;
      if (op.c === 'messages' && isNew) {
        const text = String(op.f?.text ?? '');
        this.queueActivity(`msg-${op.i}`, () => ({
          payload: { title: me, body: text.slice(0, 200), tag: 'messages', url: '#/m/messages', kind: 'message' },
          targets: this.targets((_, p) => p.messages),
        }), true);
      } else if (op.c === 'listItems' && isNew) {
        const listId = String(op.f?.listId ?? '');
        const list = r.get<{ name: string }>('lists', listId);
        const texts = r.list<{ listId: string; text: string; done: boolean }>('listItems').filter((i) => i.listId === listId && !i.done).slice(-4).map((i) => i.text);
        this.queueActivity(`list-${listId}`, (n) => ({
          payload: {
            title: `${list?.name ?? 'Liste'} · ${n} ajout${n > 1 ? 's' : ''}`,
            body: `${me} : ${texts.join(', ')}`,
            tag: `list-${listId}`,
            url: `#/m/lists/${listId}`,
            kind: 'list',
          },
          targets: this.targets((_, p) => p.lists),
        }));
      } else if (op.c === 'photos' && isNew) {
        this.queueActivity('photos', (n) => ({
          payload: { title: 'Galerie', body: `${me} a ajouté ${n} photo${n > 1 ? 's' : ''}`, tag: 'photos', url: '#/m/gallery', kind: 'photo' },
          targets: this.targets((_, p) => p.photos),
        }));
      } else if (op.c === 'events' && !op.d && op.f) {
        const ev = r.get<{ title: string; date: string; start?: string; allDay: boolean; memberIds: string[] }>('events', op.i);
        if (!ev) continue;
        const when = `${new Date(ev.date).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })}${ev.allDay ? '' : ` ${ev.start ?? ''}`}`;
        this.queueActivity(`ev-${op.i}`, () => ({
          payload: { title: isNew ? `📅 Nouvel événement` : '📅 Événement modifié', body: `${ev.title} · ${when} (par ${me})`, tag: `evchg-${op.i}`, url: '#/m/calendar', kind: 'calendar' },
          targets: this.targets((mid, p) => p.calendarChanges && (!ev.memberIds?.length || ev.memberIds.includes(mid))),
        }));
      } else if (op.c === 'tasks' && op.f && 'assigneeId' in op.f && op.f.assigneeId && op.f.assigneeId !== this.engine.memberId) {
        const task = r.get<{ title: string }>('tasks', op.i);
        const assignee = String(op.f.assigneeId);
        this.queueActivity(`task-${op.i}`, () => ({
          payload: { title: '✅ Nouvelle tâche pour vous', body: `${task?.title ?? ''} (de la part de ${me})`, tag: `taskassign-${op.i}`, url: '#/m/tasks', kind: 'task' },
          targets: this.targets((mid, p) => p.tasks && mid === assignee),
        }));
      } else if (op.c === 'homework' && isNew && op.f?.childId && op.f.childId !== this.engine.memberId) {
        const childId = String(op.f.childId);
        const title = String(op.f.title ?? '');
        const subject = String(op.f.subject ?? '');
        this.queueActivity(`hw-${op.i}`, () => ({
          payload: { title: `🏫 Nouveau dans ton cahier de textes`, body: `${subject} : ${title} (ajouté par ${me})`, tag: `hwnew-${op.i}`, url: `#/m/school/${childId}`, kind: 'school' },
          targets: this.targets((mid, p) => p.school && mid === childId),
        }));
      } else if (op.c === 'devices' && isNew) {
        // Alerte de sécurité : toujours envoyée, même pendant les heures calmes.
        const d = r.get<Device>('devices', op.i);
        this.queueActivity(`dev-${op.i}`, () => ({
          payload: {
            title: '🔐 Nouvel appareil dans le cercle',
            body: `${d?.label ?? 'Appareil'} (${this.memberName(d?.memberId)}). Si ce n'est pas normal, retirez-le dans Sécurité.`,
            tag: `dev-${op.i}`,
            url: '#/security',
            kind: 'security',
          },
          targets: this.targets(() => true, true),
          urgent: true,
        }), true);
      }
    }
  }
}

export function alarmPayload(alarm: Alarm & { id: string }, at: number): PushPayload {
  const time = new Date(at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return {
    title: `⏰ ${alarm.label || 'Réveil'} · ${time}`,
    body: alarm.mode === 'simple' ? 'Touchez pour ouvrir le réveil.' : 'Touchez pour ouvrir le réveil et relever le défi.',
    tag: `alarm-${alarm.id}`,
    url: `#/m/alarms/ring/${alarm.id}/${at}`,
    kind: 'alarm',
    alarm: { id: alarm.id, at, snoozeMin: alarm.snoozeMin ?? DEFAULT_SNOOZE, challenge: alarm.mode !== 'simple' },
  };
}
