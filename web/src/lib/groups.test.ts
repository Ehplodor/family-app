import { describe, expect, it, vi } from 'vitest';

// La réplique enregistre dans IndexedDB : inutile ici (tout reste en mémoire).
vi.mock('./idb', () => ({
  putMany: async () => {},
  entries: async () => [],
  get: async () => undefined,
  put: async () => {},
}));

import { newSecret, deriveGroupKey, deriveGroupKeyId } from './crypto';
import { randomId } from './bytes';
const PRIVATE_EVENTS = 'privateEvents';
import {
  latestKey,
  openPrivate,
  pendingDevices,
  personalGroupId,
  sealPrivate,
  type GroupKeyDoc,
  type HeldKey,
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
