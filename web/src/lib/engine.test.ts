import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('moteur : pas de recalcul sans fin', () => {
  it("une fois la famille créée, le coffre ne se recalcule plus tout seul", async () => {
    const e = await Engine.boot();
    await e.createCircle('Les Martin', 'Rod', '#ff0000');
    await e.vault.create('messages', { text: 'Bonjour' });
    // Le temps que les contrôles d'arrière-plan (profil, appareil, migration) se terminent.
    await pause(300);
    const before = e.vault.getVersion();
    await pause(500);
    expect(e.vault.getVersion() - before).toBeLessThanOrEqual(2);
    expect(e.vault.list<{ text: string }>('messages').map((m) => m.text)).toEqual(['Bonjour']);
  });
});
