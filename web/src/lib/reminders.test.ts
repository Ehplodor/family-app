import { describe, expect, it } from 'vitest';
import { computeReminders, DEFAULT_PREFS, outOfQuietHours, type ReminderData } from './reminders';
import { toISODate } from '../dates';

const NOW = new Date(2026, 10, 21, 10, 0).getTime(); // samedi 21 novembre 2026, 10:00
const day = (offset: number) => toISODate(new Date(2026, 10, 21 + offset));
const empty: ReminderData = { events: [], birthdays: [], tasks: [], meals: [] };
const prefs = { ...DEFAULT_PREFS, digest: null, weeklyPlanning: false };

describe('rappels', () => {
  it("rappelle un rendez-vous selon le délai, seulement aux personnes concernées", () => {
    const data = { ...empty, events: [{ id: 'e', title: 'Dentiste', date: day(0), allDay: false, start: '14:00', memberIds: ['julie'] }] };
    const julie = computeReminders(data, 'julie', prefs, NOW);
    expect(julie).toHaveLength(1);
    expect(new Date(julie[0].at).getHours()).toBe(13);
    expect(new Date(julie[0].at).getMinutes()).toBe(30);
    expect(julie[0].urgent).toBe(true);
    expect(computeReminders(data, 'leo', prefs, NOW)).toHaveLength(0);
  });

  it('respecte un rappel personnalisé ou désactivé', () => {
    const ev = { id: 'e', title: 'Train', date: day(1), allDay: false, start: '06:30', memberIds: [] };
    const custom = computeReminders({ ...empty, events: [{ ...ev, reminder: 60 }] }, 'x', prefs, NOW);
    expect(new Date(custom[0].at).getHours()).toBe(5); // 5:30, avant le réveil : passe quand même (urgent)
    expect(computeReminders({ ...empty, events: [{ ...ev, reminder: null }] }, 'x', prefs, NOW)).toHaveLength(0);
  });

  it('répète les événements hebdomadaires sur 14 jours', () => {
    const data = { ...empty, events: [{ id: 'p', title: 'Piscine', date: day(-7), allDay: false, start: '17:00', repeat: 'weekly' as const, memberIds: [] }] };
    expect(computeReminders(data, 'x', prefs, NOW)).toHaveLength(3); // J0, J+7, J+14
  });

  it('ne rappelle qu’une fois un événement à heure fixe sur plusieurs jours', () => {
    const data = { ...empty, events: [{ id: 'w', title: 'Week-end ski', date: day(1), endDate: day(3), allDay: false, start: '14:00', end: '18:00', memberIds: [] }] };
    const r = computeReminders(data, 'x', prefs, NOW);
    expect(r).toHaveLength(1);
    expect(new Date(r[0].at).getDate()).toBe(22);
  });

  it('décale les notifications non urgentes après les heures calmes', () => {
    const late = new Date(2026, 10, 21, 23, 15).getTime();
    const shifted = new Date(outOfQuietHours(late, prefs));
    expect([shifted.getDate(), shifted.getHours(), shifted.getMinutes()]).toEqual([22, 7, 30]);
    const noon = new Date(2026, 10, 21, 12, 0).getTime();
    expect(outOfQuietHours(noon, prefs)).toBe(noon);
  });

  it("prévient pour les anniversaires (J-7 et jour J)", () => {
    const data = { ...empty, birthdays: [{ id: 'b', name: 'Léo', day: 1, month: 12, year: 2018 }] };
    const r = computeReminders(data, 'x', prefs, NOW);
    expect(r.map((x) => x.tag)).toEqual(['bd-b-soon', 'bd-b']);
    expect(r[1].body).toContain('8 ans');
  });

  it('cible la personne assignée et relance les tâches en retard une seule fois', () => {
    const data = {
      ...empty,
      tasks: [
        { id: 't1', title: 'Poubelles', due: day(1), repeat: 'weekly' as const, assigneeId: 'julie' },
        { id: 't2', title: 'Vaccin du chat', due: day(-3), repeat: 'none' as const },
        { id: 't3', title: 'Fait', due: day(1), repeat: 'none' as const, done: true },
      ],
    };
    const leo = computeReminders(data, 'leo', prefs, NOW);
    expect(leo.map((r) => r.title)).toEqual(['En retard : Vaccin du chat']);
    expect(new Date(leo[0].at).getDate()).toBe(22); // 9:00 déjà passé aujourd'hui → demain
    expect(computeReminders(data, 'julie', prefs, NOW).map((r) => r.tag)).toContain('task-t1');
  });

  it('annonce les repas la veille et produit un résumé du matin', () => {
    const data = { ...empty, meals: [{ date: day(1), slot: 'dinner' as const, title: 'Crêpes' }] };
    const r = computeReminders(data, 'x', { ...prefs, digest: '07:30' }, NOW);
    const meal = r.find((x) => x.kind === 'meal')!;
    expect(new Date(meal.at).getDate()).toBe(21);
    expect(meal.body).toBe('soir : Crêpes');
    const digest = r.find((x) => x.kind === 'digest')!;
    expect(new Date(digest.at).getDate()).toBe(22);
    expect(digest.body).toContain('Crêpes');
  });
});
