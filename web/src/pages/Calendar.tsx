import { useMemo, useState } from 'react';
import { Cake, ChevronLeft, ChevronRight } from 'lucide-react';
import { useCollection, useMembers } from '../store';
import { addMonths, capitalize, fmt, parseISODate, startOfWeek, addDays, toISODate, today } from '../dates';
import { Avatar, Empty, Fab, Field, MemberChips, Page, Sheet, confirmDelete } from '../ui';
import type { Doc, Member } from '../store';
import type { Birthday } from './Birthdays';
import { occursOn, type Repeat } from '../lib/recurrence';

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
};

export type Occurrence = {
  key: string;
  title: string;
  time?: string;
  color: string;
  members: Member[];
  event?: Doc<CalEvent>;
  birthday?: boolean;
};

export { occursOn };

/** Tout ce qui se passe un jour donné (événements + anniversaires), trié. */
export function useDayAgenda() {
  const { docs: events } = useCollection<CalEvent>('events');
  const { docs: birthdays } = useCollection<Birthday>('birthdays');
  const { byId } = useMembers();
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
          .sort((a, b) => (a.allDay === b.allDay ? (a.start ?? '').localeCompare(b.start ?? '') : a.allDay ? -1 : 1))
          .map((e) => {
            const members = e.memberIds.map((id) => byId(id)).filter((m): m is Member => !!m);
            return {
              key: e.id,
              title: e.title,
              time: e.allDay ? undefined : [e.start, e.end].filter(Boolean).join(' – '),
              color: members[0]?.color ?? 'var(--accent)',
              members,
              event: e,
            };
          });
        return [...bdays, ...evs];
      },
    [events, birthdays, byId],
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
          <span className="grow">{o.title}</span>
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

const WEEKDAYS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

export function CalendarPage() {
  const events = useCollection<CalEvent>('events');
  const agenda = useDayAgenda();
  const [selected, setSelected] = useState(today());
  const [month, setMonth] = useState(() => parseISODate(today()));
  const [editing, setEditing] = useState<Doc<CalEvent> | 'new' | null>(null);

  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = startOfWeek(first);
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  // On retire la dernière ligne si elle est entièrement dans le mois suivant.
  const visible = days[35].getMonth() !== month.getMonth() ? days.slice(0, 35) : days;

  const goToday = () => {
    setSelected(today());
    setMonth(parseISODate(today()));
  };

  return (
    <Page
      title="Calendrier"
      actions={
        <button className="btn small" onClick={goToday}>
          Aujourd'hui
        </button>
      }
    >
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
                  {items.slice(0, 3).map((o) => (
                    <i key={o.key} style={{ background: o.color }} />
                  ))}
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
      <Sheet open={!!editing} title={editing === 'new' ? 'Nouvel événement' : "Modifier l'événement"} onClose={() => setEditing(null)}>
        {editing && (
          <EventForm
            initial={editing === 'new' ? undefined : editing}
            defaultDate={selected}
            onSubmit={async (ev) => {
              if (editing === 'new') await events.create(ev);
              else await events.update(editing.id, ev);
              setEditing(null);
            }}
            onDelete={
              editing === 'new'
                ? undefined
                : () => {
                    if (confirmDelete(`« ${editing.title} »`)) {
                      events.remove(editing.id);
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
  onSubmit: (e: CalEvent) => void;
  onDelete?: () => void;
}) {
  const { members } = useMembers();
  const [ev, setEv] = useState<CalEvent>(
    initial ?? { title: '', date: defaultDate, allDay: false, start: '09:00', end: '10:00', repeat: 'none', memberIds: [], notes: '' },
  );
  const set = (patch: Partial<CalEvent>) => setEv((e) => ({ ...e, ...patch }));

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ev.title.trim()) return;
        onSubmit({
          ...ev,
          title: ev.title.trim(),
          endDate: ev.endDate && ev.endDate > ev.date && (ev.repeat ?? 'none') === 'none' ? ev.endDate : '',
        });
      }}
    >
      <Field label="Titre">
        <input autoFocus value={ev.title} onChange={(e) => set({ title: e.target.value })} placeholder="Piscine, dentiste, dîner chez mamie…" />
      </Field>
      <div className="row">
        <Field label="Date">
          <input type="date" required value={ev.date} onChange={(e) => set({ date: e.target.value })} />
        </Field>
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
          <Field label="Fin">
            <input type="time" value={ev.end ?? ''} onChange={(e) => set({ end: e.target.value })} />
          </Field>
        </div>
      )}
      {(ev.repeat ?? 'none') === 'none' && (
        <Field label="Jusqu'au (optionnel, plusieurs jours)">
          <input type="date" min={ev.date} value={ev.endDate ?? ''} onChange={(e) => set({ endDate: e.target.value })} />
        </Field>
      )}
      <Field label="Qui ?">
        <MemberChips members={members} value={ev.memberIds} onChange={(memberIds) => set({ memberIds })} />
      </Field>
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
