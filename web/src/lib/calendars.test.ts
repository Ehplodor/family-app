import { describe, expect, it } from 'vitest';
import { easter, holidayOn, icsEventsOn, normalizeIcsUrl, parseIcs, schoolHolidayOn } from './calendars';

describe('jours fériés', () => {
  it('calcule Pâques', () => {
    expect(easter(2026)).toBe('2026-04-05');
    expect(easter(2027)).toBe('2027-03-28');
    expect(easter(2025)).toBe('2025-04-20');
  });
  it('trouve les fériés fixes et mobiles', () => {
    expect(holidayOn('2026-07-14')).toBe('Fête nationale');
    expect(holidayOn('2026-04-06')).toBe('Lundi de Pâques');
    expect(holidayOn('2026-05-14')).toBe('Ascension');
    expect(holidayOn('2026-05-25')).toBe('Lundi de Pentecôte');
    expect(holidayOn('2026-07-15')).toBeUndefined();
  });
});

describe('vacances scolaires', () => {
  it('dépend de la zone', () => {
    expect(schoolHolidayOn('2026-02-10', 'A')).toBe("Vacances d'hiver");
    expect(schoolHolidayOn('2026-02-10', 'C')).toBeUndefined();
    expect(schoolHolidayOn('2026-03-08', 'C')).toBe("Vacances d'hiver");
    expect(schoolHolidayOn('2026-12-25', 'B')).toBe('Vacances de Noël');
  });
});

const ICS = [
  'BEGIN:VCALENDAR',
  'X-WR-CALNAME:Matchs U11',
  'BEGIN:VEVENT',
  'SUMMARY:Match contre\\, Lyon',
  'DTSTART;TZID=Europe/Paris:20261128T143000',
  'DTEND;TZID=Europe/Paris:20261128T160000',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Stage',
  'DTSTART;VALUE=DATE:20261221',
  'DTEND;VALUE=DATE:20261224',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Entraînement',
  'DTSTART:20261104T170000',
  'RRULE:FREQ=WEEKLY;COUNT=3',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Anniv',
  'DTSTART;VALUE=DATE:20200310',
  'RRULE:FREQ=YEARLY',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Annulé',
  'STATUS:CANCELLED',
  'DTSTART;VALUE=DATE:20261201',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Trop vieux',
  'DTSTART;VALUE=DATE:20200101',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'SUMMARY:Un titre très',
  '  long',
  'DTSTART;VALUE=DATE:20261202',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('import .ics', () => {
  const { name, events } = parseIcs(ICS, '2026-11-21');
  it('lit le nom et les événements', () => {
    expect(name).toBe('Matchs U11');
    expect(events.find((e) => e.t === 'Match contre, Lyon')).toEqual({ t: 'Match contre, Lyon', d: '2026-11-28', s: '14:30', f: '16:00' });
  });
  it('gère les journées entières sur plusieurs jours (fin exclusive)', () => {
    expect(events.find((e) => e.t === 'Stage')).toEqual({ t: 'Stage', d: '2026-12-21', e: '2026-12-23' });
    expect(icsEventsOn(events, '2026-12-23').map((e) => e.t)).toContain('Stage');
    expect(icsEventsOn(events, '2026-12-24').map((e) => e.t)).not.toContain('Stage');
  });
  it('développe les répétitions bornées et garde les répétitions sans fin', () => {
    expect(events.filter((e) => e.t === 'Entraînement').map((e) => e.d)).toEqual(['2026-11-04', '2026-11-11', '2026-11-18']);
    expect(events.find((e) => e.t === 'Anniv')?.r).toBe('yearly');
    expect(icsEventsOn(events, '2027-03-10').map((e) => e.t)).toEqual(['Anniv']);
  });
  it('ignore les annulés et les trop anciens, recolle les lignes repliées', () => {
    expect(events.some((e) => e.t === 'Annulé' || e.t === 'Trop vieux')).toBe(false);
    expect(events.some((e) => e.t === 'Un titre très long')).toBe(true);
  });
  it('refuse ce qui n’est pas un calendrier', () => {
    expect(() => parseIcs('<html></html>', '2026-11-21')).toThrow();
  });
  it('normalise les adresses', () => {
    expect(normalizeIcsUrl('webcal://example.com/a.ics')).toBe('https://example.com/a.ics');
    expect(normalizeIcsUrl('http://example.com/a.ics')).toBeNull();
    expect(normalizeIcsUrl('pas une adresse')).toBeNull();
  });
});
