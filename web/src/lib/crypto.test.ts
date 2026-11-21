import { describe, expect, it } from 'vitest';
import {
  deriveCircleKeys,
  deriveInviteKeys,
  newDeviceKeys,
  newSecret,
  open,
  openFromDevice,
  passphraseOpen,
  passphraseSeal,
  safetyCode,
  seal,
  sealToDevice,
} from './crypto';
import { utf8 } from './bytes';

describe('chiffrement', () => {
  it('dérive des identifiants stables et indépendants du secret', async () => {
    const s = newSecret();
    const a = await deriveCircleKeys(s);
    const b = await deriveCircleKeys(s);
    expect(a.circleId).toBe(b.circleId);
    expect(a.token).toBe(b.token);
    expect(a.circleId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.token).not.toContain(a.circleId);
    const other = await deriveCircleKeys(newSecret());
    expect(other.circleId).not.toBe(a.circleId);
    const inv = await deriveInviteKeys(s);
    expect(inv.inviteId).not.toBe(a.circleId);
  });

  it('chiffre, refuse un autre contexte, détecte toute altération', async () => {
    const { key } = await deriveCircleKeys(newSecret());
    const box = await seal(key, utf8.encode('secret de famille'), 'c1:batch');
    expect(new TextDecoder().decode(await open(key, box, 'c1:batch'))).toBe('secret de famille');
    await expect(open(key, box, 'c1:push')).rejects.toThrow();
    const tampered = box.slice(0, -2) + (box.endsWith('A') ? 'BB' : 'AA');
    await expect(open(key, tampered, 'c1:batch')).rejects.toThrow();
    const { key: wrong } = await deriveCircleKeys(newSecret());
    await expect(open(wrong, box, 'c1:batch')).rejects.toThrow();
    // Deux chiffrements du même texte diffèrent (IV aléatoire)
    expect(await seal(key, utf8.encode('x'), 'a')).not.toBe(await seal(key, utf8.encode('x'), 'a'));
  });

  it("transmet un secret à un seul appareil (ECDH)", async () => {
    const bob = await newDeviceKeys();
    const eve = await newDeviceKeys();
    const s = newSecret();
    const env = await sealToDevice(bob.publicJwk, s, 'rotation:abc');
    expect([...(await openFromDevice(bob.privateKey, env, 'rotation:abc'))]).toEqual([...s]);
    await expect(openFromDevice(eve.privateKey, env, 'rotation:abc')).rejects.toThrow();
    await expect(openFromDevice(bob.privateKey, env, 'rotation:autre')).rejects.toThrow();
  });

  it('protège les sauvegardes par phrase secrète', async () => {
    const file = await passphraseSeal('ma phrase très longue', utf8.encode('{"ok":1}'));
    expect(file).not.toContain('ok');
    expect(new TextDecoder().decode(await passphraseOpen('ma phrase très longue', file))).toBe('{"ok":1}');
    await expect(passphraseOpen('mauvaise phrase', file)).rejects.toThrow();
  }, 30_000);

  it('produit des codes de vérification déterministes', async () => {
    const a = await safetyCode('invite', new Uint8Array([1, 2, 3]), 'xy');
    expect(a.split(' ')).toHaveLength(5);
    expect(await safetyCode('invite', new Uint8Array([1, 2, 3]), 'xy')).toBe(a);
    expect(await safetyCode('invite', new Uint8Array([1, 2, 4]), 'xy')).not.toBe(a);
  });
});
