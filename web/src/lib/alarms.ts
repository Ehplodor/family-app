/**
 * Réveils et alarmes (fonctions pures, testées dans alarms.test.ts).
 *
 * Un réveil appartient à un membre ET à un appareil : il ne sonne que sur cet appareil.
 * Il est rangé dans les données du cercle (chiffrées) pour pouvoir être transféré d'un
 * appareil à l'autre, mais l'appli ne l'affiche qu'à son propriétaire.
 */
import { addDays, pad, parseISODate, toISODate } from '../dates';

export type AlarmMode = 'simple' | 'math' | 'words';

export type Alarm = {
  memberId: string;
  /** Seul cet appareil sonne. Changer ce champ = transférer le réveil. */
  deviceId: string;
  /** Heure de sonnerie, HH:MM (heure locale de l'appareil). */
  time: string;
  /** Jours de répétition (0 = dimanche … 6 = samedi). Vide = une seule fois. */
  days: number[];
  label?: string;
  enabled: boolean;
  /** Façon d'arrêter le réveil : glisser, ou résoudre un défi. */
  mode: AlarmMode;
  /** Réveil en douceur : son qui monte progressivement et écran qui s'éclaire (« aube »). */
  gentle?: boolean;
  /** Durée de la répétition (snooze), en minutes. */
  snoozeMin?: number;
  /** Réveil « une fois » : il sonne à la première occurrence après ce moment (ms). */
  armedAt?: number;
};

export const DEFAULT_SNOOZE = 10;
export const DAY_LETTERS = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
export const MODE_LABEL: Record<AlarmMode, string> = {
  simple: 'Glisser pour arrêter',
  math: 'Calcul mental',
  words: 'Recopier des mots',
};

/** Moment (ms) de l'heure `time` le jour `iso`, en heure locale. */
export function atTime(iso: string, time: string): number {
  const [h, m] = time.split(':').map(Number);
  const d = parseISODate(iso);
  d.setHours(h || 0, m || 0, 0, 0);
  return d.getTime();
}

/** Réveil « une fois » : première occurrence de l'heure après son activation. */
function oneShotAt(a: Alarm, fallback: number): number {
  const base = a.armedAt ?? fallback;
  const at = atTime(toISODate(new Date(base)), a.time);
  return at > base ? at : atTime(toISODate(addDays(new Date(base), 1)), a.time);
}

const validTime = (t: string) => /^\d{1,2}:\d{2}$/.test(t);

/** Sonneries du réveil dans l'intervalle ]from, until]. */
export function ringsBetween(a: Alarm, from: number, until: number): number[] {
  if (!a.enabled || !validTime(a.time)) return [];
  if (!a.days.length) {
    const at = oneShotAt(a, from);
    return at > from && at <= until ? [at] : [];
  }
  const out: number[] = [];
  for (let d = new Date(from); ; d = addDays(d, 1)) {
    const at = atTime(toISODate(d), a.time);
    if (at > until) break;
    if (at > from && a.days.includes(d.getDay())) out.push(at);
  }
  return out;
}

/** Prochaine sonnerie après `from` (null s'il n'y en a pas). */
export function nextRing(a: Alarm, from: number): number | null {
  return ringsBetween(a, from, from + 8 * 86400_000)[0] ?? null;
}

/** « dans 7 h 32 min » */
export function untilLabel(at: number, now: number): string {
  const min = Math.max(1, Math.round((at - now) / 60000));
  const h = Math.floor(min / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return `dans ${d} j ${h % 24} h`;
  return h ? `dans ${h} h ${pad(min % 60)}` : `dans ${min} min`;
}

export function daysLabel(days: number[]): string {
  if (!days.length) return 'Une fois';
  const s = [...days].sort().join('');
  if (s === '0123456') return 'Tous les jours';
  if (s === '12345') return 'En semaine';
  if (s === '06') return 'Le week-end';
  const names = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
  return [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d)).map((d) => names[d]).join(', ');
}

/* ------------------------------------------------------------------ Défis */

export type Challenge = { prompt: string; answer: string };

const WORDS = [
  'soleil', 'tartine', 'girafe', 'montagne', 'chocolat', 'parapluie', 'baleine', 'citron', 'lumière', 'vélo',
  'cerise', 'nuage', 'papillon', 'trompette', 'cactus', 'pingouin', 'fusée', 'croissant', 'tortue', 'arc-en-ciel',
];

/** Fabrique une série de défis. `rnd` est injectable pour les tests. */
export function makeChallenges(mode: AlarmMode, rnd: () => number = Math.random): Challenge[] {
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  if (mode === 'math') {
    return [0, 1, 2].map((i) => {
      if (i === 2) {
        const a = int(3, 9);
        const b = int(6, 12);
        return { prompt: `${a} × ${b}`, answer: String(a * b) };
      }
      const a = int(12, 69);
      const b = int(13, 49);
      return i === 0 ? { prompt: `${a} + ${b}`, answer: String(a + b) } : { prompt: `${a + b} − ${b}`, answer: String(a) };
    });
  }
  if (mode === 'words') {
    const pick = () => WORDS[int(0, WORDS.length - 1)];
    const phrase = [pick(), pick(), pick()].join(' ');
    return [{ prompt: phrase, answer: phrase }];
  }
  return [];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
export const isRight = (c: Challenge, input: string) => norm(input) === norm(c.answer);

/** Instants des notifications d'une sonnerie : l'heure, puis des relances si personne ne répond. */
export const PUSH_FOLLOW_UPS = [0, 3, 6];

/** Pour les tests : date ISO d'un instant. */
export const isoOf = (ms: number) => toISODate(new Date(ms));
