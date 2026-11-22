import { describe, expect, it, vi } from 'vitest';

vi.mock('./idb', () => ({
  putMany: async () => {},
  entries: async () => [],
  get: async () => undefined,
  put: async () => {},
}));

import { Replica } from './replica';
import { itemsToMigrate, migrationAdmin, oldInfo } from './migrate';

/** Famille de l'ancien format : Rod (créateur, 1 téléphone), Julie (1 téléphone), Léo (enfant, sans appareil). */
async function oldFamily() {
  const r = new Replica('d-rod');
  const pub = { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' };
  r.memberId = 'rod';
  await r.upsert('members', 'rod', { name: 'Rod', color: '#111' });
  await r.upsert('settings', 'family', { name: 'Les Martin', accent: '#f00' });
  await r.upsert('members', 'julie', { name: 'Julie', color: '#222' });
  await r.upsert('members', 'leo', { name: 'Léo', color: '#333', kind: 'child' });
  await r.upsert('devices', 'd-rod', { memberId: 'rod', label: 'Android', pub });
  await r.upsert('devices', 'd-julie', { memberId: 'julie', label: 'iPhone', pub });
  await r.upsert('devices', 'd-vieux', { memberId: 'julie', label: 'Ancien', pub, revoked: true });
  await r.create('events', { title: 'De Rod' }, 'e1');
  await r.create('alarms', { label: 'Réveil Rod', deviceId: 'd-rod' }, 'a1');
  await r.upsert('prefs', 'rod', { messages: true });
  r.memberId = 'julie';
  await r.create('events', { title: 'De Julie' }, 'e2');
  await r.create('messages', { text: 'Coucou' }, 'm1');
  await r.upsert('prefs', 'julie', { messages: false });
  r.memberId = 'ancien';
  await r.create('recipes', { title: "D'un ancien membre" }, 'r1');
  return r;
}

describe('migration vers les cercles', () => {
  it("l'admin est le créateur de la famille ; le nom de la famille et les appareils actifs sont repris", async () => {
    const r = await oldFamily();
    expect(migrationAdmin(r)).toBe('rod');
    const info = oldInfo(r);
    expect(info.famName).toBe('Les Martin');
    expect(info.devices.map((d) => d.id).sort()).toEqual(['d-julie', 'd-rod']);
    expect(info.members.sort()).toEqual(['julie', 'leo', 'rod']);
  });

  it('chacun republie ses propres données ; l’admin, celles des personnes sans appareil', async () => {
    const r = await oldFamily();
    const rod = itemsToMigrate(r, 'rod', true, 'd-rod').map((x) => `${x.c}/${x.id}`).sort();
    const julie = itemsToMigrate(r, 'julie', false, 'd-julie').map((x) => `${x.c}/${x.id}`).sort();
    expect(rod).toEqual(['alarms/a1', 'events/e1', 'members/leo', 'prefs/rod', 'recipes/r1', 'settings/family']);
    expect(julie).toEqual(['events/e2', 'messages/m1', 'prefs/julie']);
    // Le nom de la famille devient celui du cercle ; les réveils vont dans « Moi seul ».
    const all = itemsToMigrate(r, 'rod', true, 'd-rod');
    expect(all.find((x) => x.c === 'settings')!.data).toEqual({ accent: '#f00' });
    expect(all.find((x) => x.c === 'alarms')!.personal).toBe(true);
  });

  it("un réveil n'est repris que par l'appareil sur lequel il sonne", async () => {
    const r = await oldFamily();
    expect(itemsToMigrate(r, 'rod', true, 'd-autre').some((x) => x.c === 'alarms')).toBe(false);
  });
});
