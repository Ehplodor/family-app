/**
 * Calendriers supplémentaires affichés dans l'agenda : jours fériés et vacances scolaires
 * (calculés ou embarqués dans l'appli, sans aucun accès réseau), et calendriers importés
 * au format iCalendar (.ics : Google Agenda, Outlook, iCloud, clubs de sport…).
 * Fonctions pures, testées dans calendars.test.ts.
 */
import { addDays, pad, parseISODate, toISODate } from '../dates';
import { occursOn, type Repeat } from './recurrence';

/** Événement importé, en format compact (il est stocké, chiffré, dans les données de la famille). */
export type IcsEvent = {
  t: string; // titre
  d: string; // AAAA-MM-JJ
  e?: string; // dernier jour (inclus) si plusieurs jours
  s?: string; // HH:MM (absent = toute la journée)
  f?: string; // HH:MM de fin
  r?: Repeat;
};

/** Un calendrier importé (collection partagée « calendars »). */
export type ImportedCalendar = {
  name: string;
  color: string;
  /** Adresse d'abonnement (rafraîchie automatiquement). Absente = fichier importé une fois. */
  url?: string;
  events: IcsEvent[];
  fetchedAt?: string; // ISO
  error?: string;
};

export type DayItem = { title: string; time?: string; key: string };

/* ------------------------------------------------------------------ Jours fériés (France) */

/** Dimanche de Pâques (algorithme de Meeus/Jones/Butcher). */
export function easter(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${pad(month)}-${pad(day)}`;
}

const holidayCache = new Map<number, Map<string, string>>();

/** Jours fériés de métropole pour une année : date → nom. */
export function frenchHolidays(year: number): Map<string, string> {
  let m = holidayCache.get(year);
  if (m) return m;
  const e = parseISODate(easter(year));
  const rel = (n: number) => toISODate(addDays(e, n));
  m = new Map([
    [`${year}-01-01`, "Jour de l'an"],
    [rel(1), 'Lundi de Pâques'],
    [`${year}-05-01`, 'Fête du Travail'],
    [`${year}-05-08`, 'Victoire 1945'],
    [rel(39), 'Ascension'],
    [rel(50), 'Lundi de Pentecôte'],
    [`${year}-07-14`, 'Fête nationale'],
    [`${year}-08-15`, 'Assomption'],
    [`${year}-11-01`, 'Toussaint'],
    [`${year}-11-11`, 'Armistice 1918'],
    [`${year}-12-25`, 'Noël'],
  ]);
  holidayCache.set(year, m);
  return m;
}

export function holidayOn(iso: string): string | undefined {
  return frenchHolidays(Number(iso.slice(0, 4))).get(iso);
}

/* ------------------------------------------------------------------ Vacances scolaires (France) */

export type Zone = 'A' | 'B' | 'C';

/**
 * Source : data.education.gouv.fr (« Calendrier scolaire »), métropole. Dates = premier et dernier
 * jour sans classe (la reprise est le lendemain). À compléter chaque année quand le ministère publie
 * le calendrier suivant.
 */
const SCHOOL: [title: string, zones: string, first: string, last: string][] = [
  ['Vacances de la Toussaint', 'ABC', '2025-10-18', '2025-11-02'],
  ['Vacances de Noël', 'ABC', '2025-12-20', '2026-01-04'],
  ["Vacances d'hiver", 'A', '2026-02-07', '2026-02-22'],
  ["Vacances d'hiver", 'B', '2026-02-14', '2026-03-01'],
  ["Vacances d'hiver", 'C', '2026-02-21', '2026-03-08'],
  ['Vacances de printemps', 'A', '2026-04-04', '2026-04-19'],
  ['Vacances de printemps', 'B', '2026-04-11', '2026-04-26'],
  ['Vacances de printemps', 'C', '2026-04-18', '2026-05-03'],
  ["Pont de l'Ascension", 'ABC', '2026-05-14', '2026-05-17'],
  ["Vacances d'été", 'ABC', '2026-07-04', '2026-08-31'],
  ['Vacances de la Toussaint', 'ABC', '2026-10-17', '2026-11-01'],
  ['Vacances de Noël', 'ABC', '2026-12-19', '2027-01-03'],
  ["Vacances d'hiver", 'C', '2027-02-06', '2027-02-21'],
  ["Vacances d'hiver", 'A', '2027-02-13', '2027-02-28'],
  ["Vacances d'hiver", 'B', '2027-02-20', '2027-03-07'],
  ['Vacances de printemps', 'C', '2027-04-03', '2027-04-18'],
  ['Vacances de printemps', 'A', '2027-04-10', '2027-04-25'],
  ['Vacances de printemps', 'B', '2027-04-17', '2027-05-02'],
  ["Pont de l'Ascension", 'ABC', '2027-05-07', '2027-05-07'],
  ["Vacances d'été", 'ABC', '2027-07-03', '2027-09-01'],
  ['Vacances de la Toussaint', 'ABC', '2027-10-23', '2027-11-07'],
  ['Vacances de Noël', 'ABC', '2027-12-18', '2028-01-02'],
  ["Vacances d'hiver", 'B', '2028-02-05', '2028-02-20'],
  ["Vacances d'hiver", 'C', '2028-02-12', '2028-02-27'],
  ["Vacances d'hiver", 'A', '2028-02-19', '2028-03-05'],
  ['Vacances de printemps', 'B', '2028-04-08', '2028-04-23'],
  ['Vacances de printemps', 'C', '2028-04-15', '2028-05-01'],
  ['Vacances de printemps', 'A', '2028-04-22', '2028-05-08'],
  ["Pont de l'Ascension", 'ABC', '2028-05-25', '2028-05-28'],
  ["Début des vacances d'été", 'ABC', '2028-07-04', '2028-07-04'],
];

export function schoolHolidayOn(iso: string, zone: Zone): string | undefined {
  return SCHOOL.find(([, z, first, last]) => z.includes(zone) && first <= iso && iso <= last)?.[0];
}

/** Dernier jour couvert par les données embarquées (pour prévenir quand il faut les compléter). */
export const SCHOOL_DATA_UNTIL = SCHOOL[SCHOOL.length - 1][3];

/* ------------------------------------------------------------------ Calendriers importés */

export function icsEventsOn(events: IcsEvent[], iso: string): IcsEvent[] {
  return events
    .filter((ev) => occursOn({ date: ev.d, endDate: ev.e, repeat: ev.r }, iso))
    .sort((a, b) => (a.s ?? '').localeCompare(b.s ?? ''));
}

export function icsTime(ev: IcsEvent, iso: string): string | undefined {
  if (!ev.s) return undefined;
  // Événement sur plusieurs jours : l'heure de début le premier jour, de fin le dernier.
  if (ev.e && ev.e > ev.d) {
    if (iso === ev.d) return `dès ${ev.s}`;
    if (iso === ev.e) return ev.f ? `→ ${ev.f}` : undefined;
    return undefined;
  }
  return [ev.s, ev.f].filter(Boolean).join(' – ');
}

/* ------------------------------------------------------------------ Lecture d'un fichier .ics */

const MAX_EVENTS = 2000;
const MAX_TITLE = 150;
/**
 * Taille maximale des événements d'un calendrier une fois écrits (≈ 200 Ko). Au-delà, le paquet chiffré
 * dépasserait la limite du relais (512 Ko) et bloquerait la synchronisation de toute la famille.
 */
export const MAX_CALENDAR_BYTES = 200_000;

/** Garde les événements les plus proches d'aujourd'hui tant que la taille totale reste raisonnable. */
function fitBudget(events: IcsEvent[], todayIso: string): IcsEvent[] {
  const today = parseISODate(todayIso).getTime();
  const dist = (ev: IcsEvent) => Math.abs(parseISODate(ev.d).getTime() - today);
  const kept: IcsEvent[] = [];
  let size = 2;
  for (const ev of [...events].sort((a, b) => dist(a) - dist(b))) {
    const n = JSON.stringify(ev).length + 1;
    if (kept.length >= MAX_EVENTS || size + n > MAX_CALENDAR_BYTES) break;
    kept.push(ev);
    size += n;
  }
  return kept.sort((a, b) => a.d.localeCompare(b.d));
}

function unescapeText(s: string) {
  return s.replace(/\\([\\,;nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? ' ' : c)).trim();
}

type Stamp = { date: string; time?: string };

/**
 * Lit une date iCalendar. Les heures en UTC (suffixe Z) sont converties en heure locale de l'appareil ;
 * les heures avec un fuseau (TZID) sont prises telles quelles (exact tant que le calendrier est dans
 * le même fuseau que la famille, ce qui est le cas courant).
 */
function parseStamp(value: string, params: string): Stamp | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, , z] = m;
  if (h === undefined || /VALUE=DATE(?!-)/.test(params)) return { date: `${y}-${mo}-${d}` };
  if (z) {
    const local = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
    return { date: toISODate(local), time: `${pad(local.getHours())}:${pad(local.getMinutes())}` };
  }
  return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}` };
}

function rruleParts(rule: string): Record<string, string> {
  return Object.fromEntries(
    rule.split(';').map((p) => {
      const [k, v = ''] = p.split('=');
      return [k.toUpperCase(), v];
    }),
  );
}

function step(iso: string, freq: string, interval: number): string {
  const d = parseISODate(iso);
  if (freq === 'DAILY') return toISODate(addDays(d, interval));
  if (freq === 'WEEKLY') return toISODate(addDays(d, 7 * interval));
  if (freq === 'MONTHLY') return toISODate(new Date(d.getFullYear(), d.getMonth() + interval, d.getDate()));
  return toISODate(new Date(d.getFullYear() + interval, d.getMonth(), d.getDate()));
}

/**
 * Transforme le texte d'un fichier .ics en événements compacts.
 * Gère : journées entières, plusieurs jours, heures UTC, répétitions simples (RRULE FREQ/INTERVAL/COUNT/UNTIL).
 * Les événements trop anciens (plus d'un an) ou trop lointains (plus de deux ans) sont ignorés.
 */
export function parseIcs(text: string, todayIso: string): { name?: string; events: IcsEvent[] } {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const minIso = toISODate(addDays(parseISODate(todayIso), -366));
  const maxIso = toISODate(addDays(parseISODate(todayIso), 731));
  const events: IcsEvent[] = [];
  let name: string | undefined;
  let cur: Record<string, { v: string; p: string }> | null = null;

  const finish = (raw: Record<string, { v: string; p: string }>) => {
    if (raw.STATUS?.v.toUpperCase() === 'CANCELLED' || !raw.DTSTART) return;
    const start = parseStamp(raw.DTSTART.v, raw.DTSTART.p);
    if (!start) return;
    const end = raw.DTEND ? parseStamp(raw.DTEND.v, raw.DTEND.p) : null;
    const ev: IcsEvent = { t: unescapeText(raw.SUMMARY?.v ?? '').slice(0, MAX_TITLE) || '(sans titre)', d: start.date };
    if (start.time) {
      ev.s = start.time;
      if (end?.time) ev.f = end.time;
      if (end && end.date > start.date) ev.e = end.date;
    } else if (end && end.date > start.date) {
      // En journée entière, DTEND est exclusif : le dernier jour est la veille.
      const last = toISODate(addDays(parseISODate(end.date), -1));
      if (last > start.date) ev.e = last;
    }
    const rule = raw.RRULE ? rruleParts(raw.RRULE.v) : null;
    if (!rule) {
      if ((ev.e ?? ev.d) >= minIso && ev.d <= maxIso) events.push(ev);
      return;
    }
    const freq = rule.FREQ;
    const interval = Math.max(1, Number(rule.INTERVAL) || 1);
    const until = rule.UNTIL ? parseStamp(rule.UNTIL, '')?.date : undefined;
    const count = rule.COUNT ? Number(rule.COUNT) : undefined;
    const simple: Record<string, Repeat> = { WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' };
    if (!until && !count && interval === 1 && simple[freq] && !ev.e) {
      events.push({ ...ev, r: simple[freq] }); // répétition sans fin : gérée par l'agenda
      return;
    }
    if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) {
      if (ev.d >= minIso && ev.d <= maxIso) events.push(ev);
      return;
    }
    // Répétition bornée (ou à intervalle) : on écrit chaque occurrence dans la fenêtre.
    const span = ev.e ? Math.round((parseISODate(ev.e).getTime() - parseISODate(ev.d).getTime()) / 86_400_000) : 0;
    let d = ev.d;
    for (let n = 0; n < 500 && (count === undefined || n < count) && (!until || d <= until) && d <= maxIso; n++) {
      if (d >= minIso) events.push({ ...ev, d, ...(span ? { e: toISODate(addDays(parseISODate(d), span)) } : {}) });
      d = step(d, freq, interval);
    }
  };

  for (const line of lines) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const head = line.slice(0, i);
    const value = line.slice(i + 1);
    const [prop, ...params] = head.split(';');
    const key = prop.toUpperCase();
    if (key === 'BEGIN' && value.toUpperCase() === 'VEVENT') cur = {};
    else if (key === 'END' && value.toUpperCase() === 'VEVENT') {
      if (cur) finish(cur);
      cur = null;
      if (events.length >= MAX_EVENTS * 2) break;
    } else if (cur) {
      if (!(key in cur)) cur[key] = { v: value, p: params.join(';').toUpperCase() };
    } else if (key === 'X-WR-CALNAME' && !name) name = unescapeText(value);
  }
  if (!name && !events.length && !/BEGIN:VCALENDAR/i.test(text)) throw new Error("Ce fichier n'est pas un calendrier (.ics)");
  return { name: name?.slice(0, MAX_TITLE), events: fitBudget(events, todayIso) };
}

/** Adresse d'abonnement acceptée : https (webcal:// est converti). */
export function normalizeIcsUrl(input: string): string | null {
  const s = input.trim().replace(/^webcals?:\/\//i, 'https://');
  try {
    const u = new URL(s);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}
