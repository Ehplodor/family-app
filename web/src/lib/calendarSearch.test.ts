import { describe, expect, it } from 'vitest';
import { displayDate, matchesQuery, normalize, sortResults, visibleFor } from './calendarSearch';

describe('recherche dans le calendrier', () => {
  it('ignore les accents et la casse', () => {
    expect(normalize('  École ')).toBe('ecole');
  });

  it('« commence par » ne regarde que le début du titre', () => {
    expect(matchesQuery({ title: 'Piscine des enfants' }, 'pisc', 'prefix')).toBe(true);
    expect(matchesQuery({ title: 'Cours de piscine' }, 'pisc', 'prefix')).toBe(false);
  });

  it('« contient » regarde le titre et les notes', () => {
    expect(matchesQuery({ title: 'Cours de piscine' }, 'PISC', 'contains')).toBe(true);
    expect(matchesQuery({ title: 'Dentiste', notes: 'Dr Lefèvre' }, 'lefevre', 'contains')).toBe(true);
    expect(matchesQuery({ title: 'Dentiste' }, '', 'contains')).toBe(false);
  });
});

describe('filtre par personne', () => {
  it('sans filtre, tout est visible', () => {
    expect(visibleFor(['a'], [])).toBe(true);
  });
  it('un événement sans personne reste visible', () => {
    expect(visibleFor([], ['a'])).toBe(true);
  });
  it('il faut au moins une personne en commun', () => {
    expect(visibleFor(['a', 'b'], ['b'])).toBe(true);
    expect(visibleFor(['a'], ['b'])).toBe(false);
  });
});

describe('dates des résultats', () => {
  it("donne la prochaine occurrence d'un événement répété", () => {
    // 2026-01-05 est un lundi ; le prochain lundi à partir du jeudi 2026-11-19 est le 2026-11-23.
    expect(displayDate({ date: '2026-01-05', repeat: 'weekly' }, '2026-11-19')).toBe('2026-11-23');
    expect(displayDate({ date: '2026-01-05' }, '2026-11-19')).toBe('2026-01-05');
  });

  it('met les événements à venir avant les passés', () => {
    const r = sortResults(
      [
        { date: '2026-01-01' },
        { date: '2026-12-01' },
        { date: '2026-11-25' },
        { date: '2026-10-01' },
        { date: '2026-11-10', until: '2026-11-22' },
      ],
      '2026-11-20',
    );
    expect(r.map((x) => x.date)).toEqual(['2026-11-10', '2026-11-25', '2026-12-01', '2026-10-01', '2026-01-01']);
  });
});
