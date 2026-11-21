/**
 * Calcul des rappels d'un membre pour les 14 prochains jours (fonction pure).
 *
 * Principes :
 *  - on ne prévient que les personnes concernées (membres d'un événement, personne assignée…) ;
 *  - les rappels « à l'heure précise » (rendez-vous, tâche avec horaire) passent toujours ;
 *  - les autres (anniversaires, repas, résumé…) respectent les heures calmes et sont décalés au réveil ;
 *  - chaque rappel a une étiquette (tag) : une nouvelle version remplace l'ancienne au lieu de s'empiler.
 */
import { addDays, fmt, parseISODate, toISODate } from '../dates';
import { occursOn, type Repeat, type TaskRepeat } from './recurrence';

export type NotifPrefs = {
  events: boolean;
  /** Délai par défaut avant un rendez-vous, en minutes. */
  eventLead: number;
  /** Heure du rappel des événements « toute la journée ». */
  allDayHour: string;
  /** Résumé du matin (heure) ou null. */
  digest: string | null;
  birthdays: boolean;
  birthdayLeadDays: number;
  tasks: boolean;
  taskHour: string;
  meals: boolean;
  mealsPrepHour: string;
  weeklyPlanning: boolean;
  messages: boolean;
  lists: boolean;
  photos: boolean;
  calendarChanges: boolean;
  quietStart: string;
  quietEnd: string;
};

export const DEFAULT_PREFS: NotifPrefs = {
  events: true,
  eventLead: 30,
  allDayHour: '08:00',
  digest: '07:30',
  birthdays: true,
  birthdayLeadDays: 7,
  tasks: true,
  taskHour: '09:00',
  meals: true,
  mealsPrepHour: '18:00',
  weeklyPlanning: true,
  messages: true,
  lists: true,
  photos: true,
  calendarChanges: true,
  quietStart: '21:30',
  quietEnd: '07:30',
};

export type Reminder = {
  at: number;
  kind: 'event' | 'digest' | 'birthday' | 'task' | 'meal' | 'planning';
  title: string;
  body: string;
  tag: string;
  url: string;
  urgent: boolean;
};

export type ReminderData = {
  events: { id: string; title: string; date: string; endDate?: string; allDay: boolean; start?: string; repeat?: Repeat; memberIds: string[]; reminder?: number | null }[];
  birthdays: { id: string; name: string; day: number; month: number; year?: number | null; notes?: string }[];
  tasks: { id: string; title: string; due: string; time?: string; repeat: TaskRepeat; done?: boolean; assigneeId?: string | null }[];
  meals: { date: string; slot: 'lunch' | 'dinner'; title: string }[];
};

const HORIZON_DAYS = 14;
const MAX_ITEMS = 150;

function at(iso: string, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  const d = parseISODate(iso);
  d.setHours(h || 0, m || 0, 0, 0);
  return d.getTime();
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

/** Décale un horaire tombant dans les heures calmes à la fin de celles-ci. */
export function outOfQuietHours(ts: number, prefs: Pick<NotifPrefs, 'quietStart' | 'quietEnd'>): number {
  const s = minutes(prefs.quietStart);
  const e = minutes(prefs.quietEnd);
  if (s === e) return ts;
  const d = new Date(ts);
  const cur = d.getHours() * 60 + d.getMinutes();
  const inQuiet = s < e ? cur >= s && cur < e : cur >= s || cur < e;
  if (!inQuiet) return ts;
  const end = new Date(d);
  end.setHours(Math.floor(e / 60), e % 60, 0, 0);
  if (end.getTime() <= ts) end.setDate(end.getDate() + 1);
  return end.getTime();
}

const involves = (memberIds: string[] | undefined, memberId: string) => !memberIds?.length || memberIds.includes(memberId);
const SLOT = { lunch: 'midi', dinner: 'soir' } as const;

export function computeReminders(data: ReminderData, memberId: string, prefs: NotifPrefs, now = Date.now()): Reminder[] {
  const out: Reminder[] = [];
  const start = new Date(now);
  const days = Array.from({ length: HORIZON_DAYS + 1 }, (_, i) => toISODate(addDays(start, i)));
  const push = (r: Reminder) => {
    const when = r.urgent ? r.at : outOfQuietHours(r.at, prefs);
    if (when > now) out.push({ ...r, at: when });
  };
  const dayLabel = (iso: string) => fmt(iso, { weekday: 'long', day: 'numeric', month: 'long' });

  // Rendez-vous
  if (prefs.events) {
    for (const ev of data.events) {
      if (!involves(ev.memberIds, memberId)) continue;
      const lead = ev.reminder === undefined || ev.reminder === -1 ? prefs.eventLead : ev.reminder;
      if (lead === null || lead < 0) continue;
      for (const d of days) {
        if (!occursOn(ev, d)) continue;
        if (ev.allDay || !ev.start) {
          if (ev.endDate && d !== ev.date && (ev.repeat ?? 'none') === 'none') continue; // une seule fois pour plusieurs jours
          push({ at: at(d, prefs.allDayHour), kind: 'event', title: ev.title, body: "Aujourd'hui", tag: `ev-${ev.id}-${d}`, url: '#/m/calendar', urgent: false });
        } else {
          const startTs = at(d, ev.start);
          const body = lead === 0 ? `Maintenant (${ev.start})` : lead >= 1440 ? `${dayLabel(d)} à ${ev.start}` : `À ${ev.start} · dans ${lead >= 60 ? `${lead / 60} h` : `${lead} min`}`;
          push({ at: startTs - lead * 60_000, kind: 'event', title: ev.title, body, tag: `ev-${ev.id}-${d}`, url: '#/m/calendar', urgent: true });
        }
      }
    }
  }

  // Anniversaires (pour tout le monde)
  if (prefs.birthdays) {
    for (const b of data.birthdays) {
      for (const d of days) {
        const date = parseISODate(d);
        if (date.getMonth() + 1 !== b.month || date.getDate() !== b.day) continue;
        const age = b.year ? date.getFullYear() - b.year : null;
        push({
          at: at(d, '08:00'),
          kind: 'birthday',
          title: `🎂 Anniversaire de ${b.name}`,
          body: age ? `${b.name} fête ses ${age} ans aujourd'hui !` : "C'est aujourd'hui !",
          tag: `bd-${b.id}`,
          url: '#/m/birthdays',
          urgent: false,
        });
        if (prefs.birthdayLeadDays > 0) {
          const before = toISODate(addDays(date, -prefs.birthdayLeadDays));
          push({
            at: at(before, '09:00'),
            kind: 'birthday',
            title: `🎁 Anniversaire de ${b.name} dans ${prefs.birthdayLeadDays} jour${prefs.birthdayLeadDays > 1 ? 's' : ''}`,
            body: b.notes ? `Idées : ${b.notes}` : 'Pensez au cadeau !',
            tag: `bd-${b.id}-soon`,
            url: '#/m/birthdays',
            urgent: false,
          });
        }
      }
    }
  }

  // Tâches
  if (prefs.tasks) {
    const todayIso = days[0];
    for (const t of data.tasks) {
      if (t.done) continue;
      if (t.assigneeId && t.assigneeId !== memberId) continue;
      if (t.due >= todayIso) {
        if (t.due > days[days.length - 1]) continue;
        push({ at: at(t.due, t.time || prefs.taskHour), kind: 'task', title: t.title, body: t.time ? `À faire à ${t.time}` : "À faire aujourd'hui", tag: `task-${t.id}`, url: '#/m/tasks', urgent: !!t.time });
      } else {
        // En retard : un seul rappel, au prochain créneau habituel.
        let when = at(todayIso, prefs.taskHour);
        if (when <= now) when = at(days[1], prefs.taskHour);
        push({ at: when, kind: 'task', title: `En retard : ${t.title}`, body: `Prévu ${dayLabel(t.due)}`, tag: `task-${t.id}`, url: '#/m/tasks', urgent: false });
      }
    }
  }

  // Repas : la veille, pour anticiper (courses, décongélation…)
  if (prefs.meals) {
    for (const d of days.slice(1)) {
      const meals = data.meals.filter((m) => m.date === d).sort((a, b) => a.slot.localeCompare(b.slot)).reverse();
      if (!meals.length) continue;
      const prev = toISODate(addDays(parseISODate(d), -1));
      push({
        at: at(prev, prefs.mealsPrepHour),
        kind: 'meal',
        title: '🍽️ Au menu demain',
        body: meals.map((m) => `${SLOT[m.slot]} : ${m.title}`).join(' · '),
        tag: `meal-${d}`,
        url: '#/m/meals',
        urgent: false,
      });
    }
  }

  // Planning de la semaine : le dimanche à 17 h si la semaine suivante est presque vide
  if (prefs.weeklyPlanning) {
    for (const d of days) {
      if (parseISODate(d).getDay() !== 0) continue;
      const next = Array.from({ length: 7 }, (_, i) => toISODate(addDays(parseISODate(d), i + 1)));
      if (data.meals.filter((m) => next.includes(m.date)).length >= 3) continue;
      push({ at: at(d, '17:00'), kind: 'planning', title: '🗓️ Repas de la semaine', body: 'Le planning de la semaine prochaine est presque vide. On s’y met ?', tag: 'planning', url: '#/m/meals', urgent: false });
    }
  }

  // Résumé du matin
  if (prefs.digest) {
    for (const d of days) {
      const parts: string[] = [];
      const evs = data.events.filter((e) => involves(e.memberIds, memberId) && occursOn(e, d));
      if (evs.length) parts.push(evs.length === 1 ? `📅 ${evs[0].title}${evs[0].start && !evs[0].allDay ? ` à ${evs[0].start}` : ''}` : `📅 ${evs.length} événements`);
      const tasks = data.tasks.filter((t) => !t.done && t.due <= d && (!t.assigneeId || t.assigneeId === memberId));
      if (d === days[0] ? tasks.length : tasks.filter((t) => t.due === d).length) {
        const n = d === days[0] ? tasks.length : tasks.filter((t) => t.due === d).length;
        parts.push(`✅ ${n} tâche${n > 1 ? 's' : ''}`);
      }
      const date = parseISODate(d);
      for (const b of data.birthdays) if (b.month === date.getMonth() + 1 && b.day === date.getDate()) parts.push(`🎂 ${b.name}`);
      const meals = data.meals.filter((m) => m.date === d);
      if (meals.length) parts.push(`🍽️ ${meals.map((m) => m.title).join(', ')}`);
      if (!parts.length) continue;
      push({ at: at(d, prefs.digest), kind: 'digest', title: `Votre journée · ${fmt(d, { weekday: 'long', day: 'numeric' })}`, body: parts.join(' · '), tag: 'digest', url: '#/', urgent: false });
    }
  }

  return out.sort((a, b) => a.at - b.at).slice(0, MAX_ITEMS);
}
