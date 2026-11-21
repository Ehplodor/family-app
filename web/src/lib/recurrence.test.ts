import { describe, expect, it } from 'vitest';
import { occursOn, spanEnd, spanPart, timeLabel } from './recurrence';

describe('événements sur plusieurs jours', () => {
  const sejour = { date: '2026-11-20', endDate: '2026-11-23', allDay: false, start: '14:00', end: '18:00' };

  it('couvre chaque jour entre le début et la fin', () => {
    expect(occursOn(sejour, '2026-11-19')).toBe(false);
    expect(occursOn(sejour, '2026-11-21')).toBe(true);
    expect(occursOn(sejour, '2026-11-23')).toBe(true);
    expect(occursOn(sejour, '2026-11-24')).toBe(false);
  });

  it('situe chaque jour dans le séjour', () => {
    expect(spanPart(sejour, '2026-11-20')).toBe('first');
    expect(spanPart(sejour, '2026-11-22')).toBe('middle');
    expect(spanPart(sejour, '2026-11-23')).toBe('last');
    expect(spanPart(sejour, '2026-11-24')).toBeUndefined();
    expect(spanPart({ date: '2026-11-20' }, '2026-11-20')).toBeUndefined();
  });

  it("affiche l'heure de début le premier jour et l'heure de fin le dernier", () => {
    expect(timeLabel(sejour, '2026-11-20')).toBe('14:00 →');
    expect(timeLabel(sejour, '2026-11-21')).toBeUndefined();
    expect(timeLabel(sejour, '2026-11-23')).toBe('→ 18:00');
    expect(timeLabel({ ...sejour, endDate: undefined }, '2026-11-20')).toBe('14:00 – 18:00');
    expect(timeLabel({ ...sejour, allDay: true }, '2026-11-20')).toBeUndefined();
  });

  it('ignore une date de fin incohérente ou sur un événement répété', () => {
    expect(spanEnd({ date: '2026-11-20', endDate: '2026-11-19' })).toBeUndefined();
    expect(spanEnd({ date: '2026-11-20', endDate: '' })).toBeUndefined();
    expect(spanEnd({ date: '2026-11-20', endDate: '2026-11-22', repeat: 'weekly' })).toBeUndefined();
  });
});
