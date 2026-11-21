import { describe, expect, it } from 'vitest';
import { applyOp, mergeRecord, toDoc, HLC, type DocRecord, type Op } from './replica';

function state(ops: Op[]) {
  const docs = new Map<string, DocRecord>();
  for (const op of ops) applyOp(docs, op);
  return [...docs.values()].map((r) => toDoc(r)).sort((a, b) => a.id.localeCompare(b.id));
}

function shuffle<T>(arr: T[], seed: number) {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

describe('fusion des modifications (CRDT)', () => {
  const alice = new HLC('a'.repeat(32));
  const bob = new HLC('b'.repeat(32));
  const ops: Op[] = [
    { i: 'x', c: 'listItems', t: alice.now(), f: { text: 'lait', done: false }, cb: 'alice' },
    { i: 'x', c: 'listItems', t: bob.now(), f: { done: true }, },
    { i: 'x', c: 'listItems', t: alice.now(), f: { text: 'lait demi-écrémé' } },
    { i: 'y', c: 'listItems', t: bob.now(), f: { text: 'pain' }, cb: 'bob' },
    { i: 'y', c: 'listItems', t: alice.now(), d: 1 },
    { i: 'z', c: 'events', t: bob.now(), f: { title: 'Piscine', memberIds: ['bob'] }, cb: 'bob' },
  ];

  it("converge quel que soit l'ordre de réception", () => {
    const reference = JSON.stringify(state(ops));
    for (let seed = 1; seed < 30; seed++) expect(state(shuffle(ops, seed))).toEqual(JSON.parse(reference));
  });

  it('fusionne champ par champ (pas d’écrasement du document entier)', () => {
    const docs = new Map<string, DocRecord>();
    ops.forEach((op) => applyOp(docs, op));
    const x = toDoc<{ text: string; done: boolean }>(docs.get('listItems/x')!);
    expect(x.text).toBe('lait demi-écrémé');
    expect(x.done).toBe(true);
    expect(x.createdBy).toBe('alice');
    expect(docs.get('listItems/y')!.del).toBeTruthy();
  });

  it('les instantanés fusionnent comme les opérations', () => {
    const a = new Map<string, DocRecord>();
    const b = new Map<string, DocRecord>();
    ops.slice(0, 3).forEach((op) => applyOp(a, op));
    ops.slice(2).forEach((op) => applyOp(b, op));
    for (const r of b.values()) mergeRecord(a, r);
    expect([...a.values()].map((r) => toDoc(r)).sort((p, q) => p.id.localeCompare(q.id))).toEqual(state(ops));
  });

  it("garde le bon auteur même si l'horloge d'un appareil retarde", () => {
    const late = `${(Date.now() - 3_600_000).toString(36).padStart(9, '0')}0000-${'b'.repeat(32)}`;
    const create: Op = { i: 'k', c: 'tasks', t: alice.now(), f: { title: 'A' }, cb: 'alice' };
    const edit: Op = { i: 'k', c: 'tasks', t: late, f: { done: true } };
    expect(state([create, edit])).toEqual(state([edit, create]));
    expect(state([edit, create])[0].createdBy).toBe('alice');
  });

  it("l'horloge hybride reste monotone et ignore les dates aberrantes", () => {
    const c = new HLC('c'.repeat(32));
    const t1 = c.now();
    c.receive(`${(Date.now() + 10 * 86_400_000).toString(36).padStart(9, '0')}0000-${'d'.repeat(32)}`);
    const t2 = c.now();
    expect(t2 > t1).toBe(true);
    expect(HLC.parseMs(t2)).toBeLessThan(Date.now() + 1000);
  });
});
