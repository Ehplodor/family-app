// Tests d'intégration du relais. Lancer d'abord `npm run dev:test` (limites basses pour les tester), puis `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import ece from 'http_ece';

const BASE = process.env.RELAY_URL || 'http://127.0.0.1:8787';
const hex = () => crypto.randomBytes(16).toString('hex');
const token = () => crypto.randomBytes(32).toString('base64url');

// En local, l'en-tête CF-Connecting-IP permet de simuler des connexions différentes
// (en production, c'est Cloudflare qui le fixe : impossible à falsifier).
const randomIp = () => `198.51.100.${crypto.randomInt(1, 254)}-${hex().slice(0, 6)}`;

// X-Test-Bucket cloisonne le plafond global entre les tests (accepté seulement avec ALLOW_TEST_BUCKETS=1).
async function call(method, path, tok, body, ip = randomIp(), bucket = hex()) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'CF-Connecting-IP': ip,
      'X-Test-Bucket': bucket,
      ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
      ...(body && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, body: type.includes('json') ? await res.json() : await res.arrayBuffer() };
}

function socket(circle) {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/c/${circle}/ws`);
  const queue = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    const w = waiters.findIndex((x) => x.pred(m));
    if (w >= 0) waiters.splice(w, 1)[0].resolve(m);
    else queue.push(m);
  };
  const next = (pred = () => true, ms = 5000) =>
    new Promise((resolve, reject) => {
      const i = queue.findIndex(pred);
      if (i >= 0) return resolve(queue.splice(i, 1)[0]);
      waiters.push({ pred, resolve });
      setTimeout(() => reject(new Error('timeout')), ms);
    });
  const open = new Promise((r) => (ws.onopen = r));
  const closed = new Promise((r) => (ws.onclose = (e) => r(e.code)));
  return { ws, next, open, closed, send: (m) => ws.send(JSON.stringify(m)) };
}

test('enregistrement, authentification et synchronisation temps réel', async () => {
  const circle = hex();
  const tok = token();
  assert.equal((await call('POST', `/c/${circle}/register`, null, { token: tok })).status, 200);
  assert.equal((await call('POST', `/c/${circle}/register`, null, { token: token() })).status, 403);
  assert.equal((await call('GET', `/c/${circle}/blobs/${hex()}`, token())).status, 403);

  const intruder = socket(circle);
  await intruder.open;
  intruder.send({ t: 'hello', token: token(), since: 0 });
  assert.equal(await intruder.closed, 4003);

  const a = socket(circle);
  const b = socket(circle);
  await Promise.all([a.open, b.open]);
  const devA = hex();
  a.send({ t: 'hello', token: tok, device: devA, since: 0 });
  b.send({ t: 'hello', token: tok, device: hex(), since: 0 });
  assert.equal((await a.next((m) => m.t === 'ready')).seq, 0);
  await b.next((m) => m.t === 'ready');

  a.send({ t: 'push', id: 'x1', data: 'CHIFFRE-1' });
  const ack = await a.next((m) => m.t === 'ack');
  assert.equal(ack.seq, 1);
  const got = await b.next((m) => m.t === 'batch');
  assert.deepEqual([got.seq, got.data, got.device], [1, 'CHIFFRE-1', devA]);
  a.send({ t: 'push', id: 'x2', data: 'CHIFFRE-2' });
  await a.next((m) => m.t === 'ack');

  // Un appareil qui revient récupère ce qu'il a manqué
  const c = socket(circle);
  await c.open;
  c.send({ t: 'hello', token: tok, since: 1 });
  assert.equal((await c.next((m) => m.t === 'batch')).data, 'CHIFFRE-2');
  assert.equal((await c.next((m) => m.t === 'ready')).seq, 2);

  // Compaction par instantané
  a.send({ t: 'snapshot', seq: 2, data: 'INSTANTANE' });
  await new Promise((r) => setTimeout(r, 200));
  const d = socket(circle);
  await d.open;
  d.send({ t: 'hello', token: tok, since: 0 });
  const snap = await d.next();
  assert.deepEqual([snap.t, snap.seq, snap.data], ['snapshot', 2, 'INSTANTANE']);
  assert.equal((await d.next()).t, 'ready');
  for (const s of [a, b, c, d]) s.ws.close();

  // Photos chiffrées
  const blob = hex();
  assert.equal((await call('PUT', `/c/${circle}/blobs/${blob}`, tok, new Uint8Array([1, 2, 3]))).status, 200);
  assert.deepEqual([...new Uint8Array((await call('GET', `/c/${circle}/blobs/${blob}`, tok)).body)], [1, 2, 3]);

  // Effacement total
  assert.equal((await call('DELETE', `/c/${circle}`, tok)).status, 200);
  assert.equal((await call('GET', `/c/${circle}/blobs/${blob}`, tok)).status, 403);
});

test('notifications Web Push : immédiates, planifiées, contenu illisible pour le relais', async (t) => {
  const circle = hex();
  const tok = token();
  await call('POST', `/c/${circle}/register`, null, { token: tok });
  const vapid = (await call('GET', '/vapid')).body.publicKey;
  assert.ok(vapid, 'clé VAPID publique');

  // Faux service push (joue le rôle de FCM / APNs) + clés d'un « navigateur »
  const browserKey = crypto.createECDH('prime256v1');
  browserKey.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const device = hex();
  const sub = {
    endpoint: `http://127.0.0.1:${server.address().port}/push/abc`,
    keys: { p256dh: browserKey.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') },
  };
  assert.equal((await call('PUT', `/c/${circle}/subs/${device}`, tok, sub)).status, 200);

  const decrypt = (body) =>
    ece.decrypt(body, { version: 'aes128gcm', privateKey: browserKey, authSecret }).toString('utf8');

  await call('POST', `/c/${circle}/notify`, tok, { items: [{ device, payload: 'NOTIF-CHIFFREE', topic: 'msg', urgent: true }] });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(received.length, 1);
  assert.equal(decrypt(received[0].body), 'NOTIF-CHIFFREE');
  assert.match(received[0].headers.authorization, /^vapid t=.+, k=/);
  assert.equal(received[0].headers.urgency, 'high');
  assert.equal(received[0].headers.topic, 'msg');

  // Planification : remplacée à chaque envoi, déclenchée par l'alarme du Durable Object
  await call('PUT', `/c/${circle}/schedule/${device}`, tok, { items: [{ at: Date.now() + 60_000, payload: 'ANCIEN' }] });
  await call('PUT', `/c/${circle}/schedule/${device}`, tok, { items: [{ at: Date.now() + 1500, payload: 'RAPPEL' }] });
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(received.length, 2);
  assert.equal(decrypt(received[1].body), 'RAPPEL');
});

test('invitation : boîte aux lettres à usage unique', async () => {
  const id = hex();
  assert.equal((await call('GET', `/i/${id}/request`)).status, 204);
  await call('POST', `/i/${id}/request`, null, { data: 'DEMANDE' });
  assert.equal((await call('GET', `/i/${id}/request`)).body.data, 'DEMANDE');
  assert.equal((await call('POST', `/i/${id}/response`, null, { data: 'REPONSE' })).status, 200);
  assert.equal((await call('POST', `/i/${id}/response`, null, { data: 'AUTRE' })).status, 409);
  assert.equal((await call('GET', `/i/${id}/response`)).body.data, 'REPONSE');
  await call('POST', `/i/${id}/done`);
  assert.equal((await call('GET', `/i/${id}/response`)).status, 410);
});

test('relais public : nouvelles familles limitées par connexion et par jour', async () => {
  const limits = (await call('GET', '/limits')).body;
  assert.equal(limits.newCirclesPerIpPerDay, 3, 'lancer le relais avec `npm run dev:test`');
  const ip = randomIp();
  const circles = Array.from({ length: 4 }, () => ({ id: hex(), tok: token() }));
  const statuses = [];
  for (const c of circles) statuses.push((await call('POST', `/c/${c.id}/register`, null, { token: c.tok }, ip)).status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  // Une famille existante se reconnecte sans être comptée
  assert.equal((await call('POST', `/c/${circles[0].id}/register`, null, { token: circles[0].tok }, ip)).status, 200);
  // Une autre connexion peut toujours créer sa famille
  assert.equal((await call('POST', `/c/${hex()}/register`, null, { token: token() })).status, 200);

  // Renouvellement de clé : la même famille, pas comptée… à condition de prouver le jeton de l'ancien cercle
  const rotated = { from: circles[0].id, fromToken: circles[0].tok };
  assert.equal((await call('POST', `/c/${hex()}/register`, null, { token: token(), ...rotated }, ip)).status, 200);
  const forged = { from: circles[0].id, fromToken: token() };
  assert.equal((await call('POST', `/c/${hex()}/register`, null, { token: token(), ...forged }, ip)).status, 429);
});

test('relais public : plafond global de nouvelles familles par jour', async () => {
  const limits = (await call('GET', '/limits')).body;
  assert.equal(limits.newCirclesPerDay, 5);
  const bucket = hex(); // un « jour » isolé pour ce test
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await call('POST', `/c/${hex()}/register`, null, { token: token() }, randomIp(), bucket)).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
});

test('relais public : quota progressif par famille', async () => {
  const circle = hex();
  const tok = token();
  await call('POST', `/c/${circle}/register`, null, { token: tok });
  // En test : 0,5 Mo le premier jour (au lieu de 20 Mo), maximum 1 Mo
  const photo = new Uint8Array(300 * 1024);
  assert.equal((await call('PUT', `/c/${circle}/blobs/${hex()}`, tok, photo)).status, 200);
  const full = await call('PUT', `/c/${circle}/blobs/${hex()}`, tok, photo);
  assert.equal(full.status, 507);
  assert.match(full.body.error, /pour l'instant/);
  // Le quota bloque aussi le journal de synchronisation
  const ws = socket(circle);
  await ws.open;
  ws.send({ t: 'hello', token: tok, since: 0 });
  await ws.next((m) => m.t === 'ready');
  ws.send({ t: 'push', id: 'q', data: 'x'.repeat(300 * 1024) });
  assert.equal((await ws.next((m) => m.t === 'error')).error, 'quota');
  ws.ws.close();
});

test('relais public : un cercle abandonné est effacé', async () => {
  const circle = hex();
  const tok = token();
  await call('POST', `/c/${circle}/register`, null, { token: tok });
  const blob = hex();
  await call('PUT', `/c/${circle}/blobs/${blob}`, tok, new Uint8Array([1]));
  assert.equal((await call('GET', `/c/${circle}/blobs/${blob}`, tok)).status, 200);
  await new Promise((r) => setTimeout(r, 19_000)); // INACTIVE_DAYS = 0.0002 jour ≈ 17 s en test
  assert.equal((await call('GET', `/c/${circle}/blobs/${blob}`, tok)).status, 403);
});
