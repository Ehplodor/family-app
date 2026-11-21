/** Règles de récurrence partagées par l'agenda, les tâches et les rappels. */
import { addDays, addMonths, parseISODate, toISODate, today } from '../dates';

export type Repeat = 'none' | 'weekly' | 'monthly' | 'yearly';
export type TaskRepeat = 'none' | 'daily' | 'weekly' | 'monthly';

export function occursOn(ev: { date: string; endDate?: string; repeat?: Repeat }, iso: string): boolean {
  if (iso < ev.date) return false;
  const d = parseISODate(iso);
  const s = parseISODate(ev.date);
  switch (ev.repeat) {
    case 'weekly':
      return d.getDay() === s.getDay();
    case 'monthly':
      return d.getDate() === s.getDate();
    case 'yearly':
      return d.getDate() === s.getDate() && d.getMonth() === s.getMonth();
    default:
      return iso <= (ev.endDate && ev.endDate > ev.date ? ev.endDate : ev.date);
  }
}

function advance(iso: string, repeat: TaskRepeat): string {
  const d = parseISODate(iso);
  if (repeat === 'daily') return toISODate(addDays(d, 1));
  if (repeat === 'weekly') return toISODate(addDays(d, 7));
  return toISODate(addMonths(d, 1));
}

/** Prochaine échéance d'une tâche récurrente, strictement après aujourd'hui. */
export function nextDue(task: { due: string; repeat: TaskRepeat }): string {
  let next = advance(task.due, task.repeat);
  while (next <= today()) next = advance(next, task.repeat);
  return next;
}
