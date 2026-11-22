/**
 * Notifications : abonnement push, envoi des rappels planifiés au relais,
 * notifications d'activité (messages, listes, agenda…) regroupées.
 *
 * Le contenu de chaque notification est chiffré avec la clé de l'espace AVANT d'être confié
 * au relais : seul le service worker d'un appareil de la famille peut l'afficher, et chaque rappel
 * n'est envoyé qu'aux appareils autorisés dans un cercle qui voit l'élément.
 */
import * as idb from './idb';
import { fromB64url } from './bytes';
import { sealJSON } from './crypto';
import type { Device, Engine, Member } from './engine';
import type { Op } from './replica';
import { V2 } from './circles';
import type { Item } from './vault';
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
  const p = engine.vault.get<Partial<NotifPrefs>>('prefs', memberId);
  return { ...DEFAULT_PREFS, ...(p && p.owner === memberId ? p : {}) };
}

/** Courte empreinte pour regrouper/remplacer les notifications côté service push (en-tête Topic). */
async function topicOf(tag: string) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tag)));
  return [...h.slice(0, 12)].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 24);
}

/** Les réveils sont planifiés sur 7 jours (l'appli recalcule à chaque ouverture). */
const ALARM_HORIZON = 7 * 86400_000;
const MAX_SCHEDULE = 300; // limite du relais par appareil

type Target = Device & { id: string };

export class Notifier {
  private uploaded = new Map<string, string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private needAll = false;
  private activity = new Map<string, { count: number; build: (n: number) => { payload: PushPayload; targets: string[]; urgent?: boolean } | null }>();
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  private localChange = false;

  constructor(private engine: Engine) {
    engine.replica.onChange((cols, local) => {
      if ([...cols].some((c) => c.startsWith(V2))) this.localChange ||= local;
    });
    const prevOnLocal = engine.replica.onLocalOps;
    engine.replica.onLocalOps = (ops) => {
      prevOnLocal?.(ops);
      this.onLocalOps(ops);
    };
    // Les données sont vérifiées et déchiffrées par le coffre : on replanifie quand elles changent.
    let version = engine.vault.getVersion();
    engine.vault.subscribe(() => {
      if (engine.vault.getVersion() === version) return;
      version = engine.vault.getVersion();
      this.scheduleUpload(this.localChange);
      this.localChange = false;
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.flushActivity();
    });
  }

  private get circle() {
    return this.engine.circle;
  }

  /** Appareils connus : informations publiées par leur membre, et appareil bien autorisé pour ce membre. */
  private devices(): Target[] {
    const v = this.engine.vault;
    return v
      .list<Device>('deviceInfo')
      .filter((d) => !d.revoked && d.memberId === d.owner && v.memberOf(d.id) === d.owner && !v.isLost(d.id));
  }
  private device(id: string): Target | undefined {
    return this.devices().find((d) => d.id === id);
  }

  private async encrypt(p: PushPayload) {
    return sealJSON(this.circle!.key, p, `${this.circle!.circleId}:push`);
  }

  /* ------------------------------------------------------------ abonnement de CET appareil */

  permission(): NotificationPermission | 'unsupported' {
    return pushSupported() ? Notification.permission : 'unsupported';
  }

  private async setPush(push: boolean) {
    const v = this.engine.vault;
    if (v.get('deviceInfo', this.engine.deviceId)) await v.update<Device>('deviceInfo', this.engine.deviceId, { push });
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
    await this.setPush(true);
  }

  private async registerSubscription(sub: PushSubscription) {
    await relayFetch(this.circle!, `/subs/${this.engine.deviceId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub.toJSON()),
    });
    await idb.put('kv', 'pushCircle', `${this.circle!.circleId}:${this.engine.deviceId}`);
  }

  async disable() {
    const reg = await navigator.serviceWorker?.getRegistration();
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
    if (this.circle) await relayFetch(this.circle, `/subs/${this.engine.deviceId}`, { method: 'DELETE' }).catch(() => {});
    await this.setPush(false);
  }

  /** Après un changement d'espace ou au démarrage : réenregistre l'abonnement si besoin. */
  async ensureSubscription() {
    if (!pushSupported() || !RELAY_URL || !this.circle || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    if ((await idb.get<string>('kv', 'pushCircle')) !== `${this.circle.circleId}:${this.engine.deviceId}`) await this.registerSubscription(sub);
    const me = this.engine.vault.get<Device>('deviceInfo', this.engine.deviceId);
    if (me && !me.push) await this.setPush(true);
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
   * Après une modification locale, on recalcule les rappels de TOUS les appareils des cercles concernés
   * (les autres n'ont peut-être pas ouvert l'appli depuis) ; après une modification reçue, seulement ceux de
   * cet appareil.
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

  /** Données des rappels, limitées aux éléments visibles par un cercle (tous si `circle` absent). */
  reminderData(circle?: string): ReminderData {
    const v = this.engine.vault;
    const l = (name: string) => v.list(name).filter((x: Item<unknown>) => !circle || x.groups.includes(circle));
    return {
      events: l('events'),
      birthdays: l('birthdays'),
      tasks: l('tasks'),
      meals: l('meals'),
      school: {
        members: v.list('members'),
        profiles: l('schoolProfiles'),
        slots: l('timetable'),
        homework: l('homework'),
        cards: l('cards'),
      },
    } as unknown as ReminderData;
  }

  /**
   * Chaque appareil a :
   *  - une liste principale (ses réveils), envoyée seulement par les appareils de son membre ;
   *  - une liste par cercle, calculée par les appareils autorisés de ce cercle, avec les seuls éléments que ce
   *    cercle voit. Un appareil qui ne voit pas un cercle ne peut donc ni lire ni effacer ses rappels.
   *    (Un élément visible par deux cercles donne deux rappels identiques, fusionnés par le téléphone.)
   */
  async uploadSchedules(everyone: boolean) {
    if (!this.circle || !RELAY_URL || this.engine.sync?.status !== 'online' || !this.engine.migrated) return;
    const me = this.engine.deviceId;
    const myMember = this.engine.memberId;
    const devices = this.devices().filter((d) => d.push);
    for (const d of devices.filter((x) => x.memberId === myMember && (everyone || x.id === me))) {
      const alarms = this.alarmRings(d.id);
      const key = `${this.circle.circleId}:${d.id}`;
      const fingerprint = JSON.stringify(alarms);
      if (this.uploaded.get(key) === fingerprint) continue;
      const items: QueueItem[] = [];
      for (const { alarm, at } of alarms) {
        const payload = await this.encrypt(alarmPayload(alarm, at));
        for (const delay of PUSH_FOLLOW_UPS) items.push({ device: d.id, at: at + delay * 60_000, payload, urgent: true });
      }
      await relayFetch(this.circle, `/schedule/${d.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items.slice(0, MAX_SCHEDULE) }),
      });
      this.uploaded.set(key, fingerprint);
    }
    for (const c of this.engine.vault.circles()) {
      if (c.outdated) continue;
      const holders = this.engine.vault.holders(c.id);
      if (!holders.has(me)) continue;
      const data = this.reminderData(c.id);
      for (const d of devices) {
        if (holders.get(d.id) !== d.memberId || !(everyone || d.id === me)) continue;
        await this.putPart(d.id, c.id, computeReminders(data, d.memberId, prefsOf(this.engine, d.memberId)));
      }
    }
  }

  /** Remplace la liste de rappels d'un appareil pour un cercle (liste vide = effacer). */
  async putPart(deviceId: string, groupId: string, reminders: ReturnType<typeof computeReminders>) {
    if (!this.circle || !RELAY_URL) return;
    const key = `${this.circle.circleId}:${deviceId}:${groupId}`;
    const fingerprint = JSON.stringify(reminders);
    if (this.uploaded.get(key) === fingerprint) return;
    const items: QueueItem[] = [];
    for (const r of reminders) {
      items.push({
        device: deviceId,
        at: r.at,
        topic: await topicOf(r.tag),
        urgent: r.urgent,
        payload: await this.encrypt({ title: r.title, body: r.body, tag: r.tag, url: r.url, kind: r.kind, snooze: r.kind !== 'quiz', answer: r.answer }),
      });
    }
    await relayFetch(this.circle, `/part-schedule/${deviceId}/${groupId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: items.slice(0, MAX_SCHEDULE) }),
    });
    this.uploaded.set(key, fingerprint);
  }

  /** Après l'exclusion d'un membre ou la perte d'un appareil : ces appareils ne reçoivent plus les rappels du cercle. */
  async clearParts(groupId: string, deviceIds: string[]) {
    for (const id of deviceIds) {
      this.uploaded.delete(`${this.circle?.circleId}:${id}:${groupId}`);
      await this.putPart(id, groupId, []).catch(() => {});
    }
  }

  /** Sonneries des 7 prochains jours des réveils rangés sur un appareil. */
  private alarmRings(deviceId: string) {
    const now = Date.now();
    return this.engine.vault
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
    const memberId = this.engine.memberId;
    if (!memberId) return [];
    const prefs = prefsOf(this.engine, memberId);
    const seen = new Set<string>();
    return computeReminders(this.reminderData(), memberId, prefs)
      .filter((r) => !seen.has(r.tag) && !!seen.add(r.tag))
      .sort((a, b) => a.at - b.at);
  }

  /* ------------------------------------------------------------ activité (regroupée) */

  private memberName(id: string | null | undefined) {
    return (id && this.engine.vault.get<Member>('members', id)?.name) || "Quelqu'un";
  }

  /**
   * Appareils à prévenir pour un élément : appareils autorisés dans un des cercles qui le voient, des autres
   * membres (ou de tous pour la sécurité), selon leurs préférences.
   */
  private targets(groups: string[], filter: (memberId: string, prefs: NotifPrefs) => boolean, includeMe = false): string[] {
    const v = this.engine.vault;
    const allowed = new Map<string, string>();
    for (const g of groups) for (const [d, m] of v.holders(g)) allowed.set(d, m);
    return this.devices()
      .filter((d) => d.push && d.id !== this.engine.deviceId && allowed.get(d.id) === d.memberId && (includeMe || d.memberId !== this.engine.memberId))
      .filter((d) => filter(d.memberId, prefsOf(this.engine, d.memberId)))
      .map((d) => d.id);
  }

  private queueActivity(key: string, build: (n: number) => { payload: PushPayload; targets: string[]; urgent?: boolean } | null, immediate = false) {
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
      const b = build(count);
      if (!b) continue;
      const { payload, targets, urgent } = b;
      const enc = await this.encrypt(payload);
      const topic = await topicOf(payload.tag);
      for (const device of targets) {
        const d = this.device(device);
        const prefs = d ? prefsOf(this.engine, d.memberId) : DEFAULT_PREFS;
        items.push({ device, at: urgent ? Date.now() : outOfQuietHours(Date.now(), prefs), payload: enc, topic, urgent });
      }
    }
    for (let i = 0; i < items.length; i += 50) await this.send(items.slice(i, i + 50)).catch(() => {});
  }

  /** Modifications faites ici : le contenu est lu dans le coffre au moment d'envoyer (après enregistrement). */
  private onLocalOps(ops: Op[]) {
    if (!this.engine.memberId) return;
    const me = this.memberName(this.engine.memberId);
    const v = this.engine.vault;
    const circleName = (groups: string[]) => {
      const c = groups.map((g) => v.circle(g)).find((x) => x && !x.personal);
      return c && groups.length === 1 ? ` · ${c.name}` : '';
    };
    for (const op of ops) {
      if (!op.c.startsWith(V2) || op.d) continue;
      const name = op.c.slice(V2.length);
      const isNew = op.cb !== undefined;
      const get = <T,>() => {
        const it = v.get<T>(name, op.i);
        return it && it.groups.some((g) => !v.circle(g)?.personal) ? it : undefined;
      };
      if (name === 'messages' && isNew) {
        this.queueActivity(`msg-${op.i}`, () => {
          const m = get<{ text: string }>();
          if (!m) return null;
          return {
            payload: { title: `${me}${circleName(m.groups)}`, body: String(m.text ?? '').slice(0, 200), tag: `messages-${m.groups[0]}`, url: `#/m/messages/${m.groups[0]}`, kind: 'message' },
            targets: this.targets(m.groups, (_, p) => p.messages),
          };
        }, true);
      } else if (name === 'listItems' && isNew) {
        // Regroupé par liste, une fois l'élément enregistré dans le coffre.
        setTimeout(() => {
          const it = get<{ listId: string }>();
          if (!it) return;
          const listId = it.listId;
          this.queueActivity(`list-${listId}`, (n) => {
            const list = v.get<{ name: string }>('lists', listId);
            const texts = v.list<{ listId: string; text: string; done: boolean }>('listItems').filter((i) => i.listId === listId && !i.done).slice(-4).map((i) => i.text);
            return {
              payload: { title: `${list?.name ?? 'Liste'} · ${n} ajout${n > 1 ? 's' : ''}`, body: `${me} : ${texts.join(', ')}`, tag: `list-${listId}`, url: `#/m/lists/${listId}`, kind: 'list' },
              targets: this.targets(it.groups, (_, p) => p.lists),
            };
          });
        }, 100);
      } else if (name === 'photos' && isNew) {
        this.queueActivity('photos', (n) => {
          const ph = get();
          if (!ph) return null;
          return {
            payload: { title: 'Galerie', body: `${me} a ajouté ${n} photo${n > 1 ? 's' : ''}`, tag: 'photos', url: '#/m/gallery', kind: 'photo' },
            targets: this.targets(ph.groups, (_, p) => p.photos),
          };
        });
      } else if (name === 'events') {
        this.queueActivity(`ev-${op.i}`, () => {
          const ev = get<{ title: string; date: string; start?: string; allDay: boolean; memberIds: string[] }>();
          if (!ev) return null;
          const when = `${new Date(ev.date).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })}${ev.allDay ? '' : ` ${ev.start ?? ''}`}`;
          return {
            payload: { title: isNew ? `📅 Nouvel événement` : '📅 Événement modifié', body: `${ev.title} · ${when} (par ${me})`, tag: `evchg-${op.i}`, url: '#/m/calendar', kind: 'calendar' },
            targets: this.targets(ev.groups, (mid, p) => p.calendarChanges && (!ev.memberIds?.length || ev.memberIds.includes(mid))),
          };
        });
      } else if (name === 'tasks') {
        this.queueActivity(`task-${op.i}`, () => {
          const task = get<{ title: string; assigneeId?: string }>();
          const assignee = task?.assigneeId;
          if (!task || !assignee || assignee === this.engine.memberId || !isNew) return null;
          return {
            payload: { title: '✅ Nouvelle tâche pour vous', body: `${task.title ?? ''} (de la part de ${me})`, tag: `taskassign-${op.i}`, url: '#/m/tasks', kind: 'task' },
            targets: this.targets(task.groups, (mid, p) => p.tasks && mid === assignee),
          };
        });
      } else if (name === 'homework' && isNew) {
        this.queueActivity(`hw-${op.i}`, () => {
          const hw = get<{ childId: string; title: string; subject: string }>();
          if (!hw || hw.childId === this.engine.memberId) return null;
          return {
            payload: { title: `🏫 Nouveau dans ton cahier de textes`, body: `${hw.subject} : ${hw.title} (ajouté par ${me})`, tag: `hwnew-${op.i}`, url: `#/m/school/${hw.childId}`, kind: 'school' },
            targets: this.targets(hw.groups, (mid, p) => p.school && mid === hw.childId),
          };
        });
      } else if (name === 'deviceInfo' && isNew) {
        // Alerte de sécurité : toujours envoyée, même pendant les heures calmes.
        this.queueActivity(`dev-${op.i}`, () => {
          const d = v.get<Device>('deviceInfo', op.i);
          if (!d) return null;
          return {
            payload: {
              title: '🔐 Nouvel appareil dans vos cercles',
              body: `${d.label ?? 'Appareil'} (${this.memberName(d.memberId)}). Si ce n'est pas normal, déclarez-le perdu dans Cercles.`,
              tag: `dev-${op.i}`,
              url: '#/circles',
              kind: 'security',
            },
            targets: this.targets(d.groups, () => true, true),
            urgent: true,
          };
        }, true);
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
