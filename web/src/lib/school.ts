/**
 * Espace école : logique pure (testée), sans dépendance à l'interface.
 *
 *  - Emploi du temps hebdomadaire, avec semaines A/B.
 *  - Planification « au fil de l'eau » : chaque devoir est découpé en courtes séances
 *    (20 min par défaut) réparties AVANT l'échéance, en respectant une charge maximale par jour.
 *    Les devoirs sont commencés tôt, les exposés étalés, et les contrôles révisés de façon
 *    espacée (J-1, J-3, J-6…) : on retient mieux en révisant plusieurs fois que la veille.
 *  - Leçons en questions/réponses, apprises par répétition espacée (boîtes de Leitner) :
 *    une ou deux petites questions par jour en notification, priorité aux leçons du prochain contrôle.
 *  - Rappels de l'enfant, et copie facultative aux parents (éventuellement « seulement si pas fait »).
 */
import { addDays, fmt, parseISODate, toISODate } from '../dates';

export type HomeworkKind = 'devoir' | 'controle' | 'lecon' | 'expose' | 'prevoir';

export const KIND_LABEL: Record<HomeworkKind, string> = {
  devoir: 'Devoir',
  controle: 'Contrôle',
  lecon: 'Leçon à apprendre',
  expose: 'Exposé / projet',
  prevoir: 'À prévoir',
};
export const KIND_EMOJI: Record<HomeworkKind, string> = { devoir: '✏️', controle: '📝', lecon: '📖', expose: '🎤', prevoir: '🎒' };

/** Temps de travail total estimé par défaut (minutes). */
export const EFFORT_DEFAULT: Record<HomeworkKind, number> = { devoir: 20, controle: 60, lecon: 20, expose: 120, prevoir: 0 };

export type Homework = {
  childId: string;
  kind: HomeworkKind;
  subject: string;
  title: string;
  due: string; // AAAA-MM-JJ : jour où c'est à rendre / jour du contrôle
  effort?: number; // minutes de travail estimées
  log?: Record<string, number>; // minutes de travail faites, par jour
  done?: boolean;
  notes?: string;
  lessonIds?: string[]; // leçons à réviser pour un contrôle
};

export type Slot = {
  childId: string;
  day: number; // 0 = dimanche … 6 = samedi (comme Date.getDay)
  start: string;
  end: string;
  subject: string;
  room?: string;
  weeks?: 'all' | 'A' | 'B';
};

export type Lesson = { childId: string; subject: string; title: string };
export type Card = { childId: string; lessonId?: string; subject: string; question: string; answer: string; box: number; due: string };

export type CopyKind = 'sessions' | 'bag' | 'quiz';
export type SchoolProfile = {
  grade?: string;
  /** Durée d'une séance (minutes) : courte pour rester concentré. */
  sessionMinutes: number;
  /** Heure de travail les jours d'école, et le mercredi/week-end. */
  studyTime: string;
  freeDayTime: string;
  /** Minutes de travail maximum par jour (indice = Date.getDay). */
  capacity: number[];
  /** Rappel « cartable » la veille (ou null). */
  bagTime: string | null;
  /** Heures possibles des petites questions, et nombre par jour. */
  quizTimes: string[];
  quizPerDay: number;
  /** Lundi d'une semaine A (si l'emploi du temps alterne A/B). */
  weekARef?: string;
  parentCopy: { enabled: boolean; parentIds: string[]; kinds: CopyKind[]; delay: number };
};

export const DEFAULT_PROFILE: SchoolProfile = {
  sessionMinutes: 20,
  studyTime: '17:30',
  freeDayTime: '10:30',
  capacity: [30, 45, 45, 60, 45, 45, 30],
  bagTime: '19:30',
  quizTimes: ['07:45', '18:45'],
  quizPerDay: 2,
  parentCopy: { enabled: true, parentIds: [], kinds: ['sessions', 'bag'], delay: 60 },
};

export const profileOf = (p?: Partial<SchoolProfile> | null): SchoolProfile => ({
  ...DEFAULT_PROFILE,
  ...(p ?? {}),
  parentCopy: { ...DEFAULT_PROFILE.parentCopy, ...(p?.parentCopy ?? {}) },
});

/* ------------------------------------------------------------------ dates & emploi du temps */

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};
const at = (iso: string, hhmm: string) => {
  const d = parseISODate(iso);
  d.setHours(0, minutesOf(hhmm), 0, 0);
  return d.getTime();
};
const plusDays = (iso: string, n: number) => toISODate(addDays(parseISODate(iso), n));
const dayDiff = (a: string, b: string) => Math.round((parseISODate(b).getTime() - parseISODate(a).getTime()) / 86_400_000);

export function weekType(iso: string, ref?: string): 'A' | 'B' | null {
  if (!ref) return null;
  const monday = (s: string) => {
    const d = parseISODate(s);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d;
  };
  const weeks = Math.round((monday(iso).getTime() - monday(ref).getTime()) / (7 * 86_400_000));
  return weeks % 2 === 0 ? 'A' : 'B';
}

export function slotsOn(slots: Slot[], childId: string, iso: string, profile: SchoolProfile): Slot[] {
  const dow = parseISODate(iso).getDay();
  const wt = weekType(iso, profile.weekARef);
  return slots
    .filter((s) => s.childId === childId && s.day === dow && (!s.weeks || s.weeks === 'all' || !wt || s.weeks === wt))
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** Prochain jour (après `fromIso`) où l'enfant a cours de cette matière. */
export function nextClassDate(slots: Slot[], childId: string, subject: string, profile: SchoolProfile, fromIso: string): string | null {
  for (let i = 1; i <= 28; i++) {
    const d = plusDays(fromIso, i);
    if (slotsOn(slots, childId, d, profile).some((s) => s.subject === subject)) return d;
  }
  return null;
}

/** Jour sans cours l'après-midi (mercredi, week-end, vacances) → autre heure de travail. */
function isFreeDay(slots: Slot[], childId: string, iso: string, profile: SchoolProfile) {
  return !slotsOn(slots, childId, iso, profile).some((s) => minutesOf(s.end) > 13 * 60);
}

export function studyTimeOn(slots: Slot[], childId: string, iso: string, profile: SchoolProfile) {
  return isFreeDay(slots, childId, iso, profile) ? profile.freeDayTime : profile.studyTime;
}

/** Jamais de notification pendant un cours : on la décale à la fin du cours. */
export function outOfClass(ts: number, slots: Slot[], childId: string, profile: SchoolProfile): number {
  const d = new Date(ts);
  const iso = toISODate(d);
  const cur = d.getHours() * 60 + d.getMinutes();
  for (const s of slotsOn(slots, childId, iso, profile)) {
    if (cur >= minutesOf(s.start) && cur < minutesOf(s.end)) return outOfClass(at(iso, s.end), slots, childId, profile);
  }
  return ts;
}

/* ------------------------------------------------------------------ planification */

/** Après cette heure, on ne propose plus de travail pour le jour même. */
export const cutoffOf = (slots: Slot[], childId: string, iso: string, profile: SchoolProfile) =>
  Math.max(minutesOf(studyTimeOn(slots, childId, iso, profile)) + 60, 19 * 60 + 30);

export type Session = { hwId: string; date: string; minutes: number; late?: boolean };

export const progressOf = (h: Homework) => Object.values(h.log ?? {}).reduce((a, b) => a + b, 0);
export const effortOf = (h: Homework) => h.effort ?? EFFORT_DEFAULT[h.kind];

/**
 * Répartit le travail restant de chaque devoir en séances, du jour de départ à la veille de l'échéance.
 * Les échéances les plus proches sont planifiées d'abord ; chaque jour a une charge maximale.
 */
export function planSessions(
  homework: (Homework & { id: string })[],
  childId: string,
  slots: Slot[],
  profile: SchoolProfile,
  today: string,
  nowMinutes: number,
): Session[] {
  const tomorrow = plusDays(today, 1);
  const start = nowMinutes < cutoffOf(slots, childId, today, profile) ? today : tomorrow;
  const load = new Map<string, number>();
  const out: Session[] = [];
  const len = Math.max(5, profile.sessionMinutes);

  const items = homework
    .filter((h) => h.childId === childId && !h.done && h.kind !== 'prevoir' && h.due > today)
    .sort((a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id));

  for (const h of items) {
    const remaining = effortOf(h) - progressOf(h);
    if (remaining <= 0) continue;
    const first = (h.log?.[today] ?? 0) > 0 ? tomorrow : start;
    const last = plusDays(h.due, -1);
    const n = Math.ceil(remaining / len);
    const sizes = Array.from({ length: n }, (_, i) => (i < n - 1 ? len : remaining - len * (n - 1)));

    if (last < first) {
      // Pour demain et pas encore fait : tout aujourd'hui, en signalant le retard.
      if ((h.log?.[today] ?? 0) === 0 && h.due === tomorrow) out.push({ hwId: h.id, date: today, minutes: remaining, late: true });
      continue;
    }
    const span = dayDiff(first, last);
    const days = Array.from({ length: span + 1 }, (_, i) => plusDays(first, i));

    // Jours « idéaux » selon le type de travail.
    const targets = sizes.map((_, i) => {
      if (h.kind === 'controle') return plusDays(h.due, -[1, 3, 6, 10, 15, 21][Math.min(i, 5)]); // révisions espacées
      if (h.kind === 'lecon') return i === 0 ? first : i === 1 ? last : plusDays(first, Math.round((i * span) / n)); // apprendre tôt, revoir la veille
      if (h.kind === 'expose') return plusDays(first, Math.floor((i * (span + 1)) / n)); // étalé régulièrement
      return plusDays(first, i); // devoir : le plus tôt possible
    });

    const used = new Set<string>();
    sizes.forEach((size, i) => {
      const cap = (d: string) => profile.capacity[parseISODate(d).getDay()] ?? 45;
      const fits = (d: string) => !used.has(d) && (load.get(d) ?? 0) + size <= cap(d);
      const candidates = days.filter(fits).sort((a, b) => {
        const da = Math.abs(dayDiff(targets[i], a));
        const db = Math.abs(dayDiff(targets[i], b));
        return da - db || a.localeCompare(b);
      });
      let day = candidates[0];
      let late = false;
      if (!day) {
        // Pas assez de jours : plusieurs séances le même jour si la charge le permet.
        day = days.filter((d) => (load.get(d) ?? 0) + size <= cap(d)).sort((a, b) => b.localeCompare(a))[0];
      }
      if (!day) {
        // Plus de place : on charge le jour le moins rempli et on le signale.
        day = [...days].sort((a, b) => (load.get(a) ?? 0) - (load.get(b) ?? 0) || a.localeCompare(b))[0];
        late = true;
      }
      used.add(day);
      load.set(day, (load.get(day) ?? 0) + size);
      out.push({ hwId: h.id, date: day, minutes: size, ...(late ? { late } : {}) });
    });
  }
  // Un même travail planifié deux fois le même jour = une seule séance plus longue.
  const merged = new Map<string, Session>();
  for (const x of out) {
    const k = `${x.date}|${x.hwId}`;
    const cur = merged.get(k);
    if (cur) {
      cur.minutes += x.minutes;
      if (x.late) cur.late = true;
    } else merged.set(k, { ...x });
  }
  return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date) || a.hwId.localeCompare(b.hwId));
}

/* ------------------------------------------------------------------ répétition espacée */

/** Intervalle (jours) avant la prochaine question selon la boîte de Leitner (1 à 5). */
export const LEITNER_DAYS = [0, 1, 2, 4, 8, 16];

export function answerCard(card: Pick<Card, 'box'>, knew: boolean, today: string): { box: number; due: string } {
  const box = knew ? Math.min(5, (card.box || 1) + 1) : 1;
  return { box, due: plusDays(today, knew ? LEITNER_DAYS[box] : 1) };
}

/** Questions à poser pour un contrôle proche (5 jours) : ses leçons, ou à défaut sa matière. */
function boosted(card: Card & { id: string }, homework: Homework[], day: string) {
  return homework.some(
    (h) =>
      h.kind === 'controle' &&
      !h.done &&
      h.childId === card.childId &&
      h.due > day &&
      dayDiff(day, h.due) <= 5 &&
      (h.lessonIds?.length ? !!card.lessonId && h.lessonIds.includes(card.lessonId) : h.subject === card.subject),
  );
}

/** Cartes à réviser maintenant (écran « Réviser »). */
export function dueCards<C extends Card & { id: string }>(cards: C[], homework: Homework[], childId: string, today: string): C[] {
  return cards
    .filter((c) => c.childId === childId && (c.due <= today || boosted(c, homework, today)))
    .sort((a, b) => Number(boosted(b, homework, today)) - Number(boosted(a, homework, today)) || a.box - b.box || a.due.localeCompare(b.due));
}

/** Choisit les questions envoyées en notification, jour par jour, en simulant les révisions. */
export function planQuiz(
  cards: (Card & { id: string })[],
  homework: Homework[],
  childId: string,
  days: string[],
  perDay: number,
): { date: string; card: Card & { id: string } }[] {
  const state = new Map(cards.filter((c) => c.childId === childId).map((c) => [c.id, { ...c }]));
  const out: { date: string; card: Card & { id: string } }[] = [];
  for (const day of days) {
    const picks = dueCards([...state.values()], homework, childId, day).slice(0, perDay);
    for (const c of picks) {
      out.push({ date: day, card: cards.find((x) => x.id === c.id)! });
      Object.assign(c, answerCard(c, true, day)); // hypothèse : bonne réponse (recalculé après chaque réponse réelle)
    }
  }
  return out;
}

/** « question = réponse » par ligne → cartes. */
export function parseCards(text: string): { question: string; answer: string }[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^(.+?)\s*(?:=|→|->|:)\s*(.+)$/);
      return m ? { question: m[1].trim(), answer: m[2].trim() } : null;
    })
    .filter((x): x is { question: string; answer: string } => !!x);
}

/* ------------------------------------------------------------------ rappels */

export type SchoolData = {
  members: { id: string; name: string; kind?: string }[];
  profiles: (Partial<SchoolProfile> & { id: string })[];
  slots: Slot[];
  homework: (Homework & { id: string })[];
  cards: (Card & { id: string })[];
};

export type SchoolReminder = {
  at: number;
  kind: 'school' | 'bag' | 'quiz';
  title: string;
  body: string;
  tag: string;
  url: string;
  answer?: string;
  /** Copie destinée à un parent. */
  copy?: boolean;
};

const HORIZON = 14;

export function computeSchoolReminders(data: SchoolData, memberId: string, now = Date.now()): SchoolReminder[] {
  const out: SchoolReminder[] = [];
  const today = toISODate(new Date(now));
  const nowMin = new Date(now).getHours() * 60 + new Date(now).getMinutes();
  const days = Array.from({ length: HORIZON }, (_, i) => plusDays(today, i));

  for (const child of data.members.filter((m) => m.kind === 'child')) {
    const profile = profileOf(data.profiles.find((p) => p.id === child.id));
    const self = child.id === memberId;
    // Sans parent choisi : tous les adultes de la famille reçoivent la copie.
    const parents = profile.parentCopy.parentIds.length
      ? profile.parentCopy.parentIds
      : data.members.filter((m) => m.kind !== 'child').map((m) => m.id);
    const copy = !self && profile.parentCopy.enabled && parents.includes(memberId);
    if (!self && !copy) continue;
    const wants = (k: CopyKind) => self || profile.parentCopy.kinds.includes(k);
    const prefix = self ? '' : `${child.name} · `;
    const hw = data.homework.filter((h) => h.childId === child.id);
    const byId = new Map(hw.map((h) => [h.id, h]));
    const place = (ts: number) => outOfClass(ts, data.slots, child.id, profile);
    const push = (r: SchoolReminder) => {
      if (r.at > now) out.push(self ? r : { ...r, copy: true });
    };

    // 1. Séances de travail du jour
    if (wants('sessions')) {
      const sessions = planSessions(hw, child.id, data.slots, profile, today, nowMin);
      for (const d of days) {
        const list = sessions.filter((s) => s.date === d);
        if (!list.length) continue;
        const total = list.reduce((a, s) => a + s.minutes, 0);
        const parts = list.map((s) => {
          const h = byId.get(s.hwId)!;
          const when = dayDiff(d, h.due) === 1 ? 'pour demain' : `pour ${fmt(h.due, { weekday: 'long' })}`;
          return `${KIND_EMOJI[h.kind]} ${h.subject} : ${h.title} (${s.minutes} min, ${h.kind === 'controle' ? `contrôle ${when.replace('pour ', '')}` : when})`;
        });
        const late = list.some((s) => s.late);
        const delay = self ? 0 : profile.parentCopy.delay;
        let when = place(at(d, studyTimeOn(data.slots, child.id, d, profile)));
        // Travail ajouté après l'heure habituelle : rappel dans 30 min (si ce n'est pas trop tard).
        if (d === today && when <= now && nowMin + 30 < cutoffOf(data.slots, child.id, d, profile)) when = place(now + 30 * 60_000);
        push({
          at: when + delay * 60_000,
          kind: 'school',
          title: `${prefix}${late ? '⏰ ' : '📚 '}${total} min de travail ${d === today ? "aujourd'hui" : fmt(d, { weekday: 'long' })}`,
          body: parts.join(' · ') + (delay ? ' — pas encore noté comme fait' : ''),
          tag: `${self ? 'sch' : 'schp'}-${child.id}-${d}`,
          url: `#/m/school/${child.id}`,
        });
      }
    }

    // 2. Cartable de la veille : cours du lendemain, contrôles, choses à prévoir
    if (wants('bag') && profile.bagTime) {
      for (const d of days) {
        const tomorrow = plusDays(d, 1);
        const classes = [...new Set(slotsOn(data.slots, child.id, tomorrow, profile).map((s) => s.subject))];
        const due = hw.filter((h) => h.due === tomorrow && !h.done);
        if (!classes.length && !due.length) continue;
        const parts: string[] = [];
        if (classes.length) parts.push(classes.join(', '));
        for (const h of due) parts.push(`${KIND_EMOJI[h.kind]} ${h.kind === 'prevoir' ? h.title : `${KIND_LABEL[h.kind]} de ${h.subject}`}`);
        push({
          at: place(at(d, profile.bagTime)),
          kind: 'bag',
          title: `${prefix}🎒 Cartable pour ${fmt(tomorrow, { weekday: 'long' })}`,
          body: parts.join(' · '),
          tag: `bag-${child.id}-${d}`,
          url: `#/m/school/${child.id}`,
        });
      }
    }

    // 3. Petites questions (répétition espacée)
    if (wants('quiz') && profile.quizPerDay > 0 && profile.quizTimes.length) {
      const perDay = Math.min(profile.quizPerDay, profile.quizTimes.length);
      const quiz = planQuiz(data.cards, hw, child.id, days, perDay);
      const count = new Map<string, number>();
      for (const q of quiz) {
        const i = count.get(q.date) ?? 0;
        count.set(q.date, i + 1);
        push({
          at: place(at(q.date, profile.quizTimes[i])),
          kind: 'quiz',
          title: `${prefix}🧠 Question de ${q.card.subject}`,
          body: q.card.question,
          answer: q.card.answer,
          tag: `quiz-${child.id}-${q.date}-${i}`,
          url: `#/m/school/${child.id}/quiz/${q.card.id}`,
        });
      }
    }
  }
  return out;
}
