import { describe, expect, it } from 'vitest';
import { atTime, daysLabel, isRight, makeChallenges, nextRing, ringsBetween, type Alarm } from './alarms';

const base: Alarm = { memberId: 'm', deviceId: 'd', time: '07:00', days: [], enabled: true, mode: 'simple' };
// Mercredi 4 mars 2026, 22 h (heure locale)
const wed22 = new Date(2026, 2, 4, 22, 0).getTime();

describe('réveils', () => {
  it('« une fois » sonne le lendemain matin, puis plus jamais', () => {
    const a = { ...base, armedAt: wed22 };
    expect(nextRing(a, wed22)).toBe(atTime('2026-03-05', '07:00'));
    expect(ringsBetween(a, wed22, wed22 + 7 * 86400_000)).toEqual([atTime('2026-03-05', '07:00')]);
    expect(nextRing(a, atTime('2026-03-05', '07:00'))).toBeNull();
  });

  it('« une fois » activé le matin avant l’heure sonne le jour même', () => {
    const a = { ...base, armedAt: new Date(2026, 2, 4, 6, 0).getTime() };
    expect(nextRing(a, a.armedAt!)).toBe(atTime('2026-03-04', '07:00'));
  });

  it('répétition en semaine', () => {
    const a = { ...base, days: [1, 2, 3, 4, 5] };
    const rings = ringsBetween(a, wed22, wed22 + 7 * 86400_000).map((t) => new Date(t).getDate());
    expect(rings).toEqual([5, 6, 9, 10, 11]); // jeu, ven, lun, mar, mer
    expect(daysLabel(a.days)).toBe('En semaine');
  });

  it('désactivé : ne sonne pas', () => {
    expect(ringsBetween({ ...base, enabled: false, days: [0, 1, 2, 3, 4, 5, 6] }, wed22, wed22 + 86400_000 * 3)).toEqual([]);
  });

  it('défis : calcul et mots', () => {
    const math = makeChallenges('math', () => 0.5);
    expect(math).toHaveLength(3);
    const calc = (p: string) => {
      const [a, op, b] = p.split(' ');
      return op === '+' ? +a + +b : op === '×' ? +a * +b : +a - +b;
    };
    for (const c of math) expect(isRight(c, String(calc(c.prompt)))).toBe(true);
    const [w] = makeChallenges('words', () => 0);
    expect(isRight(w, `  ${w.answer.toUpperCase()} `)).toBe(true);
    expect(isRight(w, 'autre chose')).toBe(false);
    expect(makeChallenges('simple')).toEqual([]);
  });
});
