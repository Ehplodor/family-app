/// <reference lib="webworker" />
/**
 * Service worker :
 *  - fonctionnement hors ligne (l'appli s'ouvre sans réseau, les données sont locales) ;
 *  - réception des notifications push : leur contenu est chiffré avec la clé du cercle,
 *    déchiffré ici, sur l'appareil, puis affiché ;
 *  - action « Rappeler dans 1 h » ;
 *  - réveils : notification insistante, « Répéter » / « Arrêter », relances ignorées une fois arrêté.
 */
import * as idb from './lib/idb';
import { openJSON, sealJSON } from './lib/crypto';
import type { StoredCircle, Identity } from './lib/engine';
import type { AlarmPush, PushPayload } from './lib/notify';
import { alarmDoneKey, markAlarmDone } from './lib/alarmState';

declare const self: ServiceWorkerGlobalScope;
declare const __RELAY_URL__: string;
const RELAY = __RELAY_URL__.replace(/\/$/, '');
const CACHE = 'family-app-v2';
const scope = () => self.registration.scope;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      // Pré-cache : la page et les fichiers qu'elle référence (JS/CSS versionnés).
      const cache = await caches.open(CACHE);
      const res = await fetch(scope(), { cache: 'no-cache' });
      const html = await res.clone().text();
      await cache.put(scope(), res);
      const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => new URL(m[1], scope()).href).filter((u) => u.startsWith(scope()));
      await cache.addAll([...new Set(assets)]).catch(() => {});
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(scope(), copy));
          return res;
        })
        .catch(async () => (await caches.match(scope(), { ignoreVary: true })) ?? Response.error()),
    );
    return;
  }
  event.respondWith(
    caches.match(req, { ignoreVary: true }).then(
      (hit) =>
        hit ??
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});

async function decrypt(data: string): Promise<PushPayload | null> {
  const circle = await idb.get<StoredCircle>('kv', 'circle');
  if (!circle) return null;
  try {
    return await openJSON<PushPayload>(circle.key, data, `${circle.circleId}:push`);
  } catch {
    return null;
  }
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      const raw = event.data?.text() ?? '';
      const p = await decrypt(raw);
      if (p?.alarm) return showAlarm(p, raw);
      // Contenu illisible (clé renouvelée, données effacées) : notification neutre, sans détail.
      const title = p?.title ?? 'Family App';
      const options: NotificationOptions & { actions?: { action: string; title: string }[]; renotify?: boolean } = {
        body: p?.body ?? 'Nouvelle notification',
        tag: p?.tag,
        icon: new URL('icon-192.png', scope()).href,
        badge: new URL('icon-192.png', scope()).href,
        data: { url: p?.url ?? '#/', raw, tag: p?.tag },
        renotify: !!p?.tag,
      };
      if (p?.answer) options.actions = [{ action: 'reveal', title: 'Voir la réponse' }];
      else if (p?.snooze) options.actions = [{ action: 'snooze', title: 'Rappeler dans 1 h' }];
      if (p?.answer) (options.data as Record<string, unknown>).answer = p.answer;
      await self.registration.showNotification(title, options);
    })(),
  );
});

/* ------------------------------------------------------------------ Réveils */

const icon = () => new URL('icon-192.png', scope()).href;

async function showAlarm(p: PushPayload, raw: string) {
  const a = p.alarm!;
  const done = (await idb.get<number>('kv', alarmDoneKey(a.id))) ?? 0;
  if (done >= a.at) {
    // Déjà arrêté (relance devenue inutile) : le navigateur exige d'afficher quelque chose,
    // on affiche donc une notification silencieuse qu'on retire aussitôt.
    await self.registration.showNotification(p.title, { tag: `${p.tag}-done`, silent: true });
    for (const n of await self.registration.getNotifications({ tag: `${p.tag}-done` })) n.close();
    return;
  }
  // Appli ouverte au premier plan : elle sonne elle-même.
  for (const c of await self.clients.matchAll({ type: 'window' })) {
    if ((c as WindowClient).visibilityState === 'visible') c.postMessage({ type: 'navigate', url: p.url });
  }
  const options: NotificationOptions & Record<string, unknown> = {
    body: p.body,
    tag: p.tag,
    icon: icon(),
    badge: icon(),
    data: { url: p.url, raw, tag: p.tag, alarm: a },
    renotify: true,
    requireInteraction: true,
    vibrate: [800, 300, 800, 300, 800, 300, 800],
    actions: [
      { action: 'alarm-snooze', title: `Répéter (${a.snoozeMin} min)` },
      // Un réveil à défi ne s'arrête que dans l'appli.
      ...(a.challenge ? [] : [{ action: 'alarm-stop', title: 'Arrêter' }]),
    ],
  };
  await self.registration.showNotification(p.title, options);
}

async function alarmAction(action: string, a: AlarmPush, url: string) {
  await markAlarmDone(a.id, a.at);
  if (action !== 'alarm-snooze') return;
  const circle = await idb.get<StoredCircle>('kv', 'circle');
  const identity = await idb.get<Identity>('kv', 'identity');
  if (!circle || !identity || !RELAY) return;
  const at = Date.now() + a.snoozeMin * 60_000;
  const old = (await self.registration.getNotifications()).find((n) => n.data?.alarm?.id === a.id);
  const next: PushPayload = {
    title: old?.title ?? '⏰ Réveil',
    body: old?.body ?? '',
    tag: `alarm-${a.id}`,
    url: url.replace(/\/\d+$/, `/${at}`),
    kind: 'alarm',
    alarm: { ...a, at },
  };
  await fetch(`${RELAY}/c/${circle.circleId}/notify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${circle.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ device: identity.deviceId, at, payload: await sealJSON(circle.key, next, `${circle.circleId}:push`), urgent: true }] }),
  });
}

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  n.close();
  const alarm = (n.data as { alarm?: AlarmPush } | undefined)?.alarm;
  if (alarm && (event.action === 'alarm-snooze' || event.action === 'alarm-stop')) {
    event.waitUntil(alarmAction(event.action, alarm, n.data.url ?? ''));
    return;
  }
  const { url, raw, tag, answer } = (n.data ?? {}) as { url?: string; raw?: string; tag?: string; answer?: string };
  // Petite question : la réponse s'affiche sans ouvrir l'appli (Android). Toucher la réponse
  // ouvre l'appli pour indiquer « je savais » ou « à revoir ».
  if (event.action === 'reveal' && answer) {
    event.waitUntil(
      self.registration.showNotification(`💡 ${n.body}`, {
        body: answer,
        tag,
        icon: new URL('icon-192.png', scope()).href,
        data: { url },
      }),
    );
    return;
  }
  if (event.action === 'snooze' && raw) {
    event.waitUntil(
      (async () => {
        const circle = await idb.get<StoredCircle>('kv', 'circle');
        const identity = await idb.get<Identity>('kv', 'identity');
        if (!circle || !identity || !RELAY) return;
        await fetch(`${RELAY}/c/${circle.circleId}/notify`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${circle.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: [{ device: identity.deviceId, at: Date.now() + 3600_000, payload: raw, topic: undefined, urgent: true }] }),
        });
      })(),
    );
    return;
  }
  event.waitUntil(
    (async () => {
      const target = new URL(url ?? '#/', scope()).href;
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = all.find((c) => c.url.startsWith(scope()));
      if (existing) {
        existing.postMessage({ type: 'navigate', url: url ?? '#/' });
        await existing.focus();
      } else {
        await self.clients.openWindow(target);
      }
      void tag;
    })(),
  );
});
