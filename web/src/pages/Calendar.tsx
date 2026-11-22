import { useMemo, useState } from 'react';
import { Cake, ChevronLeft, ChevronRight, Layers, Lock, Search, X } from 'lucide-react';
import { useCircles, useCollection, useMembers, useVault } from '../store';
import { CirclesSheet, useDefaultGroups, VisibilityPicker } from './Circles';
import { addMonths, capitalize, fmt, parseISODate, startOfWeek, addDays, toISODate, today } from '../dates';
import { Avatar, Empty, Fab, Field, FieldGroup, MemberChips, Page, Sheet, confirmDelete } from '../ui';
import type { Doc, Member } from '../store';
import type { Birthday } from './Birthdays';
import { occursOn, spanEnd, spanPart, timeLabel, type Repeat } from '../lib/recurrence';
import { KIND_EMOJI, KIND_LABEL, type Homework } from '../lib/school';
import { holidayOn, icsEventsOn, icsTime, schoolHolidayOn, type ImportedCalendar } from '../lib/calendars';
import { CalendarsSheet, HOLIDAY_COLOR, isShown, useCalendarPrefs, useRefreshSubscriptions, VACATION_COLOR } from './Calendars';
import { visibleFor } from '../lib/calendarSearch';
import { CalendarSearch } from './CalendarSearch';

export type { Repeat };
export type CalEvent = {
  title: string;
  date: string; // AAAA-MM-JJ
  endDate?: string; // pour les événements sur plusieurs jours
  allDay: boolean;
  start?: string; // HH:MM
  end?: string;
  repeat?: Repeat;
  memberIds: string[];
  notes?: string;
  /** Minutes avant le début ; null = aucun rappel ; -1 ou absent = réglage par défaut du membre. */
  reminder?: number | null;
  /** Cercles qui voient l'évènement (portés par l'élément, voir lib/vault.ts). */
  groups?: string[];
};

/** Champs d'un évènement tels qu'ils sont enregistrés (sans la liste des cercles, portée à part). */
const EVENT_FIELDS = ['title', 'date', 'endDate', 'allDay', 'start', 'end', 'repeat', 'memberIds', 'notes', 'reminder'] as const;
function eventFields(ev: CalEvent): CalEvent {
  const out: Record<string, unknown> = {};
  for (const k of EVENT_FIELDS) if (ev[k] !== undefined) out[k] = ev[k];
  return out as CalEvent;
}

/** Cercle partagé le plus large (celui de toute la famille, en général). */
function useMainCircle(): string | undefined {
  const circles = useCircles();
  return [...circles].filter((c) => !c.personal).sort((a, b) => b.members.length - a.members.length)[0]?.id;
}

export type Occurrence = {
  key: string;
  title: string;
  time?: string;
  color: string;
  members: Member[];
  event?: Doc<CalEvent>;
  birthday?: boolean;
  /** Précision pour les événements sur plusieurs jours (« jusqu'au … »). */
  note?: string;
  /** Évènement non visible par le cercle principal (réservé à des cercles restreints). */
  private?: boolean;
};

export { occursOn };

/** Tout ce qui se passe un jour donné (événements + anniversaires), trié. */
export function useDayAgenda() {
  const events = useCollection<CalEvent>('events').docs;
  const { docs: birthdays } = useCollection<Birthday>('birthdays');
  const { docs: homework } = useCollection<Homework>('homework');
  const { docs: imported } = useCollection<ImportedCalendar>('calendars');
  const prefs = useCalendarPrefs();
  const { byId } = useMembers();
  const main = useMainCircle();
  return useMemo(
    () =>
      (iso: string): Occurrence[] => {
        const d = parseISODate(iso);
        const bdays: Occurrence[] = birthdays
          .filter((b) => b.month === d.getMonth() + 1 && b.day === d.getDate())
          .map((b) => ({
            key: `b-${b.id}`,
            title: `Anniversaire de ${b.name}${b.year ? ` (${d.getFullYear() - b.year} ans)` : ''}`,
            color: '#F2784B',
            members: [],
            birthday: true,
          }));
        const evs: Occurrence[] = events
          .filter((e) => occursOn(e, iso))
          .map((e) => ({ e, time: timeLabel(e, iso), part: spanPart(e, iso) }))
          // Journées entières (et jours pleins d'un séjour) d'abord, puis par heure.
          .sort((a, b) => (!a.time === !b.time ? (a.time ?? '').localeCompare(b.time ?? '') : !a.time ? -1 : 1))
          .map(({ e, time, part }) => {
            const members = e.memberIds.map((id) => byId(id)).filter((m): m is Member => !!m);
            const end = spanEnd(e);
            const short = (x: string) => fmt(x, { weekday: 'short', day: 'numeric', month: 'short' });
            return {
              key: e.id,
              title: e.title,
              time,
              color: members[0]?.color ?? 'var(--accent)',
              members,
              event: e,
              private: !!main && !e.groups?.includes(main),
              note: !end ? undefined : part === 'last' ? `depuis ${short(e.date)}` : `jusqu'au ${short(end)}`,
            };
          });
        const school: Occurrence[] = homework
          .filter((h) => h.due === iso && !h.done && (h.kind === 'controle' || h.kind === 'expose' || h.kind === 'prevoir'))
          .map((h) => {
            const child = byId(h.childId);
            return {
              key: `hw-${h.id}`,
              title: `${KIND_EMOJI[h.kind]} ${h.kind === 'prevoir' ? h.title : `${KIND_LABEL[h.kind]} de ${h.subject}`}${child ? ` (${child.name})` : ''}`,
              time: '🏫',
              color: child?.color ?? '#E5484D',
              members: child ? [child] : [],
            };
          });
        // Calendriers supplémentaires (fériés, vacances, imports) : discrets, en tête de journée.
        const extra: Occurrence[] = [];
        const holiday = isShown(prefs, 'holidays') ? holidayOn(iso) : undefined;
        if (holiday) extra.push({ key: `fr-${iso}`, title: `🇫🇷 ${holiday}`, time: 'Férié', color: HOLIDAY_COLOR, members: [] });
        const vacation = isShown(prefs, 'vacances') && prefs.zone ? schoolHolidayOn(iso, prefs.zone) : undefined;
        if (vacation) {
          extra.push({ key: `vac-${iso}`, title: `🏖️ ${vacation} (zone ${prefs.zone})`, color: VACATION_COLOR, members: [] });
        }
        for (const cal of imported) {
          if (!isShown(prefs, cal.id)) continue;
          icsEventsOn(cal.events ?? [], iso).forEach((ev, i) =>
            extra.push({ key: `ics-${cal.id}-${i}`, title: ev.t, time: icsTime(ev, iso), color: cal.color, members: [] }),
          );
        }
        return [
          ...extra,
          ...(isShown(prefs, 'birthdays') ? bdays : []),
          ...(isShown(prefs, 'school') ? school : []),
          ...(isShown(prefs, 'main') ? evs : []),
        ];
      },
    [events, birthdays, homework, imported, prefs, byId, main],
  );
}

export function CalendarSummary() {
  const agenda = useDayAgenda();
  const n = agenda(today()).length;
  return <>{n ? `${n} événement${n > 1 ? 's' : ''} aujourd'hui` : "Rien de prévu aujourd'hui"}</>;
}

export function AgendaList({ items, onOpen }: { items: Occurrence[]; onOpen?: (e: Doc<CalEvent>) => void }) {
  return (
    <ul className="agenda">
      {items.map((o) => (
        <li key={o.key} onClick={() => o.event && onOpen?.(o.event)} className={o.event && onOpen ? 'clickable' : ''}>
          <span className="agenda-time">{o.birthday ? <Cake size={18} /> : o.time || 'Journée'}</span>
          <span className="agenda-bar" style={{ background: o.color }} />
          <span className="grow">
            {o.private && <Lock size={13} className="muted" aria-label="Privé" />} {o.title}
            {o.note && <small className="agenda-note">{o.note}</small>}
          </span>
          <span className="avatars">
            {o.members.map((m) => (
              <Avatar key={m.id} member={m} size={24} />
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}

const MAX_LANES = 2;
const WEEKDAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

export function CalendarPage() {
  const familyEvents = useCollection<CalEvent>('events');
  const allEvents = useCollection<CalEvent>('events').docs;
  const [circles, setCircles] = useState(false);
  const fullAgenda = useDayAgenda();
  const { members } = useMembers();
  // Filtre par personne (vide = tout le monde) et recherche : propres à cet écran, non partagés.
  const [filter, setFilter] = useState<string[]>([]);
  const [searching, setSearching] = useState(false);
  const agenda = useMemo(
    () => (iso: string) => fullAgenda(iso).filter((o) => visibleFor(o.members.map((m) => m.id), filter)),
    [fullAgenda, filter],
  );
  const [selected, setSelected] = useState(today());
  const [month, setMonth] = useState(() => parseISODate(today()));
  const [editing, setEditing] = useState<Doc<CalEvent> | 'new' | null>(null);
  const [choosing, setChoosing] = useState(false);
  useRefreshSubscriptions();

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = startOfWeek(first);
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  // On retire la dernière ligne si elle est entièrement dans le mois suivant.
  const visible = days[35].getMonth() !== month.getMonth() ? days.slice(0, 35) : days;

  // Événements sur plusieurs jours : un trait fin et continu sous les dates, sur une « voie » stable.
  const lanes = useMemo(() => {
    const from = toISODate(visible[0]);
    const to = toISODate(visible[visible.length - 1]);
    const spans = allEvents
      .map((e) => ({ e, end: spanEnd(e) }))
      .filter((x): x is { e: Doc<CalEvent>; end: string } => !!x.end && x.e.date <= to && x.end >= from)
      .sort((a, b) => a.e.date.localeCompare(b.e.date) || b.end.localeCompare(a.end));
    const laneEnds: string[] = [];
    const out: { e: Doc<CalEvent>; end: string; lane: number }[] = [];
    for (const x of spans) {
      let lane = laneEnds.findIndex((end) => end < x.e.date);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = x.end;
      out.push({ ...x, lane });
    }
    return out;
  }, [allEvents, visible[0].getTime(), visible.length]);

  /** Enregistre un évènement (ses cercles sont portés par l'élément, chiffré pour chacun). */
  const save = async (editing: Doc<CalEvent> | 'new', ev: CalEvent, target: string[]) => {
    const data = { ...eventFields(ev), groups: target };
    if (editing === 'new') await familyEvents.create(data);
    else await familyEvents.update(editing.id, data);
  };
  const remove = (e: Doc<CalEvent>) => familyEvents.remove(e.id);
  const { byId } = useMembers();

  const goToday = () => {
    setSelected(today());
    setMonth(parseISODate(today()));
  };

  return (
    <Page
      title="Calendrier"
      actions={
        <>
          <button className="icon-btn compact badge-host" onClick={() => setChoosing(true)} aria-label="Calendriers affichés et cercles">
            <Layers size={22} />
          </button>
          <button
            className="icon-btn compact"
            onClick={() => setSearching((s) => !s)}
            aria-label={searching ? 'Fermer la recherche' : 'Rechercher'}
          >
            {searching ? <X /> : <Search />}
          </button>
          <button className="btn small" onClick={goToday}>
            Aujourd'hui
          </button>
        </>
      }
    >
      {members.length > 1 && (
        <div className="cal-filter">
          <MemberChips members={members} value={filter} onChange={setFilter} />
        </div>
      )}
      {searching && (
        <CalendarSearch
          filter={filter}
          onPick={(iso) => {
            setSelected(iso);
            setMonth(parseISODate(iso));
            setSearching(false);
          }}
        />
      )}
      <div className="card calendar">
        <div className="cal-head">
          <button className="icon-btn" onClick={() => setMonth(addMonths(first, -1))} aria-label="Mois précédent">
            <ChevronLeft />
          </button>
          <strong>{capitalize(fmt(first, { month: 'long', year: 'numeric' }))}</strong>
          <button className="icon-btn" onClick={() => setMonth(addMonths(first, 1))} aria-label="Mois suivant">
            <ChevronRight />
          </button>
        </div>
        <div className="cal-grid">
          {WEEKDAYS.map((d, i) => (
            <span key={i} className="cal-wd">
              {d}
            </span>
          ))}
          {visible.map((d) => {
            const iso = toISODate(d);
            const items = agenda(iso);
            const bars = lanes.filter((x) => x.lane < MAX_LANES && x.e.date <= iso && iso <= x.end);
            const shown = new Set(bars.map((x) => x.e.id));
            const dots = items.filter((o) => !o.event || !shown.has(o.event.id));
            const weekday = (d.getDay() + 6) % 7;
            const cls = [
              'cal-day',
              d.getMonth() !== month.getMonth() && 'other',
              iso === today() && 'today',
              iso === selected && 'selected',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <button key={iso} className={cls} onClick={() => setSelected(iso)}>
                <span>{d.getDate()}</span>
                <span className="dots">
                  {dots.slice(0, 3).map((o) => (
                    <i key={o.key} style={{ background: o.color }} />
                  ))}
                </span>
                <span className="spans">
                  {Array.from({ length: MAX_LANES }, (_, lane) => {
                    const x = bars.find((b) => b.lane === lane);
                    if (!x) return <i key={lane} />;
                    const color = byId(x.e.memberIds[0])?.color ?? 'var(--accent)';
                    const cls = [iso === x.e.date || weekday === 0 ? 'start' : '', iso === x.end || weekday === 6 ? 'end' : ''].join(' ');
                    return <i key={lane} className={`on ${cls}`} style={{ background: color }} title={x.e.title} />;
                  })}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <h3 className="day-title">{capitalize(fmt(selected, { weekday: 'long', day: 'numeric', month: 'long' }))}</h3>
      {agenda(selected).length ? (
        <AgendaList items={agenda(selected)} onOpen={setEditing} />
      ) : (
        <Empty>Rien de prévu ce jour-là.</Empty>
      )}

      <Fab onClick={() => setEditing('new')} label="Nouvel événement" />
      <Sheet open={choosing} title="Calendriers" onClose={() => setChoosing(false)}>
        {choosing && (
          <>
            <button
              type="button"
              className="btn circles-btn"
              onClick={() => {
                setChoosing(false);
                setCircles(true);
              }}
            >
              <Lock size={16} /> Cercles : qui voit quoi
            </button>
            <CalendarsSheet />
          </>
        )}
      </Sheet>
      <Sheet open={circles} title="Cercles" onClose={() => setCircles(false)}>
        {circles && <CirclesSheet />}
      </Sheet>
      <Sheet open={!!editing} title={editing === 'new' ? 'Nouvel événement' : "Modifier l'événement"} onClose={() => setEditing(null)}>
        {editing && (
          <EventForm
            initial={editing === 'new' ? undefined : editing}
            defaultDate={selected}
            onSubmit={async (ev, target) => {
              const removed = editing !== 'new' && (editing.groups ?? []).some((g) => !target.includes(g));
              if (removed && !confirm("Les appareils qui ont déjà reçu cet évènement l'ont vu. Il ne sera plus visible que par les cercles choisis. Continuer ?")) return;
              await save(editing, ev, target);
              setEditing(null);
            }}
            onDelete={
              editing === 'new'
                ? undefined
                : () => {
                    if (confirmDelete(`« ${editing.title} »`)) {
                      remove(editing);
                      setEditing(null);
                    }
                  }
            }
          />
        )}
      </Sheet>
    </Page>
  );
}

function EventForm({
  initial,
  defaultDate,
  onSubmit,
  onDelete,
}: {
  initial?: CalEvent;
  defaultDate: string;
  onSubmit: (e: CalEvent, groups: string[]) => void;
  onDelete?: () => void;
}) {
  const { members: everyone } = useMembers();
  const vault = useVault();
  const defaultGroups = useDefaultGroups();
  const [ev, setEv] = useState<CalEvent>(
    initial ?? { title: '', date: defaultDate, allDay: false, start: '09:00', end: '10:00', repeat: 'none', memberIds: [], notes: '' },
  );
  const [target, setTarget] = useState<string[]>(initial?.groups?.length ? initial.groups : defaultGroups);
  // Un évènement ne concerne que des membres de ses cercles (les autres ne le verraient pas).
  const allowed = target.length ? vault.membersOf(target) : null;
  const members = allowed ? everyone.filter((m) => allowed.has(m.id)) : everyone;
  const set = (patch: Partial<CalEvent>) => setEv((e) => ({ ...e, ...patch }));

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ev.title.trim()) return;
        onSubmit(
          {
            ...ev,
            title: ev.title.trim(),
            endDate: ev.endDate && ev.endDate > ev.date && (ev.repeat ?? 'none') === 'none' ? ev.endDate : '',
            memberIds: allowed ? ev.memberIds.filter((id) => allowed.has(id)) : ev.memberIds,
          },
          target,
        );
      }}
    >
      <Field label="Titre">
        <input autoFocus value={ev.title} onChange={(e) => set({ title: e.target.value })} placeholder="Piscine, dentiste, dîner chez mamie…" />
      </Field>
      <div className="row">
        <Field label={(ev.repeat ?? 'none') === 'none' ? 'Du' : 'Date'}>
          <input type="date" required value={ev.date} onChange={(e) => set({ date: e.target.value })} />
        </Field>
        {(ev.repeat ?? 'none') === 'none' && (
          <Field label="Au (si plusieurs jours)">
            <input type="date" min={ev.date} value={ev.endDate ?? ''} onChange={(e) => set({ endDate: e.target.value })} />
          </Field>
        )}
      </div>
      <div className="row">
        <Field label="Répéter">
          <select value={ev.repeat ?? 'none'} onChange={(e) => set({ repeat: e.target.value as Repeat })}>
            <option value="none">Jamais</option>
            <option value="weekly">Chaque semaine</option>
            <option value="monthly">Chaque mois</option>
            <option value="yearly">Chaque année</option>
          </select>
        </Field>
      </div>
      <label className="toggle">
        <input type="checkbox" checked={ev.allDay} onChange={(e) => set({ allDay: e.target.checked })} />
        Toute la journée
      </label>
      {!ev.allDay && (
        <div className="row">
          <Field label="Début">
            <input type="time" value={ev.start ?? ''} onChange={(e) => set({ start: e.target.value })} />
          </Field>
          <Field label={ev.endDate && ev.endDate > ev.date && (ev.repeat ?? 'none') === 'none' ? 'Fin (dernier jour)' : 'Fin'}>
            <input type="time" value={ev.end ?? ''} onChange={(e) => set({ end: e.target.value })} />
          </Field>
        </div>
      )}
      <FieldGroup label="Visible par">
        <VisibilityPicker value={target} onChange={setTarget} />
      </FieldGroup>
      <FieldGroup label="Qui ?">
        <MemberChips members={members} value={ev.memberIds} onChange={(memberIds) => set({ memberIds })} />
      </FieldGroup>
      <Field label="Rappel">
        <select
          value={ev.reminder === undefined || ev.reminder === -1 ? 'default' : ev.reminder === null ? 'none' : String(ev.reminder)}
          onChange={(e) => {
            const v = e.target.value;
            set({ reminder: v === 'default' ? -1 : v === 'none' ? null : Number(v) });
          }}
        >
          <option value="default">Par défaut (selon les réglages de chacun)</option>
          <option value="none">Aucun rappel</option>
          <option value="0">À l'heure</option>
          <option value="10">10 min avant</option>
          <option value="30">30 min avant</option>
          <option value="60">1 h avant</option>
          <option value="120">2 h avant</option>
          <option value="1440">La veille (même heure)</option>
        </select>
      </Field>
      <Field label="Notes">
        <textarea rows={3} value={ev.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
      <div className="form-actions">
        {onDelete && (
          <button type="button" className="btn danger" onClick={onDelete}>
            Supprimer
          </button>
        )}
        <button className="btn primary grow" disabled={!ev.title.trim()}>
          Enregistrer
        </button>
      </div>
    </form>
  );
}
