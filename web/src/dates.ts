/** Utilitaires de dates (toujours en heure locale, format AAAA-MM-JJ). */

export const pad = (n: number) => String(n).padStart(2, '0');

export function toISODate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export const today = () => toISODate(new Date());

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function addMonths(d: Date, n: number): Date {
  const r = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(d.getDate(), last));
  return r;
}

/** Lundi de la semaine de d. */
export function startOfWeek(d: Date): Date {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() - ((r.getDay() + 6) % 7));
  return r;
}

export function daysBetween(fromISO: string, toISO: string): number {
  return Math.round((parseISODate(toISO).getTime() - parseISODate(fromISO).getTime()) / 86_400_000);
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
export function fmt(d: Date | string, options: Intl.DateTimeFormatOptions): string {
  const key = JSON.stringify(options);
  let f = fmtCache.get(key);
  if (!f) fmtCache.set(key, (f = new Intl.DateTimeFormat('fr-FR', options)));
  return f.format(typeof d === 'string' ? parseISODate(d) : d);
}

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function relativeDay(iso: string): string {
  const n = daysBetween(today(), iso);
  if (n === 0) return "Aujourd'hui";
  if (n === 1) return 'Demain';
  if (n === -1) return 'Hier';
  return capitalize(fmt(iso, { weekday: 'long', day: 'numeric', month: 'long' }));
}

/** Prochaine occurrence (aujourd'hui inclus) d'une date annuelle. */
export function nextAnnual(month: number, day: number): string {
  const now = new Date();
  const y = now.getFullYear();
  const candidate = (year: number) => {
    // 29 février : le 28 les années non bissextiles
    const last = new Date(year, month, 0).getDate();
    return toISODate(new Date(year, month - 1, Math.min(day, last)));
  };
  const thisYear = candidate(y);
  return thisYear >= today() ? thisYear : candidate(y + 1);
}

export function timeOf(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
