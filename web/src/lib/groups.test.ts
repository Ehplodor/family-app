import { beforeEach, describe, expect, it, vi } from 'vitest';

// La réplique enregistre dans IndexedDB : inutile ici (tout reste en mémoire).
vi.mock('./idb', () => ({
  putMany: async () => {},
  entries: async () => [],
  get: async () => undefined,
  put: async () => {},
}));

import { newDeviceKeys, newSecret, deriveGroupKey, deriveGroupKeyId } from './crypto';
import { randomId } from './bytes';
import { Replica, type Op } from './replica';
import { GroupManager, PRIVATE_EVENTS, PRIVATE_MESSAGES, type LocalStore } from './groupManager';
import {
  keyLink,
  latestKey,
  newGroupKey,
  openPrivate,
  sealGroupSecret,
  pendingDevices,
  personalGroupId,
  sealPrivate,
  type GroupKeyDoc,
  type HeldKey,
  type PrivateDoc,
} from './groups';

/* ------------------------------------------------------------------ Fonctions pures */

const kd = (group: string, key: string, epoch: number, device: string): GroupKeyDoc => ({ group, key, epoch, device, env: '', by: device });

describe('cercles : règles', () => {
  it('la clé en vigueur est celle de la plus haute époque (puis du plus petit identifiant)', () => {
    const g = randomId();
    const a = 'a'.repeat(32);
    const b = 'b'.repeat(32);
    const c = 'c'.repeat(32);
    expect(latestKey([kd(g, b, 0, 'x'), kd(g, a, 0, 'y')], g)).toEqual({ key: a, epoch: 0 });
    expect(latestKey([kd(g, a, 0, 'x'), kd(g, c, 1, 'y'), kd(randomId(), b, 9, 'z')], g)).toEqual({ key: c, epoch: 1 });
    expect(latestKey([], g)).toBeNull();
  });

  it("n'attendent l'accès que les appareils non retirés des membres du cercle qui n'ont pas la clé", () => {
    const pub = { kty: 'EC' };
    const devices = [
      { id: 'd1', memberId: 'rod', pub },
      { id: 'd2', memberId: 'rod', pub },
      { id: 'd3', memberId: 'rod', pub, revoked: true },
      { id: 'd4', memberId: 'leo', pub },
      { id: 'd5', memberId: 'julie' },
    ];
    const meta = { name: 'Parents', color: '#000', members: ['rod', 'julie'] };
    expect(pendingDevices(meta, new Set(['d1']), devices).map((d) => d.id)).toEqual(['d2']);
  });

  it("l'identifiant du cercle personnel est le même sur tous les appareils d'un membre", async () => {
    expect(await personalGroupId('rod')).toBe(await personalGroupId('rod'));
    expect(await personalGroupId('rod')).not.toBe(await personalGroupId('julie'));
    expect(await personalGroupId('rod')).toMatch(/^[0-9a-f]{32}$/);
  });
});

async function heldKey(group = randomId(), epoch = 0): Promise<HeldKey> {
  const secret = newSecret();
  return { group, keyId: await deriveGroupKeyId(secret), epoch, key: await deriveGroupKey(secret), secret };
}

describe('cercles : chiffrement des éléments', () => {
  it("un élément partagé par deux cercles est lisible avec la clé de l'un OU de l'autre, et pas sans", async () => {
    const parents = await heldKey();
    const perso = await heldKey();
    const autre = await heldKey();
    const id = randomId();
    const box = await sealPrivate(PRIVATE_EVENTS, id, { title: 'Surprise', groups: [parents.group, perso.group] }, [parents, perso]);
    expect(Object.keys(box.w)).toHaveLength(2);
    expect(JSON.stringify(box)).not.toContain('Surprise');
    expect(await openPrivate(PRIVATE_EVENTS, id, box, new Map([[parents.keyId, parents]]))).toMatchObject({ title: 'Surprise' });
    expect(await openPrivate(PRIVATE_EVENTS, id, box, new Map([[perso.keyId, perso]]))).toMatchObject({ title: 'Surprise' });
    expect(await openPrivate(PRIVATE_EVENTS, id, box, new Map([[autre.keyId, autre]]))).toBeNull();
  });

  it("un contenu chiffré ne peut pas être recopié sur un autre élément ou une autre collection", async () => {
    const k = await heldKey();
    const held = new Map([[k.keyId, k]]);
    const id = randomId();
    const box = await sealPrivate(PRIVATE_EVENTS, id, { title: 'x', groups: [k.group] }, [k]);
    expect(await openPrivate(PRIVATE_EVENTS, randomId(), box, held)).toBeNull();
    expect(await openPrivate('privateTasks', id, box, held)).toBeNull();
  });

  it('chaque enregistrement tire une nouvelle clé (sauf si un cercle dont on n’a pas la clé doit être gardé)', async () => {
    const a = await heldKey();
    const b = await heldKey();
    const id = randomId();
    const first = await sealPrivate(PRIVATE_EVENTS, id, { v: 1 }, [a, b]);
    const second = await sealPrivate(PRIVATE_EVENTS, id, { v: 2 }, [a, b]);
    expect(second.w[a.keyId]).not.toBe(first.w[a.keyId]);
    // Appareil qui n'a que la clé de `a` : il garde l'enveloppe de `b` et la clé de l'élément.
    const edited = await sealPrivate(PRIVATE_EVENTS, id, { v: 3 }, [a], {
      keep: { [b.keyId]: first.w[b.keyId] },
      previous: first,
      held: new Map([[a.keyId, a]]),
    });
    expect(await openPrivate(PRIVATE_EVENTS, id, edited, new Map([[b.keyId, b]]))).toEqual({ v: 3 });
  });
});

/* ------------------------------------------------------------------ Plusieurs appareils d'une famille */

type Phone = { id: string; replica: Replica; groups: GroupManager; member: string; store: LocalStore; privateKey: CryptoKey };

/** Stockage local propre à chaque appareil simulé (IndexedDB dans l'appli). */
function memStore(): LocalStore {
  const m = new Map<string, unknown>();
  return { get: async <T,>(k: string) => structuredClone(m.get(k)) as T | undefined, put: async (k, v) => void m.set(k, structuredClone(v)) };
}

describe('cercles : plusieurs appareils', () => {
  let phones: Phone[];
  let queue: { from: Phone; ops: Op[] }[];

  /** Simule le relais : chaque modification locale est transmise aux autres appareils. */
  async function sync() {
    while (queue.length) {
      const { from, ops } = queue.shift()!;
      for (const p of phones) if (p !== from) await p.replica.applyRemote(structuredClone(ops));
    }
    for (const p of phones) await p.groups.refresh();
  }

  async function phone(member: string): Promise<Phone> {
    const id = randomId();
    const keys = await newDeviceKeys();
    const replica = new Replica(id);
    replica.memberId = member;
    const store = memStore();
    const p: Phone = {
      id,
      replica,
      member,
      store,
      privateKey: keys.privateKey,
      groups: new GroupManager(replica, { deviceId: id, privateKey: keys.privateKey }, () => member, store),
    };
    replica.onLocalOps = (ops) => queue.push({ from: p, ops });
    // Rattrape ce qui existe déjà (comme un nouvel appareil qui reçoit l'instantané).
    if (phones.length) await replica.mergeRecords(structuredClone(phones[0].replica.allRecords()));
    await replica.upsert('devices', id, { memberId: member, label: `Téléphone ${member}`, pub: keys.publicJwk });
    phones.push(p);
    await sync();
    return p;
  }

  const titles = (p: Phone) => p.groups.privateEvents<{ title: string }>().map((e) => e.title).sort();

  /** Autorise un appareil, qui accepte après avoir vérifié que le code affiché est le même. */
  async function authorize(granter: Phone, device: Phone, group: string) {
    const code = await granter.groups.grant(group, device.id);
    await sync();
    const offer = device.groups.offers().find((o) => o.group === group && o.code === code);
    expect(offer).toBeTruthy();
    await device.groups.acceptOffer(group, offer!.keyId);
    await sync();
  }

  beforeEach(() => {
    phones = [];
    queue = [];
  });

  it("un évènement « Moi seul » n'est lisible que par les appareils autorisés de son auteur", async () => {
    const rod = await phone('rod');
    const julie = await phone('julie');
    await rod.groups.ensurePersonal();
    await sync();
    const perso = await personalGroupId('rod');
    await rod.groups.saveEvent(randomId(), { title: 'Dentiste', date: '2026-12-01' }, [perso]);
    await sync();
    expect(titles(rod)).toEqual(['Dentiste']);
    expect(titles(julie)).toEqual([]);
    // Le contenu ne figure nulle part en clair dans la copie de Julie.
    expect(JSON.stringify(julie.replica.allRecords())).not.toContain('Dentiste');

    // Nouvel appareil de Rod (ou appareil qui choisit le profil « Rod » !) : en attente, sans accès.
    const tablet = await phone('rod');
    await tablet.groups.ensurePersonal(); // ne crée pas de doublon : le cercle existe déjà
    await sync();
    expect(titles(tablet)).toEqual([]);
    expect(await tablet.groups.personalStatus()).toBe('waiting');
    expect(rod.groups.pending(perso).map((d) => d.id)).toEqual([tablet.id]);
    // Rod l'autorise d'un geste, depuis son téléphone. La tablette n'adopte la clé qu'après comparaison du code.
    const code = await rod.groups.grant(perso, tablet.id);
    await sync();
    expect(titles(tablet)).toEqual([]);
    expect(await tablet.groups.personalStatus()).toBe('offer');
    expect(tablet.groups.offers().map((o) => [o.name, o.code])).toEqual([['Moi seul', code]]);
    await tablet.groups.acceptOffer(perso, tablet.groups.offers()[0].keyId);
    await sync();
    expect(titles(tablet)).toEqual(['Dentiste']);
    expect(await tablet.groups.codeFor(perso, tablet.id)).toBe(code);
    expect(rod.groups.pending(perso)).toEqual([]);
  });

  it('un évènement partagé par plusieurs cercles ; retirer un membre change la clé', async () => {
    const rod = await phone('rod');
    const julie = await phone('julie');
    const leo = await phone('leo');
    const parents = await rod.groups.create({ name: 'Parents', color: '#123456', members: ['rod', 'julie'] });
    await sync();
    // Julie n'a pas encore été autorisée : elle ne voit même pas le nom du cercle.
    expect(julie.groups.list()).toEqual([]);
    expect(rod.groups.pending(parents).map((d) => d.id)).toEqual([julie.id]);
    await rod.groups.ensurePersonal();
    await authorize(rod, julie, parents);
    expect(julie.groups.list().map((g) => g.name)).toEqual(['Parents']);

    const id = randomId();
    await rod.groups.saveEvent(id, { title: 'Cadeau de Léo' }, [parents, await personalGroupId('rod')]);
    await sync();
    expect(titles(julie)).toEqual(['Cadeau de Léo']);
    expect(titles(leo)).toEqual([]);

    // Conversation du cercle : lisible par Julie, pas par Léo.
    await julie.groups.sendMessage(parents, 'On lui offre un vélo ?');
    await sync();
    const texts = (p: Phone) => p.groups.privateDocs<{ text: string }>(PRIVATE_MESSAGES).map((m) => m.text);
    expect(texts(rod)).toEqual(['On lui offre un vélo ?']);
    expect(texts(leo)).toEqual([]);
    expect(JSON.stringify(leo.replica.allRecords())).not.toContain('vélo');
    await expect(leo.groups.sendMessage(parents, 'intrus')).rejects.toThrow();

    // Julie modifie : elle n'a pas la clé de « Moi seul » de Rod, l'évènement reste visible par les deux cercles.
    await julie.groups.saveEvent(id, { title: 'Cadeau de Léo (vélo)' }, [parents, await personalGroupId('rod')]);
    await sync();
    expect(titles(rod)).toEqual(['Cadeau de Léo (vélo)']);

    // Rod retire Julie du cercle : nouvelle clé, que Julie ne reçoit pas.
    await rod.groups.update(parents, { members: ['rod'] });
    await sync();
    // La description est rechiffrée avec la nouvelle clé : Julie ne garde que l'ancienne, marquée « à renouveler ».
    expect(julie.groups.list().map((g) => [g.name, g.access])).toEqual([['Parents', 'outdated']]);
    await rod.groups.saveEvent(id, { title: 'Cadeau de Léo (trottinette)' }, [parents]);
    await rod.groups.saveEvent(randomId(), { title: 'Nouveau secret' }, [parents]);
    await sync();
    expect(titles(rod)).toEqual(['Cadeau de Léo (trottinette)', 'Nouveau secret']);
    // Julie garde ce qu'elle avait déjà vu, mais ne lit ni la modification ni le nouvel évènement.
    expect(titles(julie)).toEqual(['Cadeau de Léo (vélo)']);
    // Et Julie ne peut plus écrire avec l'ancienne clé dans ce cercle.
    await expect(julie.groups.update(parents, { name: 'Piraté' })).rejects.toThrow();
  });

  it("la suppression efface le contenu chiffré des copies", async () => {
    const rod = await phone('rod');
    await rod.groups.ensurePersonal();
    const id = randomId();
    await rod.groups.saveEvent(id, { title: 'À effacer' }, [await personalGroupId('rod')]);
    await rod.groups.removeEvent(id);
    await sync();
    expect(titles(rod)).toEqual([]);
    // La suppression est elle-même chiffrée : le contenu est remplacé par une « pierre tombale » sans le titre.
    const box = rod.replica.get<PrivateDoc>(PRIVATE_EVENTS, id)!.box!;
    expect(await openPrivate(PRIVATE_EVENTS, id, box, rod.groups.held)).toEqual({ groups: [await personalGroupId('rod')], deleted: true });
  });

  /* ------------------------------------------------ appareil malveillant (version modifiée de l'appli) */

  /** Ce que pourrait écrire un appareil de la famille qui n'a PAS la clé : une clé à lui, envoyée à tous. */
  async function injectKey(attacker: Phone, group: string, epoch: number, sameIdAs?: string) {
    const k = await newGroupKey(group, epoch, newSecret());
    const keyId = sameIdAs ?? k.keyId;
    for (const d of attacker.replica.list<{ pub: JsonWebKey }>('devices')) {
      const env = await sealGroupSecret(d.pub, k.secret, group, keyId, epoch, d.id);
      await attacker.replica.upsert('groupKeys', `${keyId}${d.id}`, { group, key: keyId, epoch, device: d.id, env, by: attacker.id, proof: 'faux', links: [{ pk: 'faux', link: 'faux' }] });
    }
    await sync();
    return k;
  }

  it("attaque : une clé fabriquée par un appareil sans accès n'est jamais adoptée", async () => {
    const rod = await phone('rod');
    const leo = await phone('leo');
    await rod.groups.ensurePersonal();
    await sync();
    const perso = await personalGroupId('rod');
    // Clé « plus récente » (époque 5), puis clé concurrente à la même époque que la vraie.
    await injectKey(leo, perso, 5);
    await injectKey(leo, perso, 0);
    await rod.groups.saveEvent(randomId(), { title: 'Toujours secret' }, [perso]);
    await sync();
    expect(titles(rod)).toEqual(['Toujours secret']);
    // Léo a toutes les clés qu'il a fabriquées : il ne lit pourtant rien.
    for (const k of [await injectKey(leo, perso, 6)]) {
      const docs = leo.replica.list<PrivateDoc>(PRIVATE_EVENTS);
      for (const d of docs) expect(await openPrivate(PRIVATE_EVENTS, d.id, d.box, new Map([[k.keyId, k]]))).toBeNull();
    }
    expect(titles(leo)).toEqual([]);
  });

  it("attaque : une enveloppe réécrite avec un autre secret sous le même nom de clé est rejetée", async () => {
    const rod = await phone('rod');
    const leo = await phone('leo');
    await rod.groups.ensurePersonal();
    await sync();
    const perso = await personalGroupId('rod');
    const realKey = rod.groups.held.values().next().value!.keyId;
    const fake = await injectKey(leo, perso, 0, realKey);
    const id = randomId();
    await rod.groups.saveEvent(id, { title: 'Pas pour Léo' }, [perso]);
    await sync();
    expect(titles(rod)).toEqual(['Pas pour Léo']);
    const box = leo.replica.get<PrivateDoc>(PRIVATE_EVENTS, id)!.box;
    expect(await openPrivate(PRIVATE_EVENTS, id, box, new Map([[realKey, { ...fake, keyId: realKey }]]))).toBeNull();
  });

  it("attaque : se déclarer « autorisé » sans la clé ne donne droit à aucun rappel ni notification", async () => {
    const rod = await phone('rod');
    const leo = await phone('leo');
    await rod.groups.ensurePersonal();
    await sync();
    const perso = await personalGroupId('rod');
    const keyId = rod.groups.held.values().next().value!.keyId;
    // Léo écrit une fausse enveloppe à son nom pour la vraie clé (sans pouvoir prouver l'autorisation).
    await leo.replica.upsert('groupKeys', `${keyId}${leo.id}`, { group: perso, key: keyId, epoch: 0, device: leo.id, env: '{}', by: leo.id, proof: 'faux' });
    await sync();
    expect(rod.groups.holders(perso).map((d) => d.id)).toEqual([rod.id]);
  });

  it("attaque : un appareil qui prend le profil de Rod ne crée pas son cercle personnel à sa place", async () => {
    const rod = await phone('rod');
    const impostor = await phone('rod');
    await impostor.groups.ensurePersonal();
    await sync();
    expect(impostor.groups.list()).toEqual([]);
    await rod.groups.ensurePersonal();
    await sync();
    const perso = await personalGroupId('rod');
    expect(rod.groups.list().map((g) => g.id)).toEqual([perso]);
    // L'imposteur attend une autorisation que Rod peut refuser.
    expect(rod.groups.pending(perso).map((d) => d.id)).toEqual([impostor.id]);
    expect(titles(impostor)).toEqual([]);
  });
  /* ------------------------------------------------ les 3 limites corrigées */

  /** Clé concurrente fabriquée par Julie avec l'ancienne clé, remise (signée par elle) à certains appareils. */
  async function forkKey(julie: Phone, group: string, old: HeldKey, to: Phone[]) {
    const k = await newGroupKey(group, old.epoch + 1, newSecret());
    const links = [{ pk: old.keyId, link: await keyLink(old, k) }];
    // writeKey est privé : on l'appelle comme le ferait une version modifiée de l'appli.
    const write = (julie.groups as unknown as { writeKey: (k: HeldKey, d: { id: string }, l: unknown) => Promise<void> }).writeKey.bind(julie.groups);
    for (const p of to) await write(k, { id: p.id }, links);
    return k;
  }

  async function parentsWithTablet() {
    const rod = await phone('rod');
    const tablet = await phone('rod');
    const julie = await phone('julie');
    const parents = await rod.groups.create({ name: 'Parents', color: '#123456', members: ['rod', 'julie'] });
    await sync();
    await authorize(rod, tablet, parents);
    await authorize(rod, julie, parents);
    const k0 = [...julie.groups.held.values()].find((k) => k.group === parents)!;
    return { rod, tablet, julie, parents, k0 };
  }

  it("limite 1 : la clé concurrente d'un membre retiré ne l'emporte jamais (même s'il ne s'inclut pas)", async () => {
    const { rod, tablet, julie, parents, k0 } = await parentsWithTablet();
    // Au même moment : Rod retire Julie (nouvelle clé pour ses deux appareils), Julie fabrique sa propre clé
    // et la remet aux appareils de Rod, sans se l'envoyer à elle-même pour paraître « moins autorisée ».
    await rod.groups.update(parents, { members: ['rod'] });
    await forkKey(julie, parents, k0, [rod, tablet]);
    await sync();
    expect(tablet.groups.list().map((g) => [g.access, !!g.conflict])).toEqual([['ok', false]]);
    await tablet.groups.saveEvent(randomId(), { title: 'Après le retrait' }, [parents]);
    await sync();
    expect(titles(rod)).toEqual(['Après le retrait']);
    expect(titles(julie)).toEqual([]);
  });

  it("limite 1 : clés concurrentes impossibles à départager → écriture bloquée, renouvellement sans l'intrus", async () => {
    const { rod, tablet, julie, parents, k0 } = await parentsWithTablet();
    await rod.groups.update(parents, { members: ['rod'] });
    await forkKey(julie, parents, k0, [tablet]);
    await sync();
    const g = tablet.groups.list()[0];
    expect(g.conflict).toBe(true);
    await expect(tablet.groups.saveEvent(randomId(), { title: 'Bloqué' }, [parents])).rejects.toThrow();
    // Renouvellement : seuls les appareils autorisés pour les deux clés (ici la tablette) reçoivent la nouvelle.
    await tablet.groups.update(parents, {});
    await sync();
    expect(tablet.groups.list()[0].conflict).toBe(false);
    // Le téléphone de Rod est ré-autorisé depuis la tablette (adoption directe : la clé est liée à la sienne).
    expect(tablet.groups.pending(parents).map((d) => d.id)).toEqual([rod.id]);
    await tablet.groups.grant(parents, rod.id);
    await sync();
    await rod.groups.saveEvent(randomId(), { title: 'Enfin tranquilles' }, [parents]);
    await sync();
    expect(titles(tablet)).toEqual(['Enfin tranquilles']);
    expect(titles(julie)).toEqual([]);
  });

  it('limite 2 : une fausse clé proposée à un nouvel appareil a un autre code et ne sert à rien tant qu’elle n’est pas acceptée', async () => {
    const rod = await phone('rod');
    const leo = await phone('leo');
    await rod.groups.ensurePersonal();
    await sync();
    const perso = await personalGroupId('rod');
    await rod.groups.saveEvent(randomId(), { title: 'Dentiste' }, [perso]);
    await sync();
    const tablet = await phone('rod');
    // Léo envoie le premier une fausse clé « Moi seul » à la tablette (il pourra lire ce qu'elle y écrirait).
    const fake = await newGroupKey(perso, 0, newSecret());
    const write = (leo.groups as unknown as { writeKey: (k: HeldKey, d: { id: string }) => Promise<void> }).writeKey.bind(leo.groups);
    await write(fake, { id: tablet.id });
    await sync();
    expect(tablet.groups.offers()).toHaveLength(1);
    expect(tablet.groups.offers()[0].by).toContain('leo');
    // Rien n'est adopté : la tablette ne peut pas écrire dans ce cercle.
    await expect(tablet.groups.saveEvent(randomId(), { title: 'x' }, [perso])).rejects.toThrow();
    const code = await rod.groups.grant(perso, tablet.id);
    await sync();
    const offers = tablet.groups.offers();
    expect(offers).toHaveLength(2);
    expect(new Set(offers.map((o) => o.code)).size).toBe(2);
    const real = offers.find((o) => o.code === code)!;
    expect(real.by).toContain('rod');
    await tablet.groups.acceptOffer(perso, real.keyId);
    await sync();
    expect(titles(tablet)).toEqual(['Dentiste']);
    expect(tablet.groups.offers()).toEqual([]);
  });

  it("limite 2 : une clé publique remplacée dans la liste des appareils ne reçoit plus rien", async () => {
    const rod = await phone('rod');
    const leo = await phone('leo');
    await rod.groups.ensurePersonal();
    const tablet = await phone('rod');
    // Léo remplace la clé publique de la tablette par la sienne, pour recevoir l'accès à sa place.
    const leoPub = leo.replica.get<{ pub: JsonWebKey }>('devices', leo.id)!.pub;
    await leo.replica.upsert('devices', tablet.id, { pub: leoPub });
    await sync();
    const perso = await personalGroupId('rod');
    expect(rod.groups.suspects().map((d) => d.id)).toEqual([tablet.id]);
    expect(rod.groups.pending(perso)).toEqual([]);
    await expect(rod.groups.grant(perso, tablet.id)).rejects.toThrow();
  });

  it("limite 3 : un élément privé abîmé, effacé « à la main » ou réécrit avec une ancienne clé reste lisible", async () => {
    const { rod, julie, parents } = await parentsWithTablet();
    const leo = await phone('leo');
    const id = randomId();
    await rod.groups.saveEvent(id, { title: 'Réunion' }, [parents]);
    await sync();
    const k0 = [...julie.groups.held.values()].find((k) => k.group === parents)!;
    await rod.groups.update(parents, { members: ['rod'] });
    await sync();
    // Léo écrase le contenu, puis le supprime sans chiffrement.
    await leo.replica.upsert(PRIVATE_EVENTS, id, { box: { v: 1, w: {}, d: 'abîmé' } });
    await sync();
    expect(titles(rod)).toEqual(['Réunion']);
    await leo.replica.remove(PRIVATE_EVENTS, id);
    await sync();
    expect(titles(rod)).toEqual(['Réunion']);
    // Julie (retirée) réécrit l'élément avec l'ancienne clé, qu'elle a toujours.
    const box = await sealPrivate(PRIVATE_EVENTS, id, { title: 'Annulé', groups: [parents] }, [k0]);
    await julie.replica.upsert(PRIVATE_EVENTS, id, { box });
    await sync();
    expect(titles(rod)).toEqual(['Réunion']);
    // Rod peut toujours le modifier normalement.
    await rod.groups.saveEvent(id, { title: 'Réunion (salle 2)' }, [parents]);
    await sync();
    expect(titles(rod)).toEqual(['Réunion (salle 2)']);
  });

  it('limite 3 : une clé reçue reste sur l’appareil même si son enveloppe est effacée (redémarrage compris)', async () => {
    const { rod, tablet, parents } = await parentsWithTablet();
    const leo = await phone('leo');
    await rod.groups.saveEvent(randomId(), { title: 'Toujours là' }, [parents]);
    await sync();
    for (const d of leo.replica.list<GroupKeyDoc>('groupKeys')) await leo.replica.upsert('groupKeys', d.id, { env: 'abîmé', proof: 'faux' });
    await sync();
    // Redémarrage de la tablette : nouveau gestionnaire, même stockage local.
    const restarted = new GroupManager(tablet.replica, { deviceId: tablet.id, privateKey: tablet.privateKey }, () => 'rod', tablet.store);
    await restarted.refresh();
    expect(restarted.privateEvents<{ title: string }>().map((e) => e.title)).toEqual(['Toujours là']);
    expect(restarted.list().map((g) => g.name)).toEqual(['Parents']);
  });
});
