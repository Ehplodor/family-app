import { useState } from 'react';
import { Cake } from 'lucide-react';
import { useCollection } from '../store';
import { daysBetween, fmt, nextAnnual, pad, parseISODate, today } from '../dates';
import { Empty, Fab, Field, Page, Sheet, confirmDelete } from '../ui';
import type { Doc } from '../api';

export type Birthday = { name: string; day: number; month: number; year?: number | null; notes?: string };

type Upcoming = Doc<Birthday> & { next: string; inDays: number; age?: number };

function upcoming(docs: Doc<Birthday>[]): Upcoming[] {
  return docs
    .map((b) => {
      const next = nextAnnual(b.month, b.day);
      return { ...b, next, inDays: daysBetween(today(), next), age: b.year ? parseISODate(next).getFullYear() - b.year : undefined };
    })
    .sort((a, b) => a.inDays - b.inDays);
}

const when = (n: number) => (n === 0 ? "Aujourd'hui 🎉" : n === 1 ? 'Demain' : `Dans ${n} jours`);

export function BirthdaysSummary() {
  const { docs } = useCollection<Birthday>('birthdays');
  const next = upcoming(docs)[0];
  if (!next) return <>Vos moments importants</>;
  return (
    <>
      {next.name} · {when(next.inDays).toLowerCase()}
    </>
  );
}

export function BirthdaysPage() {
  const birthdays = useCollection<Birthday>('birthdays');
  const [editing, setEditing] = useState<Doc<Birthday> | 'new' | null>(null);
  const list = upcoming(birthdays.docs);

  return (
    <Page title="Anniversaires">
      {birthdays.loaded && !list.length && (
        <Empty icon={<Cake size={48} />}>Ajoutez les anniversaires de vos proches pour ne plus en oublier aucun.</Empty>
      )}
      <div className="stack">
        {list.map((b) => (
          <button key={b.id} className={`card row-card ${b.inDays === 0 ? 'highlight' : ''}`} onClick={() => setEditing(b)}>
            <span className="date-badge">
              <strong>{b.day}</strong>
              <small>{fmt(b.next, { month: 'short' })}</small>
            </span>
            <span className="grow">
              <strong>{b.name}</strong>
              <small>{b.age !== undefined ? `${b.inDays === 0 ? 'Fête ses' : 'Aura'} ${b.age} ans` : fmt(b.next, { weekday: 'long' })}</small>
            </span>
            <span className={`pill ${b.inDays <= 7 ? 'accent' : ''}`}>{when(b.inDays)}</span>
          </button>
        ))}
      </div>
      <Fab onClick={() => setEditing('new')} label="Nouvel anniversaire" />
      <Sheet open={!!editing} title={editing === 'new' ? 'Nouvel anniversaire' : "Modifier l'anniversaire"} onClose={() => setEditing(null)}>
        {editing && (
          <BirthdayForm
            initial={editing === 'new' ? undefined : editing}
            onSubmit={async (b) => {
              if (editing === 'new') await birthdays.create(b);
              else await birthdays.update(editing.id, b);
              setEditing(null);
            }}
            onDelete={
              editing === 'new'
                ? undefined
                : () => {
                    if (confirmDelete(`l'anniversaire de ${editing.name}`)) {
                      birthdays.remove(editing.id);
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

function BirthdayForm({
  initial,
  onSubmit,
  onDelete,
}: {
  initial?: Birthday;
  onSubmit: (b: Birthday) => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [date, setDate] = useState(
    initial ? `${initial.year ?? 2000}-${pad(initial.month)}-${pad(initial.day)}` : '',
  );
  const [unknownYear, setUnknownYear] = useState(initial ? !initial.year : false);
  const [notes, setNotes] = useState(initial?.notes ?? '');

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || !date) return;
        const [y, m, d] = date.split('-').map(Number);
        onSubmit({ name: name.trim(), day: d, month: m, year: unknownYear ? null : y, notes });
      }}
    >
      <Field label="Prénom / nom">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Date de naissance">
        <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <label className="toggle">
        <input type="checkbox" checked={unknownYear} onChange={(e) => setUnknownYear(e.target.checked)} />
        Je ne connais pas l'année
      </label>
      <Field label="Idées cadeaux, notes">
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
      <div className="form-actions">
        {onDelete && (
          <button type="button" className="btn danger" onClick={onDelete}>
            Supprimer
          </button>
        )}
        <button className="btn primary grow" disabled={!name.trim() || !date}>
          Enregistrer
        </button>
      </div>
    </form>
  );
}
