import { useState } from 'react';
import { BookOpen } from 'lucide-react';
import { useCollection, type Doc } from '../../store';
import {
  EFFORT_DEFAULT,
  KIND_EMOJI,
  KIND_LABEL,
  effortOf,
  nextClassDate,
  planSessions,
  progressOf,
  type Homework,
  type HomeworkKind,
} from '../../lib/school';
import { addDays, capitalize, fmt, relativeDay, today, toISODate } from '../../dates';
import { Empty, Fab, Field, FieldGroup, Sheet, confirmDelete } from '../../ui';
import { SubjectDot, subjectsOf, useSchool } from './shared';

export function HomeworkTab({ childId }: { childId: string }) {
  const s = useSchool(childId);
  const [editing, setEditing] = useState<Doc<Homework> | 'new' | null>(null);
  const [showDone, setShowDone] = useState(false);
  const t = today();
  const now = new Date();
  const sessions = planSessions(s.myHomework, childId, s.mySlots, s.profile, t, now.getHours() * 60 + now.getMinutes());
  const upcoming = s.myHomework.filter((h) => !h.done && h.due >= t).sort((a, b) => a.due.localeCompare(b.due));
  const past = s.myHomework.filter((h) => h.done || h.due < t).sort((a, b) => b.due.localeCompare(a.due));
  const dates = [...new Set(upcoming.map((h) => h.due))];

  return (
    <div className="stack">
      {!s.myHomework.length && <Empty icon={<BookOpen size={44} />}>Le cahier de textes est vide. Ajoutez devoirs, contrôles et leçons avec le bouton +.</Empty>}
      {dates.map((d) => (
        <section key={d}>
          <div className="section-title">
            <span>{capitalize(relativeDay(d))}</span>
          </div>
          <ul className="items">
            {upcoming
              .filter((h) => h.due === d)
              .map((h) => {
                const plan = sessions.filter((x) => x.hwId === h.id);
                const pct = h.kind === 'prevoir' ? 0 : Math.min(100, (progressOf(h) / effortOf(h)) * 100);
                return (
                  <li key={h.id} className="item" onClick={() => setEditing(h)}>
                    <SubjectDot subject={h.subject} />
                    <span className="grow">
                      {KIND_EMOJI[h.kind]} <strong>{h.subject}</strong> · {h.title}
                      <small className="block">
                        {KIND_LABEL[h.kind]}
                        {h.kind !== 'prevoir' && ` · ${progressOf(h)}/${effortOf(h)} min`}
                        {plan.length > 0 && ` · séances : ${plan.map((x) => fmt(x.date, { weekday: 'short' })).join(', ')}`}
                        {plan.some((x) => x.late) && ' ⚠️'}
                      </small>
                    </span>
                    {h.kind !== 'prevoir' && (
                      <span className="progress">
                        <span style={{ width: `${pct}%`, background: 'var(--accent)' }} />
                      </span>
                    )}
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
      {past.length > 0 && (
        <button className="link" onClick={() => setShowDone(!showDone)}>
          {showDone ? 'Masquer' : 'Voir'} les faits et passés ({past.length})
        </button>
      )}
      {showDone && (
        <ul className="items">
          {past.map((h) => (
            <li key={h.id} className="item done" onClick={() => setEditing(h)}>
              <span className="grow">
                {KIND_EMOJI[h.kind]} {h.subject} · {h.title}
                <small className="block">{fmt(h.due, { day: 'numeric', month: 'short' })}</small>
              </span>
            </li>
          ))}
        </ul>
      )}

      <Fab onClick={() => setEditing('new')} label="Ajouter au cahier de textes" />
      <Sheet open={!!editing} title={editing === 'new' ? 'Ajouter' : 'Modifier'} onClose={() => setEditing(null)}>
        {editing && (
          <HomeworkForm
            childId={childId}
            initial={editing === 'new' ? undefined : editing}
            onClose={() => setEditing(null)}
          />
        )}
      </Sheet>
    </div>
  );
}

const EFFORTS = [10, 15, 20, 30, 45, 60, 90, 120, 180];
const duration = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60}` : ''}`);

function HomeworkForm({ childId, initial, onClose }: { childId: string; initial?: Doc<Homework>; onClose: () => void }) {
  const s = useSchool(childId);
  const homework = useCollection<Homework>('homework');
  const subjects = subjectsOf(s.mySlots, s.myHomework);
  const [h, setH] = useState<Homework>(
    initial ?? { childId, kind: 'devoir', subject: subjects[0] ?? '', title: '', due: toISODate(addDays(new Date(), 1)), effort: EFFORT_DEFAULT.devoir, notes: '' },
  );
  const set = (patch: Partial<Homework>) => setH((x) => ({ ...x, ...patch }));
  const nextClass = h.subject ? nextClassDate(s.mySlots, childId, h.subject, s.profile, today()) : null;
  const lessons = s.myLessons.filter((l) => l.subject === h.subject);

  return (
    <form
      className="form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!h.subject.trim() || !h.title.trim()) return;
        const data = { ...h, subject: h.subject.trim(), title: h.title.trim() };
        if (initial) await homework.update(initial.id, data);
        else await homework.create(data);
        onClose();
      }}
    >
      <div className="chips">
        {(Object.keys(KIND_LABEL) as HomeworkKind[]).map((k) => (
          <button
            key={k}
            type="button"
            className={`chip ${h.kind === k ? 'on' : ''}`}
            style={h.kind === k ? { background: 'var(--accent)', borderColor: 'var(--accent)' } : { borderColor: 'var(--border)' }}
            onClick={() => set({ kind: k, effort: initial ? h.effort : EFFORT_DEFAULT[k] })}
          >
            {KIND_EMOJI[k]} {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      <Field label="Matière">
        <input list="school-subjects" value={h.subject} onChange={(e) => set({ subject: e.target.value })} placeholder="Maths, Français…" />
        <datalist id="school-subjects">
          {subjects.map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
      </Field>
      <Field label={h.kind === 'prevoir' ? 'Quoi ?' : 'Consigne'}>
        <input
          autoFocus={!initial}
          value={h.title}
          onChange={(e) => set({ title: e.target.value })}
          placeholder={h.kind === 'prevoir' ? 'Tenue de sport, pique-nique, mot signé…' : h.kind === 'controle' ? 'Chapitre 3 : les fractions' : 'Exercices 4 et 5 p. 42'}
        />
      </Field>
      <Field label={h.kind === 'controle' ? 'Date du contrôle' : 'Pour le'}>
        <input type="date" required value={h.due} onChange={(e) => set({ due: e.target.value })} />
      </Field>
      <div className="chips">
        <button type="button" className="chip" onClick={() => set({ due: toISODate(addDays(new Date(), 1)) })}>
          Demain
        </button>
        {nextClass && (
          <button type="button" className="chip" onClick={() => set({ due: nextClass })}>
            Prochain cours de {h.subject} ({fmt(nextClass, { weekday: 'short', day: 'numeric' })})
          </button>
        )}
      </div>
      {h.kind !== 'prevoir' && (
        <Field label={h.kind === 'controle' ? 'Temps de révision total' : 'Temps de travail estimé'}>
          <select value={h.effort ?? EFFORT_DEFAULT[h.kind]} onChange={(e) => set({ effort: Number(e.target.value) })}>
            {EFFORTS.map((m) => (
              <option key={m} value={m}>
                {duration(m)}
              </option>
            ))}
          </select>
        </Field>
      )}
      {h.kind === 'controle' && lessons.length > 0 && (
        <FieldGroup label="Leçons à réviser (questions en priorité)">
          <div className="chips">
            {lessons.map((l) => {
              const on = h.lessonIds?.includes(l.id) ?? false;
              return (
                <button
                  key={l.id}
                  type="button"
                  className={`chip ${on ? 'on' : ''}`}
                  style={on ? { background: 'var(--accent)', borderColor: 'var(--accent)' } : { borderColor: 'var(--border)' }}
                  onClick={() => set({ lessonIds: on ? h.lessonIds!.filter((x) => x !== l.id) : [...(h.lessonIds ?? []), l.id] })}
                >
                  {l.title}
                </button>
              );
            })}
          </div>
        </FieldGroup>
      )}
      <Field label="Notes">
        <textarea rows={2} value={h.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
      {initial && h.kind !== 'prevoir' && (
        <p className="muted small">
          Déjà fait : {progressOf(initial)} min sur {effortOf(initial)} min.
        </p>
      )}
      <div className="form-actions">
        {initial && (
          <button
            type="button"
            className="btn danger"
            onClick={() => {
              if (confirmDelete(`« ${initial.title} »`)) {
                homework.remove(initial.id);
                onClose();
              }
            }}
          >
            Supprimer
          </button>
        )}
        {initial && !initial.done && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              homework.update(initial.id, { done: true });
              onClose();
            }}
          >
            Terminé
          </button>
        )}
        <button className="btn primary grow" disabled={!h.subject.trim() || !h.title.trim()}>
          Enregistrer
        </button>
      </div>
    </form>
  );
}
