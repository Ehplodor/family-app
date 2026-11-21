import { describe, expect, it } from 'vitest';
import { chunkBySize } from './sync';

describe('chunkBySize', () => {
  it('découpe en paquets de taille limitée, sans perdre ni réordonner', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ i, pad: 'x'.repeat(i % 7 === 0 ? 900 : 50) }));
    const chunks = chunkBySize(items, 1000);
    expect(chunks.flat()).toEqual(items);
    for (const c of chunks) if (c.length > 1) expect(JSON.stringify(c).length).toBeLessThanOrEqual(1000 + c.length);
  });
  it('un élément trop gros part seul', () => {
    const chunks = chunkBySize([{ a: 'x'.repeat(5000) }, { b: 1 }], 1000);
    expect(chunks.map((c) => c.length)).toEqual([1, 1]);
  });
});
