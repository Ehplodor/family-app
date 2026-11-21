/** Recherche et filtre du calendrier : fonctions pures, testées dans calendarSearch.test.ts. */
import { addDays, parseISODate, toISODate } from '../dates';
import { occursOn, type Repeat } from './recurrence';

export type SearchMode = 'prefix' | 'contains';

/** Minuscules et sans accents, pour que « ecole » trouve « École ». */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** « Commence par » regarde le titre ; « Contient » regarde le titre et les notes. */
export function matchesQuery(item: { title: string; notes?: string }, query: string, mode: SearchMode): boolean {
  const q = normalize(query);
  if (!q) return false;
  const title = normalize(item.title);
  if (mode === 'prefix') return title.startsWith(q);
  return title.includes(q) || normalize(item.notes ?? '').includes(q);
}

/**
 * Filtre par personne : sans filtre, tout est visible. Un événement sans personne associée concerne toute la
 * famille et reste visible ; sinon il faut qu'au moins une des personnes choisies y participe.
 */
export function visibleFor(memberIds: string[], filter: string[]): boolean {
  if (!filter.length || !memberIds.length) return true;
  return memberIds.some((id) => filter.includes(id));
}

/** Date à afficher pour un résultat : la prochaine occurrence à partir de `from` pour un événement répété. */
export function displayDate(ev: { date: string; endDate?: string; repeat?: Repeat }, from: string): string {
  if (!ev.repeat || ev.repeat === 'none' || ev.date >= from) return ev.date;
  let d = parseISODate(from);
  for (let i = 0; i < 400; i++, d = addDays(d, 1)) {
    const iso = toISODate(d);
    if (occursOn(ev, iso)) return iso;
  }
  return ev.date;
}

/** Résultats à venir d'abord (du plus proche au plus lointain), puis passés (du plus récent au plus ancien). */
export function sortResults<T extends { date: string; until?: string }>(items: T[], from: string): T[] {
  const upcoming = (x: T) => (x.until ?? x.date) >= from;
  return [...items].sort((a, b) => {
    const ua = upcoming(a);
    const ub = upcoming(b);
    if (ua !== ub) return ua ? -1 : 1;
    return ua ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date);
  });
}
