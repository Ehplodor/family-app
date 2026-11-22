import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./idb', () => ({
  get: async () => undefined,
  put: async () => {},
  putMany: async () => {},
  entries: async () => [],
  del: async () => {},
}));

/** Fausse connexion WebSocket : on décide de ce que « le relais » répond. */
class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.all.push(this);
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

const docListeners: Record<string, () => void> = {};
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

async function connectedClient() {
  vi.stubEnv('VITE_RELAY_URL', 'https://relais.test');
  vi.resetModules();
  const { SyncClient } = await import('./sync');
  const keys = { circleId: 'c'.repeat(32), token: 't'.repeat(43) } as never;
  const replica = { deviceId: 'd1', mergeRecords: async () => {}, applyRemote: async () => {}, allRecords: () => [] } as never;
  const client = new SyncClient(keys, replica);
  await client.start();
  await flush();
  const ws = FakeWS.all.at(-1)!;
  ws.open();
  ws.receive({ t: 'ready', seq: 0 });
  await flush();
  expect(client.status).toBe('online');
  return { client, ws };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWS.all = [];
  vi.stubGlobal('WebSocket', FakeWS);
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ closed: false }), { status: 200 }));
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal('document', {
    visibilityState: 'visible',
    addEventListener: (t: string, l: () => void) => (docListeners[t] = l),
    removeEventListener: () => {},
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('synchronisation : connexion morte après la mise en veille', () => {
  it('au retour au premier plan, une connexion qui ne répond plus est remplacée', async () => {
    const { client, ws } = await connectedClient();
    // L'appli passe des heures en arrière-plan ; Android a coupé la connexion sans la fermer.
    await vi.advanceTimersByTimeAsync(20_000);
    docListeners.visibilitychange();
    expect(ws.sent.at(-1)).toBe('{"t":"ping"}');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ws.closed).toBe(true);
    expect(client.status).toBe('offline');
    await vi.advanceTimersByTimeAsync(1_500);
    await flush();
    expect(FakeWS.all.length).toBe(2);
    client.stop();
  });

  it('une connexion qui répond est gardée', async () => {
    const { client, ws } = await connectedClient();
    await vi.advanceTimersByTimeAsync(20_000);
    docListeners.visibilitychange();
    ws.receive({ t: 'pong' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ws.closed).toBe(false);
    expect(FakeWS.all.length).toBe(1);
    expect(client.status).toBe('online');
    client.stop();
  });

  it('sans aucune réponse pendant deux « ping », on se reconnecte même sans changer d’écran', async () => {
    const { client, ws } = await connectedClient();
    await vi.advanceTimersByTimeAsync(80_000);
    expect(ws.closed).toBe(true);
    await flush();
    expect(FakeWS.all.length).toBeGreaterThanOrEqual(2);
    client.stop();
  });
});
