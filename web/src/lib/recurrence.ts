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

/** Fin effective d'un événement sur plusieurs jours (uniquement s'il ne se répète pas). */
export function spanEnd(ev: { date: string; endDate?: string; repeat?: Repeat }): string | undefined {
  return (ev.repeat ?? 'none') === 'none' && ev.endDate && ev.endDate > ev.date ? ev.endDate : undefined;
}

/** Place d'un jour dans un événement sur plusieurs jours : premier, milieu ou dernier jour. */
export function spanPart(ev: { date: string; endDate?: string; repeat?: Repeat }, iso: string): 'first' | 'middle' | 'last' | undefined {
  const end = spanEnd(ev);
  if (!end || iso < ev.date || iso > end) return undefined;
  return iso === ev.date ? 'first' : iso === end ? 'last' : 'middle';
}

/** Heure affichée un jour donné : « 14:00 → » le premier jour, « → 18:00 » le dernier, rien entre les deux. */
export function timeLabel(ev: { date: string; endDate?: string; repeat?: Repeat; allDay: boolean; start?: string; end?: string }, iso: string): string | undefined {
  if (ev.allDay) return undefined;
  const part = spanPart(ev, iso);
  if (part === 'first') return ev.start ? `${ev.start} →` : undefined;
  if (part === 'last') return ev.end ? `→ ${ev.end}` : undefined;
  if (part === 'middle') return undefined;
  return [ev.start, ev.end].filter(Boolean).join(' – ') || undefined;
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
