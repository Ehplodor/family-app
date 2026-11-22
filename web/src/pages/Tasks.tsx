import { useState } from 'react';
import { Check, Repeat as RepeatIcon } from 'lucide-react';
import { useCollection, useMe, useMembers } from '../store';
import { relativeDay, today } from '../dates';
import { nextDue, type TaskRepeat } from '../lib/recurrence';
import { Avatar, Empty, Fab, Field, FieldGroup, MemberChips, Page, Sheet, confirmDelete, TimeInput } from '../ui';
import type { Doc } from '../store';
import { VisibleBy, useItemGroups, withGroups } from './Circles';

export type { TaskRepeat };
export type Task = {
  title: string;
  assigneeId?: string | null;
  due: string;
  /** Heure précise (HH:MM) : le rappel tombe à cette heure, même pendant les heures calmes. */
  time?: string;
  repeat: TaskRepeat;
  done?: boolean;
  lastDoneBy?: string | null;
  lastDoneAt?: string | null;
};

const REPEAT_LABEL: Record<TaskRepeat, string> = {
  none: 'Une fois',
  daily: 'Tous les jours',
  weekly: 'Chaque semaine',
  monthly: 'Chaque mois',
};


export function TasksSummary() {
  const { docs } = useCollection<Task>('tasks');
  const n = docs.filter((t) => !t.done && t.due <= today()).length;
  return <>{n ? `${n} à faire aujourd'hui` : 'Rien à faire aujourd’hui'}</>;
}

export function TasksPage() {
  const tasks = useCollection<Task>('tasks');
  const me = useMe();
  const { members, byId } = useMembers();
  const [filter, setFilter] = useState<string[]>([]);
  const [editing, setEditing] = useState<Doc<Task> | 'new' | null>(null);

  const visible = tasks.docs
    .filter((t) => !filter.length || filter.includes(t.assigneeId ?? ''))
    .sort((a, b) => a.due.localeCompare(b.due));
  const t0 = today();
  const groups: [string, Doc<Task>[]][] = [
    ['En retard', visible.filter((t) => !t.done && t.due < t0)],
    ["Aujourd'hui", visible.filter((t) => !t.done && t.due === t0)],
    ['À venir', visible.filter((t) => !t.done && t.due > t0)],
  ];
  const done = visible.filter((t) => t.done);

  const complete = (t: Doc<Task>) => {
    const stamp = { lastDoneBy: me.member.id, lastDoneAt: new Date().toISOString() };
    if (t.repeat === 'none') tasks.update(t.id, { done: true, ...stamp });
    else tasks.update(t.id, { due: nextDue(t), ...stamp });
  };

  const row = (t: Doc<Task>) => {
    const who = byId(t.assigneeId);
    return (
      <li key={t.id} className={`item ${t.done ? 'done' : ''}`}>
        <button
          className="check"
          style={t.done ? { background: 'var(--accent)', borderColor: 'var(--accent)' } : undefined}
          onClick={() => (t.done ? tasks.update(t.id, { done: false }) : complete(t))}
          aria-label={t.done ? 'Rouvrir' : 'Fait'}
        >
          {t.done && <Check size={16} />}
        </button>
        <span className="grow" onClick={() => setEditing(t)}>
          {t.title}
          <small className="block">
            {!t.done && relativeDay(t.due)}
            {!t.done && t.time && ` à ${t.time}`}
            {t.repeat !== 'none' && (
              <>
                {' '}
                · <RepeatIcon size={12} /> {REPEAT_LABEL[t.repeat].toLowerCase()}
              </>
            )}
            {t.lastDoneBy && t.repeat !== 'none' && ` · dernière fois : ${byId(t.lastDoneBy)?.name ?? '—'}`}
          </small>
        </span>
        {who && <Avatar member={who} size={28} />}
      </li>
    );
  };

  return (
    <Page title="Tâches">
      {members.length > 1 && <MemberChips members={members} value={filter} onChange={setFilter} />}
      {tasks.loaded && !tasks.docs.length && (
        <Empty icon={<RepeatIcon size={48} />}>
          Les corvées de la maison, ponctuelles ou récurrentes : sortir les poubelles, arroser les plantes, ranger sa chambre…
        </Empty>
      )}
      {groups.map(
        ([label, list]) =>
          list.length > 0 && (
            <section key={label}>
              <div className="section-title">
                <span>{label}</span>
              </div>
              <ul className="items">{list.map(row)}</ul>
            </section>
          ),
      )}
      {done.length > 0 && (
        <section>
          <div className="section-title">
            <span>Terminées ({done.length})</span>
            <button className="link" onClick={() => done.forEach((t) => tasks.remove(t.id))}>
              Tout effacer
            </button>
          </div>
          <ul className="items">{done.map(row)}</ul>
        </section>
      )}

      <Fab onClick={() => setEditing('new')} label="Nouvelle tâche" />
      <Sheet open={!!editing} title={editing === 'new' ? 'Nouvelle tâche' : 'Modifier la tâche'} onClose={() => setEditing(null)}>
        {editing && (
          <TaskForm
            initial={editing === 'new' ? undefined : editing}
            onSubmit={async (t) => {
              if (editing === 'new') await tasks.create(t);
              else await tasks.update(editing.id, t);
              setEditing(null);
            }}
            onDelete={
              editing === 'new'
                ? undefined
                : () => {
                    if (confirmDelete(`« ${editing.title} »`)) {
                      tasks.remove(editing.id);
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

function TaskForm({ initial, onSubmit, onDelete }: { initial?: Task; onSubmit: (t: Task) => void; onDelete?: () => void }) {
  const [groups, setGroups] = useItemGroups(initial);
  const { members } = useMembers();
  const [t, setT] = useState<Task>(initial ?? { title: '', assigneeId: null, due: today(), repeat: 'none' });
  const set = (patch: Partial<Task>) => setT((x) => ({ ...x, ...patch }));
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (t.title.trim()) onSubmit(withGroups({ ...t, title: t.title.trim() }, groups));
      }}
    >
      <Field label="Tâche">
        <input autoFocus={!initial} value={t.title} onChange={(e) => set({ title: e.target.value })} />
      </Field>
      <div className="row">
        <Field label="Échéance">
          <input type="date" required value={t.due} onChange={(e) => set({ due: e.target.value })} />
        </Field>
        <Field label="Heure (option)">
          <TimeInput value={t.time ?? ''} onChange={(v) => set({ time: v })} />
        </Field>
      </div>
      <div className="row">
        <Field label="Fréquence">
          <select value={t.repeat} onChange={(e) => set({ repeat: e.target.value as TaskRepeat })}>
            {Object.entries(REPEAT_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <FieldGroup label="Pour qui ?">
        <MemberChips
          members={members}
          multiple={false}
          value={t.assigneeId ? [t.assigneeId] : []}
          onChange={(ids) => set({ assigneeId: ids[0] ?? null })}
        />
      </FieldGroup>
      <VisibleBy value={groups} onChange={setGroups} />
      <div className="form-actions">
        {onDelete && (
          <button type="button" className="btn danger" onClick={onDelete}>
            Supprimer
          </button>
        )}
        <button className="btn primary grow" disabled={!t.title.trim()}>
          Enregistrer
        </button>
      </div>
    </form>
  );
}
