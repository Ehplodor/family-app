import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { useCalendarEvents, useCollection, useMembers } from '../store';
import { capitalize, fmt, parseISODate, today } from '../dates';
import { Empty } from '../ui';
import type { Member } from '../store';
import type { Birthday } from './Birthdays';
import type { CalEvent, Occurrence } from './Calendar';
import { displayDate, matchesQuery, sortResults, visibleFor, type SearchMode } from '../lib/calendarSearch';

type Result = Occurrence & { date: string; until?: string };

/** Recherche d'événements : un appui sur un résultat ouvre le jour correspondant dans le calendrier. */
export function CalendarSearch({ filter, onPick }: { filter: string[]; onPick: (iso: string) => void }) {
  const events = useCalendarEvents<CalEvent>();
  const { docs: birthdays } = useCollection<Birthday>('birthdays');
  const { byId } = useMembers();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('contains');

  const results = useMemo(() => {
    if (!query.trim()) return [];
    const from = today();
    const evs: Result[] = events
      .filter((e) => matchesQuery(e, query, mode) && visibleFor(e.memberIds, filter))
      .map((e) => {
        const members = e.memberIds.map((id) => byId(id)).filter((m): m is Member => !!m);
        const repeats = e.repeat && e.repeat !== 'none';
        return {
          key: e.id,
          title: e.title,
          date: displayDate(e, from),
          until: !repeats && e.endDate && e.endDate > e.date ? e.endDate : undefined,
          time: e.allDay ? undefined : e.start,
          color: members[0]?.color ?? 'var(--accent)',
          members,
          event: e,
        };
      });
    const bdays: Result[] = birthdays
      .map((b) => ({ b, title: `Anniversaire de ${b.name}` }))
      .filter(({ b, title }) => matchesQuery({ title, notes: b.notes }, query, mode) || matchesQuery({ title: b.name }, query, mode))
      .map(({ b, title }) => {
        const year = Number(from.slice(0, 4));
        const pad = (n: number) => String(n).padStart(2, '0');
        let date = `${year}-${pad(b.month)}-${pad(b.day)}`;
        if (date < from) date = `${year + 1}-${pad(b.month)}-${pad(b.day)}`;
        return { key: `b-${b.id}`, title, date, color: '#F2784B', members: [], birthday: true };
      });
    return sortResults([...evs, ...bdays], from);
  }, [events, birthdays, query, mode, filter, byId]);

  return (
    <div className="cal-search">
      <label className="search">
        <Search size={18} />
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher un événement" />
      </label>
      <div className="segmented">
        <button type="button" className={mode === 'prefix' ? 'on' : ''} onClick={() => setMode('prefix')}>
          Commence par
        </button>
        <button type="button" className={mode === 'contains' ? 'on' : ''} onClick={() => setMode('contains')}>
          Contient
        </button>
      </div>
      {query.trim() &&
        (results.length ? (
          <ul className="agenda">
            {results.map((r) => (
              <li key={r.key} className="clickable" onClick={() => onPick(r.date)}>
                <span className="agenda-time">{capitalize(fmt(parseISODate(r.date), { day: 'numeric', month: 'short', year: '2-digit' }))}</span>
                <span className="agenda-bar" style={{ background: r.color }} />
                <span className="grow">
                  {r.title}
                  {r.until && <small className="muted"> → {fmt(parseISODate(r.until), { day: 'numeric', month: 'short' })}</small>}
                  {r.time && <small className="muted"> · {r.time}</small>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Aucun événement trouvé.</Empty>
        ))}
    </div>
  );
}
