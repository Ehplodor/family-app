import { describe, expect, it, vi } from 'vitest';

vi.mock('./sync', () => ({ RELAY_URL: '' }));
vi.mock('./engine', () => ({ deviceLabel: () => 'test' }));

import { newDeviceKeys, newSecret, newSigningKeys } from './crypto';
import { deviceIdOf } from './circles';
import { requestSafetyCode } from './invite';

async function device() {
  const k = await newDeviceKeys();
  const s = await newSigningKeys();
  return { pub: k.publicJwk, spub: s.signJwk, device: await deviceIdOf(s.signJwk, k.publicJwk) };
}

describe("invitation : code de 5 émojis", () => {
  it('couvre les deux clés : une clé de signature glissée par un tiers change le code', async () => {
    const secret = newSecret();
    const vrai = await device();
    const intrus = await device();
    const code = await requestSafetyCode(secret, { label: 'x', ...vrai });
    expect(await requestSafetyCode(secret, { label: 'x', ...vrai })).toBe(code);
    // Même clé de chiffrement que le vrai appareil, mais la clé de signature de l'intrus.
    const melange = { label: 'x', pub: vrai.pub, spub: intrus.spub, device: await deviceIdOf(intrus.spub, vrai.pub) };
    expect(await requestSafetyCode(secret, melange)).not.toBe(code);
    // Identifiant qui ne correspond pas aux clés : pas le code de l'appareil.
    expect(await requestSafetyCode(secret, { ...melange, device: vrai.device })).not.toBe(code);
  });
});
