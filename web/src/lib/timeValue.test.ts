import { describe, expect, it } from 'vitest';
import { formatTime, parseTime, stepMinutes } from './timeValue';

describe('heures HH:MM', () => {
  it('lit et réécrit une heure', () => {
    expect(parseTime('07:05')).toEqual({ h: 7, m: 5 });
    expect(parseTime('7:05')).toEqual({ h: 7, m: 5 });
    expect(parseTime('18:30:00')).toEqual({ h: 18, m: 30 });
    expect(formatTime({ h: 7, m: 5 })).toBe('07:05');
  });
  it('ignore une valeur vide ou invalide', () => {
    expect(parseTime('')).toBeNull();
    expect(parseTime(undefined)).toBeNull();
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('12:60')).toBeNull();
    expect(parseTime('abc')).toBeNull();
  });
  it('ajuste les minutes en boucle', () => {
    expect(stepMinutes({ h: 8, m: 59 }, 1)).toEqual({ h: 8, m: 0 });
    expect(stepMinutes({ h: 8, m: 0 }, -1)).toEqual({ h: 8, m: 59 });
    expect(stepMinutes({ h: 8, m: 10 }, 5)).toEqual({ h: 8, m: 15 });
  });
});
