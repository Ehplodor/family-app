import { useState } from 'react';
import { CalendarClock } from 'lucide-react';
import { useCollection, useEngine, type Doc } from '../../store';
import { slotsOn, weekType, type SchoolProfile, type Slot } from '../../lib/school';
import { addDays, startOfWeek, toISODate, today } from '../../dates';
import { Empty, Fab, Field, Sheet, confirmDelete } from '../../ui';
import { subjectColor, subjectsOf, useSchool } from './shared';

const DAYS = [
  [1, 'Lundi'],
  [2, 'Mardi'],
  [3, 'Mercredi'],
  [4, 'Jeudi'],
  [5, 'Vendredi'],
  [6, 'Samedi'],
] as const;

export function TimetableTab({ childId }: { childId: string }) {
  const engine = useEngine();
  const s = useSchool(childId);
  const [editing, setEditing] = useState<Doc<Slot> | { day: number } | null>(null);
  const t = today();
  const dow = new Date().getDay();
  const wt = weekType(t, s.profile.weekARef);
  const hasAB = s.mySlots.some((x) => x.weeks === 'A' || x.weeks === 'B');
  const monday = toISODate(startOfWeek(new Date()));

  return (
    <div className="stack">
      {hasAB && (
        <div className="card row-line">
          <span className="grow">{wt ? `Cette semaine : semaine ${wt}` : 'Semaines A/B : laquelle est cette semaine ?'}</span>
          {(['A', 'B'] as const).map((w) => (
            <button
              key={w}
              className={`btn small ${wt === w ? 'primary' : ''}`}
              onClick={() =>
                engine.data.upsert<SchoolProfile>('schoolProfiles', childId, {
                  weekARef: w === 'A' ? monday : toISODate(addDays(startOfWeek(new Date()), -7)),
                })
              }
            >
              {w}
            </button>
          ))}
        </div>
      )}
      {!s.mySlots.length && (
        <Empty icon={<CalendarClock size={44} />}>
          Saisissez l'emploi du temps une fois pour toutes : il sert à proposer la date des devoirs (« prochain cours »), à préparer le cartable
          et à ne jamais envoyer de notification pendant les cours.
        </Empty>
      )}
      {DAYS.map(([day, label]) => {
        const list = s.mySlots.filter((x) => x.day === day).sort((a, b) => a.start.localeCompare(b.start));
        const shown = wt ? slotsOn(s.mySlots, childId, toISODate(addDays(startOfWeek(new Date()), day - 1)), s.profile) : list;
        return (
          <section key={day}>
            <div className="section-title">
              <span className={day === dow ? 'accent-text' : ''}>{label}</span>
              <button className="link" onClick={() => setEditing({ day })}>
                + Cours
              </button>
            </div>
            {list.length > 0 && (
              <ul className="items">
                {list.map((x) => (
                  <li key={x.id} className={`item ${shown.includes(x) ? '' : 'faded'}`} onClick={() => setEditing(x)}>
                    <span className="slot-time">
                      {x.start}
                      <small className="block">{x.end}</small>
                    </span>
                    <span className="agenda-bar" style={{ background: subjectColor(x.subject) }} />
                    <span className="grow">
                      {x.subject}
                      {(x.room || (x.weeks && x.weeks !== 'all')) && (
                        <small className="block">
                          {[x.room, x.weeks && x.weeks !== 'all' ? `semaine ${x.weeks}` : ''].filter(Boolean).join(' · ')}
                        </small>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      <Fab onClick={() => setEditing({ day: dow >= 1 && dow <= 6 ? dow : 1 })} label="Ajouter un cours" />
      <Sheet open={!!editing} title={editing && 'id' in editing ? 'Modifier le cours' : 'Nouveau cours'} onClose={() => setEditing(null)}>
        {editing && <SlotForm childId={childId} initial={editing} subjects={subjectsOf(s.mySlots, s.myHomework)} onClose={() => setEditing(null)} />}
      </Sheet>
    </div>
  );
}

function SlotForm({
  childId,
  initial,
  subjects,
  onClose,
}: {
  childId: string;
  initial: Doc<Slot> | { day: number };
  subjects: string[];
  onClose: () => void;
}) {
  const timetable = useCollection<Slot>('timetable');
  const existing = 'id' in initial ? initial : null;
  const [x, setX] = useState<Slot>(existing ?? { childId, day: initial.day, start: '08:30', end: '09:30', subject: '', room: '', weeks: 'all' });
  const set = (patch: Partial<Slot>) => setX((v) => ({ ...v, ...patch }));
  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!x.subject.trim()) return;
        const data = { ...x, subject: x.subject.trim() };
        if (existing) await timetable.update(existing.id, data);
        else {
          await timetable.create(data);
          // On enchaîne facilement : le cours suivant commence à la fin de celui-ci.
          setX({ ...data, subject: '', room: '', start: data.end, end: addHour(data.end) });
          return;
        }
        onClose();
      }}
    >
      <Field label="Jour">
        <select value={x.day} onChange={(e) => set({ day: Number(e.target.value) })}>
          {DAYS.map(([d, l]) => (
            <option key={d} value={d}>
              {l}
            </option>
          ))}
        </select>
      </Field>
      <div className="row">
        <Field label="Début">
          <input type="time" value={x.start} onChange={(e) => set({ start: e.target.value })} />
        </Field>
        <Field label="Fin">
          <input type="time" value={x.end} onChange={(e) => set({ end: e.target.value })} />
        </Field>
      </div>
      <Field label="Matière">
        <input autoFocus list="tt-subjects" value={x.subject} onChange={(e) => set({ subject: e.target.value })} />
        <datalist id="tt-subjects">
          {subjects.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      </Field>
      <div className="row">
        <Field label="Salle (option)">
          <input value={x.room ?? ''} onChange={(e) => set({ room: e.target.value })} />
        </Field>
        <Field label="Semaines">
          <select value={x.weeks ?? 'all'} onChange={(e) => set({ weeks: e.target.value as Slot['weeks'] })}>
            <option value="all">Toutes</option>
            <option value="A">Semaine A</option>
            <option value="B">Semaine B</option>
          </select>
        </Field>
      </div>
      <div className="form-actions">
        {existing && (
          <button
            type="button"
            className="btn danger"
            onClick={() => {
              if (confirmDelete('ce cours')) {
                timetable.remove(existing.id);
                onClose();
              }
            }}
          >
            Supprimer
          </button>
        )}
        <button className="btn primary grow" disabled={!x.subject.trim()}>
          {existing ? 'Enregistrer' : 'Ajouter et continuer'}
        </button>
      </div>
      {!existing && (
        <button type="button" className="link" onClick={onClose}>
          Terminé
        </button>
      )}
    </form>
  );
}

function addHour(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${String(Math.min(23, h + 1)).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
