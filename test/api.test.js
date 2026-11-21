import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-app-test-'));
  const app = createApp({ db: openDb(':memory:'), uploadDir: path.join(dir, 'uploads') });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return { base, close: () => server.close() };
}

/** Petit client HTTP qui garde son cookie de session, comme un navigateur. */
function client(base) {
  let cookie = '';
  return async (method, url, body, headers = {}) => {
    const isJson = body !== undefined && !(body instanceof Uint8Array);
    const res = await fetch(base + url, {
      method,
      headers: { ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: isJson ? JSON.stringify(body) : body,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : null };
  };
}

test('créer une famille, la rejoindre et partager des documents', async (t) => {
  const { base, close } = await startServer();
  t.after(close);
  const alice = client(base);
  const bob = client(base);
  const intruder = client(base);

  assert.equal((await alice('GET', '/me')).status, 401);

  const created = await alice('POST', '/families', { familyName: 'Les Tests', memberName: 'Alice', color: '#ff0000' });
  assert.equal(created.status, 201);
  assert.equal(created.body.family.name, 'Les Tests');
  const invite = created.body.family.inviteCode;
  assert.match(invite, /^[A-Z0-9]{8}$/);

  // Mauvais code
  assert.equal((await bob('POST', '/join/lookup', { inviteCode: 'NOPE' })).status, 404);
  // Code tapé en minuscules avec un tiret : accepté
  const lookup = await bob('POST', '/join/lookup', { inviteCode: `${invite.slice(0, 4).toLowerCase()}-${invite.slice(4)}` });
  assert.equal(lookup.body.familyName, 'Les Tests');
  assert.equal(lookup.body.members.length, 1);

  const joined = await bob('POST', '/join', { inviteCode: invite, memberName: 'Bob' });
  assert.equal(joined.status, 201);
  assert.equal(joined.body.members.length, 2);

  // Documents partagés
  const list = await alice('POST', '/docs/lists', { data: { name: 'Courses', id: 'ignored' } });
  assert.equal(list.status, 201);
  assert.notEqual(list.body.id, 'ignored');
  const item = await bob('POST', '/docs/listItems', { data: { listId: list.body.id, text: 'Pain', done: false } });
  const patched = await alice('PATCH', `/docs/listItems/${item.body.id}`, { data: { done: true } });
  assert.equal(patched.body.done, true);
  assert.equal(patched.body.text, 'Pain');

  const items = await bob('GET', '/docs/listItems');
  assert.equal(items.body.length, 1);

  // Une autre famille ne voit rien
  await intruder('POST', '/families', { familyName: 'Autres', memberName: 'Eve' });
  assert.equal((await intruder('GET', '/docs/listItems')).body.length, 0);
  assert.equal((await intruder('PATCH', `/docs/listItems/${item.body.id}`, { data: { done: false } })).status, 404);
  assert.equal((await intruder('DELETE', `/docs/lists/${list.body.id}`)).status, 404);

  // Validation
  assert.equal((await alice('POST', '/docs/bad%20name', { data: {} })).status, 400);
  assert.equal((await alice('POST', '/docs/lists', { data: [1, 2] })).status, 400);

  // Réglages de famille fusionnés
  await alice('PATCH', '/family', { settings: { accent: '#123456' } });
  const fam = await bob('PATCH', '/family', { settings: { homeModules: ['lists'] } });
  assert.deepEqual(fam.body.settings, { accent: '#123456', homeModules: ['lists'] });

  // Membres
  const kid = await alice('POST', '/members', { name: 'Léo', color: '#00aa00' });
  assert.equal(kid.status, 201);
  assert.equal((await alice('DELETE', `/members/${created.body.member.id}`)).status, 400);
  assert.equal((await alice('DELETE', `/members/${kid.body.id}`)).status, 204);

  // Déconnexion
  assert.equal((await bob('POST', '/logout')).status, 204);
  assert.equal((await bob('GET', '/me')).status, 401);
});

test('photos : envoi, lecture protégée, suppression via le document', async (t) => {
  const { base, close } = await startServer();
  t.after(close);
  const alice = client(base);
  const eve = client(base);
  await alice('POST', '/families', { familyName: 'Photos', memberName: 'Alice' });
  await eve('POST', '/families', { familyName: 'Autre', memberName: 'Eve' });

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  assert.equal((await alice('POST', '/files', png, { 'Content-Type': 'text/plain' })).status, 415);
  const up = await alice('POST', '/files', png, { 'Content-Type': 'image/png' });
  assert.equal(up.status, 201);

  assert.equal((await alice('GET', `/files/${up.body.id}`)).status, 200);
  assert.equal((await eve('GET', `/files/${up.body.id}`)).status, 404);

  const photo = await alice('POST', '/docs/photos', { data: { fileId: up.body.id, caption: 'Plage' } });
  await alice('DELETE', `/docs/photos/${photo.body.id}`);
  assert.equal((await alice('GET', `/files/${up.body.id}`)).status, 404);
});
