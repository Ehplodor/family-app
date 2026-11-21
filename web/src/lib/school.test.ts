import { describe, expect, it } from 'vitest';
import {
  answerCard,
  computeSchoolReminders,
  DEFAULT_PROFILE,
  dueCards,
  nextClassDate,
  outOfClass,
  parseCards,
  planQuiz,
  planSessions,
  profileOf,
  weekType,
  type Card,
  type Homework,
  type Slot,
} from './school';
import { toISODate } from '../dates';

// Lundi 23 novembre 2026, 16:00
const NOW = new Date(2026, 10, 23, 16, 0).getTime();
const TODAY = '2026-11-23';
const d = (offset: number) => toISODate(new Date(2026, 10, 23 + offset));
const P = profileOf({});
const leo = 'leo';
const slots: Slot[] = [
  { childId: leo, day: 1, start: '08:30', end: '16:30', subject: 'Maths' },
  { childId: leo, day: 2, start: '08:30', end: '12:00', subject: 'Français' },
  { childId: leo, day: 2, start: '13:30', end: '16:30', subject: 'Histoire' },
  { childId: leo, day: 3, start: '08:30', end: '12:00', subject: 'Anglais' },
  { childId: leo, day: 4, start: '08:30', end: '16:30', subject: 'Maths' },
  { childId: leo, day: 5, start: '08:30', end: '11:00', subject: 'Sport', weeks: 'A' },
  { childId: leo, day: 5, start: '08:30', end: '11:00', subject: 'Musique', weeks: 'B' },
];
const hw = (id: string, h: Partial<Homework>) => ({ id, childId: leo, kind: 'devoir' as const, subject: 'Maths', title: 'Exercices', due: d(3), ...h });

describe('emploi du temps', () => {
  it('gère les semaines A/B et trouve le prochain cours', () => {
    const p = profileOf({ weekARef: '2026-11-23' });
    expect(weekType(d(4), p.weekARef)).toBe('A');
    expect(weekType(d(11), p.weekARef)).toBe('B');
    expect(nextClassDate(slots, leo, 'Maths', p, TODAY)).toBe(d(3)); // jeudi
    expect(nextClassDate(slots, leo, 'Sport', p, TODAY)).toBe(d(4));
    expect(nextClassDate(slots, leo, 'Musique', p, TODAY)).toBe(d(11)); // vendredi de semaine B
  });

  it('ne notifie jamais pendant un cours', () => {
    const during = new Date(2026, 10, 24, 10, 0).getTime(); // mardi 10:00, cours de français
    expect(new Date(outOfClass(during, slots, leo, P)).getHours()).toBe(12);
    const evening = new Date(2026, 10, 24, 18, 0).getTime();
    expect(outOfClass(evening, slots, leo, P)).toBe(evening);
  });
});

describe('planification des devoirs', () => {
  it("commence un devoir le plus tôt possible, pas la veille", () => {
    const s = planSessions([hw('a', { effort: 20, due: d(3) })], leo, slots, P, TODAY, 16 * 60);
    expect(s).toEqual([{ hwId: 'a', date: TODAY, minutes: 20 }]);
  });

  it('étale un exposé en séances courtes jusqu’à la veille', () => {
    const s = planSessions([hw('e', { kind: 'expose', effort: 100, due: d(10) })], leo, slots, P, TODAY, 16 * 60);
    expect(s).toHaveLength(5);
    expect(s.every((x) => x.minutes === 20)).toBe(true);
    expect(new Set(s.map((x) => x.date)).size).toBe(5);
    expect(s[s.length - 1].date < d(10)).toBe(true);
    expect(s[0].date).toBe(TODAY);
    expect(s[4].date >= d(6)).toBe(true); // réparti sur la période, pas tassé au début
  });

  it('révise un contrôle de façon espacée (J-1, J-3, J-6)', () => {
    const s = planSessions([hw('c', { kind: 'controle', subject: 'Histoire', effort: 60, due: d(8) })], leo, slots, P, TODAY, 16 * 60);
    expect(s.map((x) => x.date)).toEqual([d(2), d(5), d(7)]);
  });

  it('respecte la charge maximale par jour et planifie d’abord l’échéance la plus proche', () => {
    const p = profileOf({ capacity: [20, 20, 20, 20, 20, 20, 20] });
    const s = planSessions([hw('loin', { due: d(5) }), hw('proche', { due: d(2) })], leo, slots, p, TODAY, 16 * 60);
    expect(s.find((x) => x.hwId === 'proche')!.date).toBe(TODAY);
    expect(s.find((x) => x.hwId === 'loin')!.date).toBe(d(1));
  });

  it("tient compte du travail déjà fait", () => {
    const done = planSessions([hw('a', { effort: 40, log: { [TODAY]: 20 } })], leo, slots, P, TODAY, 16 * 60);
    expect(done).toEqual([{ hwId: 'a', date: d(1), minutes: 20 }]);
    expect(planSessions([hw('b', { effort: 20, log: { [d(-1)]: 20 } })], leo, slots, P, TODAY, 16 * 60)).toEqual([]);
  });

  it('regroupe en une séance un travail qui ne tient qu’en un seul jour, sans fausse alerte', () => {
    const s = planSessions([hw('m', { effort: 30, due: d(1) })], leo, slots, P, TODAY, 16 * 60);
    expect(s).toEqual([{ hwId: 'm', date: TODAY, minutes: 30 }]);
  });

  it("signale un devoir pour demain pas encore commencé", () => {
    const s = planSessions([hw('x', { due: d(1) })], leo, slots, P, TODAY, 21 * 60);
    expect(s).toEqual([{ hwId: 'x', date: TODAY, minutes: 20, late: true }]);
  });
});

describe('répétition espacée', () => {
  const card = (id: string, c: Partial<Card>) => ({ id, childId: leo, subject: 'Géographie', question: 'Q' + id, answer: 'R', box: 1, due: TODAY, ...c });

  it('suit les boîtes de Leitner', () => {
    expect(answerCard({ box: 1 }, true, TODAY)).toEqual({ box: 2, due: d(2) });
    expect(answerCard({ box: 4 }, true, TODAY)).toEqual({ box: 5, due: d(16) });
    expect(answerCard({ box: 4 }, false, TODAY)).toEqual({ box: 1, due: d(1) });
  });

  it("donne la priorité aux leçons du prochain contrôle", () => {
    const cards = [card('vieux', { box: 1 }), card('ctrl', { box: 5, due: d(20), lessonId: 'L1' })];
    const homework = [hw('c', { kind: 'controle', due: d(3), lessonIds: ['L1'] })];
    expect(dueCards(cards, homework, leo, TODAY).map((c) => c.id)).toEqual(['ctrl', 'vieux']);
  });

  it('espace les questions dans le temps', () => {
    const q = planQuiz([card('a', {})], [], leo, Array.from({ length: 14 }, (_, i) => d(i)), 2);
    expect(q.map((x) => x.date)).toEqual([d(0), d(2), d(6), d(14)].filter((x) => x <= d(13)));
  });

  it('lit les leçons saisies sous la forme « question = réponse »', () => {
    expect(parseCards('Capitale de l’Espagne = Madrid\n7 × 8 → 56\nligne sans réponse')).toEqual([
      { question: 'Capitale de l’Espagne', answer: 'Madrid' },
      { question: '7 × 8', answer: '56' },
    ]);
  });
});

describe('rappels école', () => {
  const data = {
    members: [
      { id: leo, name: 'Léo', kind: 'child' },
      { id: 'papa', name: 'Papa' },
      { id: 'maman', name: 'Maman' },
    ],
    profiles: [{ id: leo, parentCopy: { ...DEFAULT_PROFILE.parentCopy, parentIds: ['papa'] } }],
    slots,
    homework: [hw('a', { title: 'p. 42', due: d(3) }), hw('s', { kind: 'prevoir' as const, title: 'Tenue de sport', due: d(1) })],
    cards: [{ id: 'k', childId: leo, subject: 'Anglais', question: 'chat ?', answer: 'cat', box: 1, due: TODAY }],
  };

  it("rappelle à l'enfant ses séances, son cartable et ses petites questions", () => {
    const r = computeSchoolReminders(data, leo, NOW);
    const session = r.find((x) => x.kind === 'school')!;
    expect(new Date(session.at).getHours()).toBe(17);
    expect(session.title).toBe("📚 20 min de travail aujourd'hui");
    expect(session.body).toContain('Maths : p. 42');
    const bag = r.find((x) => x.kind === 'bag')!;
    expect(bag.body).toBe('Français, Histoire · 🎒 Tenue de sport');
    const quiz = r.find((x) => x.kind === 'quiz')!;
    expect(quiz.body).toBe('chat ?');
    expect(quiz.answer).toBe('cat');
  });

  it('envoie une copie au parent choisi, avec délai « si pas fait », sans les questions', () => {
    const child = computeSchoolReminders(data, leo, NOW);
    const papa = computeSchoolReminders(data, 'papa', NOW);
    const s = papa.find((x) => x.kind === 'school')!;
    expect(s.title.startsWith('Léo · ')).toBe(true);
    expect(s.at - child.find((x) => x.kind === 'school')!.at).toBe(60 * 60_000);
    expect(s.body).toContain('pas encore noté comme fait');
    expect(papa.some((x) => x.kind === 'quiz')).toBe(false);
    expect(computeSchoolReminders(data, 'maman', NOW)).toEqual([]);
  });

  it('sans parent choisi, la copie va à tous les adultes', () => {
    const all = { ...data, profiles: [{ id: leo }] };
    expect(computeSchoolReminders(all, 'maman', NOW).some((x) => x.kind === 'school')).toBe(true);
    const off = { ...data, profiles: [{ id: leo, parentCopy: { ...DEFAULT_PROFILE.parentCopy, enabled: false } }] };
    expect(computeSchoolReminders(off, 'papa', NOW)).toEqual([]);
  });

  it('retire le rappel (et la copie) dès que le travail du jour est noté', () => {
    const doneData = { ...data, homework: [hw('a', { title: 'p. 42', effort: 20, log: { [TODAY]: 20 } })] };
    expect(computeSchoolReminders(doneData, 'papa', NOW).filter((x) => x.kind === 'school')).toEqual([]);
  });
});
