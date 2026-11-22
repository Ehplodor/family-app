import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// La réplique enregistre dans IndexedDB : inutile ici (tout reste en mémoire).
vi.mock('./idb', () => ({
  putMany: async () => {},
  entries: async () => [],
  get: async () => undefined,
  put: async () => {},
}));

import { randomId } from './bytes';
import { newDeviceKeys, newMasterkey, newSigningKeys, unwrapAdminKey, wrapAdminKey } from './crypto';
import { RELIEF_DELAY, col, deviceIdOf, signDoc, signRoster, type ItemPayload } from './circles';
import { sealPrivate } from './groups';
import { Replica, type Op } from './replica';
import { Vault, type AdminKeys, type LocalStore } from './vault';

/* ------------------------------------------------------------------ Simulation de plusieurs téléphones */

type Phone = { id: string; member: string; replica: Replica; vault: Vault; signKey: CryptoKey };

function memStore(): LocalStore {
  const m = new Map<string, unknown>();
  return {
    get: async <T,>(k: string) => structuredClone(m.get(k)) as T | undefined,
    put: async (k, v) => void m.set(k, structuredClone(v)),
    del: async (k) => void m.delete(k),
    entries: async <T,>(prefix: string) => [...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v) as T] as [string, T]),
  };
}

let phones: Phone[];
let queue: { from: Phone; ops: Op[] }[];
/** Clé d'administration de chaque membre (sur ses appareils, protégée par l'empreinte dans l'appli). */
let adminKeys: Map<string, AdminKeys & { masterkey: string }>;

async function adminKeyOf(member: string) {
  let a = adminKeys.get(member);
  if (!a) {
    const k = await newSigningKeys(true);
    const masterkey = newMasterkey();
    a = { spub: k.signJwk, wrapped: await wrapAdminKey(k.signKey, masterkey, member), key: k.signKey, masterkey };
    adminKeys.set(member, a);
  }
  return a;
}

/** Simule le relais : chaque modification locale est transmise aux autres appareils. */
async function sync() {
  for (let round = 0; round < 4; round++) {
    while (queue.length) {
      const { from, ops } = queue.shift()!;
      for (const p of phones) if (p !== from) await p.replica.applyRemote(structuredClone(ops));
    }
    for (const p of phones) await p.vault.refresh();
    if (!queue.length) break;
  }
}

async function phone(member: string): Promise<Phone> {
  const keys = await newDeviceKeys();
  const sk = await newSigningKeys();
  const id = await deviceIdOf(sk.signJwk, keys.publicJwk);
  const replica = new Replica(id);
  replica.memberId = member;
  const vault = new Vault(
    replica,
    { deviceId: id, privateKey: keys.privateKey, publicJwk: keys.publicJwk, signKey: sk.signKey, signJwk: sk.signJwk },
    () => member,
    memStore(),
    { get: () => adminKeyOf(member) },
  );
  const p: Phone = { id, member, replica, vault, signKey: sk.signKey };
  replica.onLocalOps = (ops) => queue.push({ from: p, ops });
  // Rattrape ce qui existe déjà (comme un nouvel appareil qui reçoit l'instantané).
  if (phones.length) await replica.mergeRecords(structuredClone(phones[0].replica.allRecords()));
  phones.push(p);
  await vault.publishDevice();
  await sync();
  return p;
}

const titles = (p: Phone, name = 'events') => p.vault.list<{ title: string }>(name).map((e) => e.title).sort();

/** Écrit directement une version d'un élément, sans les contrôles de l'appli (appareil modifié), avec la clé la plus récente qu'il détient. */
async function forceWrite(p: Phone, name: string, id: string, payload: ItemPayload) {
  const keys = [...p.vault.held.values()].filter((k) => payload.g.includes(k.group)).sort((a, b) => b.epoch - a.epoch);
  const box = await sealPrivate(name, id, payload, keys.slice(0, 1));
  await p.vault['put'](name, id, { box });
  await sync();
}

/** Famille de départ : Rod (admin) crée « Famille », Julie et Léo y entrent. */
async function family() {
  const rod = await phone('rod');
  const julie = await phone('julie');
  const leo = await phone('leo');
  const fam = await rod.vault.createCircle({ name: 'Famille', color: '#8E5CE6' });
  await sync();
  await rod.vault.admit(fam, 'julie', julie.id);
  await sync();
  await rod.vault.admit(fam, 'leo', leo.id);
  await sync();
  return { rod, julie, leo, fam };
}

beforeEach(() => {
  phones = [];
  queue = [];
  adminKeys = new Map();
});
afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ Tests */

describe('coffre : entrée dans un cercle', () => {
  it("les membres admis par l'admin lisent et écrivent ; un appareil inconnu ne lit rien", async () => {
    const { rod, julie, leo, fam } = await family();
    const intrus = await phone('mallory');
    await rod.vault.create('events', { title: 'Anniversaire' }, { groups: [fam] });
    await julie.vault.create('events', { title: 'Piscine' });
    await sync();
    for (const p of [rod, julie, leo]) {
      expect(titles(p)).toEqual(['Anniversaire', 'Piscine']);
      expect(p.vault.circle(fam)).toMatchObject({ name: 'Famille', admin: 'rod', members: ['rod', 'julie', 'leo'], writable: true });
    }
    expect(rod.vault.circle(fam)!.isAdmin).toBe(true);
    expect(julie.vault.circle(fam)!.isAdmin).toBe(false);
    expect(intrus.vault.circles()).toEqual([]);
    expect(titles(intrus)).toEqual([]);
    // Rien en clair dans ce qui transite.
    expect(JSON.stringify(rod.replica.allRecords())).not.toContain('Anniversaire');
    expect(JSON.stringify(rod.replica.allRecords())).not.toContain('Famille');
  });

  it("un nouveau membre lit aussi ce qui a été écrit avant son entrée, même avec d'anciennes clés", async () => {
    const { rod, julie, fam } = await family();
    await rod.vault.create('events', { title: 'Avant' }, { groups: [fam] });
    await sync();
    await rod.vault.renew(fam);
    await sync();
    await julie.vault.create('events', { title: 'Après' }, { groups: [fam] });
    await sync();
    const papi = await phone('papi');
    await rod.vault.admit(fam, 'papi', papi.id);
    await sync();
    expect(titles(papi)).toEqual(['Après', 'Avant']);
  });

  it("seul l'admin fait entrer quelqu'un ; une validation inventée ne compte pas", async () => {
    const { julie, leo, fam } = await family();
    const intrus = await phone('mallory');
    await expect(julie.vault.admit(fam, 'mallory', intrus.id)).rejects.toThrow();
    // Julie remet quand même la clé, avec une validation signée par SA clé (pas celle de l'admin).
    const k = (julie.vault as unknown as { currentKey(c: string): unknown }).currentKey(fam);
    await (julie.vault as unknown as { grantKey(k: unknown, d: string, m: string, o: unknown): Promise<void> }).grantKey(k, intrus.id, 'mallory', {
      admin: (await adminKeyOf('julie')).key,
    });
    await sync();
    expect(leo.vault.holders(fam).has(intrus.id)).toBe(false);
    // L'intrus a la clé (Julie la lui a donnée) mais ses écritures ne sont pas acceptées.
    await intrus.vault.create('events', { title: 'Faux' }, { groups: [fam] }).catch(() => {});
    await forceWrite(intrus, 'events', randomId(), { g: [fam], o: 'mallory', t0: 'x', d: { title: 'Faux' } });
    expect(titles(leo)).toEqual([]);
  });

  it('un membre approuve son propre nouvel appareil', async () => {
    const { rod, julie, fam } = await family();
    await rod.vault.create('events', { title: 'Dîner' }, { groups: [fam] });
    await sync();
    const julie2 = await phone('julie');
    await julie.vault.approveOwnDevice(julie2.id);
    await sync();
    expect(titles(julie2)).toEqual(['Dîner']);
    await julie2.vault.create('events', { title: 'Depuis la tablette' }, { groups: [fam] });
    await sync();
    expect(titles(rod)).toEqual(['Depuis la tablette', 'Dîner']);
    expect(rod.vault.memberOf(julie2.id)).toBe('julie');
  });
});

describe('coffre : signatures et sabotage', () => {
  it('une version modifiée sans signature valable est ignorée, la dernière bonne est gardée', async () => {
    const { rod, julie, fam } = await family();
    const e = await rod.vault.create('events', { title: 'Original' }, { groups: [fam] });
    await sync();
    // Un appareil de la famille réécrit le document sans pouvoir le signer au nom de Rod.
    const rec = julie.replica.allRecords((r) => r.c === col('events') && r.id === e.id)[0];
    const s = structuredClone(rec.f.s.v) as { at: string; sig: string };
    s.at = '9999';
    await julie.replica.upsert(col('events'), e.id, { s });
    await sync();
    expect(titles(rod)).toEqual(['Original']);
    // Signé par un appareil qui n'existe pas.
    const fake = await newSigningKeys();
    await julie.replica.upsert(col('events'), e.id, { s: await signDoc(fake.signKey, col('events'), e.id, randomId(), '9999', { box: {} }) });
    await sync();
    expect(titles(rod)).toEqual(['Original']);
    expect(titles(julie)).toEqual(['Original']);
  });

  it("personne ne peut publier d'autres clés sous l'identifiant d'un appareil", async () => {
    const { rod, julie, fam } = await family();
    const k = await newSigningKeys();
    const keys = await newDeviceKeys();
    await rod.replica.upsert(col('devices'), julie.id, {
      s: await signDoc(k.signKey, col('devices'), julie.id, julie.id, '9999', { pub: keys.publicJwk, spub: k.signJwk }),
    });
    await sync();
    const papi = await phone('papi');
    await rod.vault.admit(fam, 'papi', papi.id);
    await julie.vault.create('events', { title: 'Toujours Julie' }, { groups: [fam] });
    await sync();
    expect(titles(rod)).toEqual(['Toujours Julie']);
    expect(titles(papi)).toEqual(['Toujours Julie']);
    expect(papi.vault.holders(fam).get(julie.id)).toBe('julie');
  });
});

describe('coffre : propriétaire et droits', () => {
  it('seul le propriétaire supprime pour tout le monde ; les autres masquent pour eux', async () => {
    const { rod, julie, leo, fam } = await family();
    const e = await rod.vault.create('events', { title: 'Réunion' }, { groups: [fam] });
    await sync();
    expect(await julie.vault.remove('events', e.id)).toBe('me');
    await sync();
    expect(titles(julie)).toEqual([]);
    expect(titles(rod)).toEqual(['Réunion']);
    expect(titles(leo)).toEqual(['Réunion']);
    // Suppression forcée par Julie : refusée par les autres.
    await forceWrite(julie, 'events', e.id, { ...julie.vault['items'].get(`events/${e.id}`)!.d, d: {}, x: 1 });
    expect(titles(leo)).toEqual(['Réunion']);
    // Le propriétaire supprime pour tous.
    expect(await rod.vault.remove('events', e.id)).toBe('all');
    await sync();
    expect(titles(leo)).toEqual([]);
  });

  it("agenda : tout membre modifie ; message : seul l'auteur", async () => {
    const { rod, julie, fam } = await family();
    const e = await rod.vault.create('events', { title: 'Piscine' }, { groups: [fam] });
    const m = await rod.vault.create('messages', { text: 'Bonjour' }, { groups: [fam] });
    await sync();
    await julie.vault.update('events', e.id, { title: 'Piscine 18h' });
    await expect(julie.vault.update('messages', m.id, { text: 'Modifié' })).rejects.toThrow();
    await forceWrite(julie, 'messages', m.id, { ...julie.vault['items'].get(`messages/${m.id}`)!.d, d: { text: 'Modifié' } });
    expect(rod.vault.get<{ title: string }>('events', e.id)!.title).toBe('Piscine 18h');
    expect(rod.vault.get<{ text: string }>('messages', m.id)!.text).toBe('Bonjour');
    expect(rod.vault.get('events', e.id)!.owner).toBe('rod');
  });

  it("tâches : les autres ne changent que l'état (fait, échéance), pas le titre", async () => {
    const { rod, julie, fam } = await family();
    const t = await rod.vault.create('tasks', { title: 'Poubelles', done: false }, { groups: [fam] });
    await sync();
    await julie.vault.update('tasks', t.id, { done: true, lastDoneBy: 'julie' });
    await expect(julie.vault.update('tasks', t.id, { title: 'Autre' })).rejects.toThrow();
    await sync();
    await forceWrite(julie, 'tasks', t.id, { ...julie.vault['items'].get(`tasks/${t.id}`)!.d, d: { title: 'Autre', done: true } });
    expect(rod.vault.get<{ title: string; done: boolean }>('tasks', t.id)).toMatchObject({ title: 'Poubelles', done: true, lastDoneBy: 'julie' });
    expect(julie.vault.canEdit('tasks', t.id, ['done'])).toBe(true);
    expect(julie.vault.canEdit('tasks', t.id, ['title'])).toBe(false);
  });

  it("un autre membre ne change pas les cercles qui voient l'élément", async () => {
    const { rod, julie, fam } = await family();
    const parents = await rod.vault.createCircle({ name: 'Parents', color: '#000' });
    await sync();
    await rod.vault.admit(parents, 'julie', julie.id);
    await sync();
    const e = await rod.vault.create('events', { title: 'Cadeau' }, { groups: [parents] });
    await sync();
    await expect(julie.vault.update('events', e.id, {}, [parents, fam])).rejects.toThrow();
    expect(rod.vault.get('events', e.id)!.groups).toEqual([parents]);
  });

  it("un élément visible par plusieurs cercles est lisible par chacun", async () => {
    const { rod, julie, leo, fam } = await family();
    const parents = await rod.vault.createCircle({ name: 'Parents', color: '#000' });
    await sync();
    await rod.vault.admit(parents, 'julie', julie.id);
    await sync();
    await julie.vault.create('events', { title: 'Les deux' }, { groups: [parents, fam] });
    await julie.vault.create('events', { title: 'Parents seulement' }, { groups: [parents] });
    await sync();
    expect(titles(rod)).toEqual(['Les deux', 'Parents seulement']);
    expect(titles(leo)).toEqual(['Les deux']);
    expect(leo.vault.circles().map((c) => c.name)).toEqual(['Famille']);
  });
});

describe('coffre : exclusion et rôle d’admin', () => {
  it("un membre exclu ne lit plus la suite et ne peut plus écrire ; ce qu'il a écrit avant reste", async () => {
    const { rod, julie, leo, fam } = await family();
    await julie.vault.create('events', { title: 'De Julie' }, { groups: [fam] });
    await sync();
    await rod.vault.exclude(fam, 'julie');
    await sync();
    expect(rod.vault.circle(fam)!.members).toEqual(['rod', 'leo']);
    expect(julie.vault.circle(fam)!.outdated).toBe(true);
    await rod.vault.create('events', { title: 'Après exclusion' }, { groups: [fam] });
    await sync();
    expect(titles(julie)).toEqual(['De Julie']);
    expect(titles(leo)).toEqual(['Après exclusion', 'De Julie']);
    // Avec l'ancienne clé, Julie tente encore d'écrire.
    await forceWrite(julie, 'events', randomId(), { g: [fam], o: 'julie', t0: 'z', d: { title: 'Intrusion' } });
    expect(titles(leo)).toEqual(['Après exclusion', 'De Julie']);
    // Un nouveau venu voit aussi ce que Julie avait écrit avant.
    const papi = await phone('papi');
    await rod.vault.admit(fam, 'papi', papi.id);
    await sync();
    expect(titles(papi)).toEqual(['Après exclusion', 'De Julie']);
  });

  it("transmission : le nouvel admin fait entrer, l'ancien ne peut plus", async () => {
    const { rod, julie, leo, fam } = await family();
    const ja = await adminKeyOf('julie');
    await rod.vault.transferAdmin(fam, 'julie', ja.spub, ja.wrapped);
    await sync();
    expect(leo.vault.circle(fam)).toMatchObject({ admin: 'julie' });
    expect(julie.vault.circle(fam)!.isAdmin).toBe(true);
    const papi = await phone('papi');
    await expect(rod.vault.admit(fam, 'papi', papi.id)).rejects.toThrow();
    await julie.vault.admit(fam, 'papi', papi.id);
    await sync();
    expect(leo.vault.circle(fam)!.members).toContain('papi');
    expect(papi.vault.circle(fam)!.admin).toBe('julie');
    // Les appareils admis par Rod avant la transmission restent autorisés.
    expect(papi.vault.holders(fam).get(leo.id)).toBe('leo');
    // Une liste signée par l'ancienne clé n'est plus acceptée.
    const cur = leo.vault['rosters'].get(fam)!;
    const sr = await signRoster((await adminKeyOf('rod')).key, { ...cur, v: cur.v + 1, admin: 'rod', spub: (await adminKeyOf('rod')).spub });
    rod.vault['local']!.chains[fam].push(sr);
    const k = rod.vault['state'].get(fam)!.current ?? rod.vault['state'].get(fam)!.pinned!;
    await rod.vault['writeMeta'](fam, k, { name: 'Famille', color: '#000', rosters: rod.vault['local']!.chains[fam] });
    await sync();
    expect(leo.vault.circle(fam)!.admin).toBe('julie');
  });

  it('la masterkey récupère la clé d’administration ; une autre non', async () => {
    const a = await adminKeyOf('rod');
    expect(await unwrapAdminKey(a.wrapped, a.masterkey, 'rod')).not.toBeNull();
    expect(await unwrapAdminKey(a.wrapped, a.masterkey.toLowerCase().replace(/-/g, ' '), 'rod')).not.toBeNull();
    expect(await unwrapAdminKey(a.wrapped, newMasterkey(), 'rod')).toBeNull();
    expect(await unwrapAdminKey(a.wrapped, a.masterkey, 'julie')).toBeNull();
  });
});

describe('coffre : relève par les membres', () => {
  async function propose() {
    const f = await family();
    await f.julie.vault.proposeRelief(f.fam);
    await f.julie.vault.voteRelief(`${f.fam}julie`);
    await sync();
    await f.leo.vault.voteRelief(`${f.fam}julie`);
    await sync();
    return f;
  }
  const later = (ms: number) => {
    const t = Date.now() + ms;
    vi.spyOn(Date, 'now').mockReturnValue(t);
  };

  it("au bout de 7 jours, avec la majorité des autres membres, le candidat devient admin", async () => {
    const { julie, leo, rod, fam } = await propose();
    expect(leo.vault.reliefs(fam)[0]).toMatchObject({ votes: 2, voters: 2 });
    await julie.vault.completeRelief(`${fam}julie`);
    await sync();
    expect(leo.vault.circle(fam)!.admin).toBe('rod');
    later(RELIEF_DELAY + 60_000);
    await sync();
    for (const p of [rod, julie, leo]) await p.vault.refresh();
    expect(leo.vault.circle(fam)!.admin).toBe('julie');
    expect(rod.vault.circle(fam)!.admin).toBe('julie');
  });

  it("l'ancien admin s'oppose : la relève n'aboutit pas", async () => {
    const { julie, leo, rod, fam } = await propose();
    await rod.vault.vetoRelief(`${fam}julie`);
    await sync();
    // Julie écrase le document pour faire disparaître l'opposition : elle a déjà été vue.
    await julie.vault.completeRelief(`${fam}julie`);
    await sync();
    later(RELIEF_DELAY + 60_000);
    for (const p of [rod, julie, leo]) await p.vault.refresh();
    expect(leo.vault.circle(fam)!.admin).toBe('rod');
  });

  it('sans majorité, pas de relève', async () => {
    const { julie, leo, fam } = await family();
    await julie.vault.proposeRelief(fam);
    await julie.vault.voteRelief(`${fam}julie`);
    await sync();
    await julie.vault.completeRelief(`${fam}julie`);
    await sync();
    later(RELIEF_DELAY + 60_000);
    await leo.vault.refresh();
    expect(leo.vault.circle(fam)!.admin).toBe('rod');
  });
});

describe('coffre : appareil perdu', () => {
  it("un appareil déclaré perdu ne lit plus la suite, ses écritures ultérieures sont ignorées, et il ne peut pas annuler lui-même", async () => {
    const { rod, julie, fam } = await family();
    const julie2 = await phone('julie');
    await julie.vault.approveOwnDevice(julie2.id);
    await sync();
    await julie.vault.declareLost(julie2.id);
    await sync();
    expect(rod.vault.isLost(julie2.id)).toBe(true);
    expect(rod.vault.holders(fam).has(julie2.id)).toBe(false);
    expect(julie2.vault.circle(fam)!.outdated).toBe(true);
    await rod.vault.create('events', { title: 'Après la perte' }, { groups: [fam] });
    await sync();
    expect(titles(julie2)).toEqual([]);
    // Le voleur tente d'écrire avec l'ancienne clé, puis d'annuler la déclaration.
    await forceWrite(julie2, 'events', randomId(), { g: [fam], o: 'julie', t0: 'z', d: { title: 'Voleur' } });
    await julie2.vault.declareLost(julie2.id, false);
    await sync();
    expect(titles(rod)).toEqual(['Après la perte']);
    expect(rod.vault.isLost(julie2.id)).toBe(true);
    // Julie le retrouve : elle rend l'accès.
    await julie.vault.declareLost(julie2.id, false);
    await sync();
    expect(rod.vault.isLost(julie2.id)).toBe(false);
  });
});
