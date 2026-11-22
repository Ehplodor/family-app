import { useState } from 'react';
import { Brain, Trash2 } from 'lucide-react';
import { useCollection, useEngine, type Doc } from '../../store';
import { dueCards, parseCards, type Card, type Lesson } from '../../lib/school';
import { today } from '../../dates';
import { Empty, Fab, Field, Sheet, confirmDelete } from '../../ui';
import { QuizCard, SubjectDot, subjectsOf, useSchool } from './shared';

export function LessonsTab({ childId }: { childId: string }) {
  const s = useSchool(childId);
  const [editing, setEditing] = useState<Doc<Lesson> | 'new' | null>(null);
  const [session, setSession] = useState<string[] | null>(null);
  const [answered, setAnswered] = useState({ knew: 0, total: 0 });
  const due = dueCards(s.myCards, s.myHomework, childId, today());
  const subjects = [...new Set(s.myLessons.map((l) => l.subject))].sort((a, b) => a.localeCompare(b, 'fr'));

  if (session) {
    const current = s.myCards.find((c) => c.id === session[0]);
    return (
      <div className="stack">
        {current ? (
          <>
            <p className="muted center">
              Question {answered.total + 1} / {answered.total + session.length}
            </p>
            <QuizCard
              key={current.id}
              card={current}
              onAnswered={(knew) => {
                setAnswered((a) => ({ knew: a.knew + (knew ? 1 : 0), total: a.total + 1 }));
                setSession(session.slice(1));
              }}
            />
          </>
        ) : (
          <div className="card center">
            <h3>Bravo ! 🎉</h3>
            <p>
              {answered.knew} / {answered.total} bonnes réponses. Les questions ratées reviendront demain, les autres plus tard.
            </p>
          </div>
        )}
        <button className="btn" onClick={() => setSession(null)}>
          Terminer
        </button>
      </div>
    );
  }

  return (
    <div className="stack">
      <button
        className="btn primary big"
        disabled={!due.length}
        onClick={() => {
          setAnswered({ knew: 0, total: 0 });
          setSession(due.slice(0, 10).map((c) => c.id));
        }}
      >
        <Brain size={20} /> {due.length ? `Réviser maintenant (${Math.min(10, due.length)} questions)` : 'Tout est révisé pour aujourd’hui'}
      </button>
      <p className="muted small">
        Chaque bonne réponse espace la question suivante (1, 2, 4, 8 puis 16 jours) ; une erreur la fait revenir dès le lendemain. Avant un contrôle, ses
        leçons passent en priorité. Une ou deux questions arrivent aussi chaque jour en notification.
      </p>
      {!s.myLessons.length && <Empty icon={<Brain size={44} />}>Ajoutez une leçon en quelques questions/réponses pour l’apprendre sans s’en rendre compte.</Empty>}
      {subjects.map((subject) => (
        <section key={subject}>
          <div className="section-title">
            <span>{subject}</span>
          </div>
          <ul className="items">
            {s.myLessons
              .filter((l) => l.subject === subject)
              .map((l) => {
                const cards = s.myCards.filter((c) => c.lessonId === l.id);
                const mastery = cards.length ? Math.round((cards.reduce((a, c) => a + (c.box - 1), 0) / (cards.length * 4)) * 100) : 0;
                return (
                  <li key={l.id} className="item" onClick={() => setEditing(l)}>
                    <SubjectDot subject={l.subject} />
                    <span className="grow">
                      {l.title}
                      <small className="block">
                        {cards.length} question{cards.length > 1 ? 's' : ''} · maîtrisé à {mastery} %
                      </small>
                    </span>
                    <span className="progress">
                      <span style={{ width: `${mastery}%`, background: 'var(--pos)' }} />
                    </span>
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
      <Fab onClick={() => setEditing('new')} label="Nouvelle leçon" />
      <Sheet open={!!editing} title={editing === 'new' ? 'Nouvelle leçon' : 'Leçon'} onClose={() => setEditing(null)}>
        {editing && <LessonForm childId={childId} initial={editing === 'new' ? undefined : editing} subjects={subjectsOf(s.mySlots, s.myHomework)} onClose={() => setEditing(null)} />}
      </Sheet>
    </div>
  );
}

function LessonForm({ childId, initial, subjects, onClose }: { childId: string; initial?: Doc<Lesson>; subjects: string[]; onClose: () => void }) {
  const engine = useEngine();
  const lessons = useCollection<Lesson>('lessons');
  const cards = useCollection<Card>('cards');
  const [subject, setSubject] = useState(initial?.subject ?? subjects[0] ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [text, setText] = useState('');
  const parsed = parseCards(text);
  const existing = initial ? cards.docs.filter((c) => c.lessonId === initial.id) : [];

  const save = async () => {
    let id = initial?.id;
    if (initial) await lessons.update(initial.id, { subject: subject.trim(), title: title.trim() });
    else id = (await lessons.create({ childId, subject: subject.trim(), title: title.trim() })).id;
    // Les fiches sont visibles par les mêmes cercles que leur leçon.
    const groups = engine.data.get('lessons', id!)?.groups;
    for (const p of parsed) {
      await engine.data.create<Card>('cards', { childId, lessonId: id, subject: subject.trim(), question: p.question, answer: p.answer, box: 1, due: today(), groups });
    }
    onClose();
  };

  return (
    <div className="form">
      <Field label="Matière">
        <input list="lesson-subjects" value={subject} onChange={(e) => setSubject(e.target.value)} />
        <datalist id="lesson-subjects">
          {subjects.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      </Field>
      <Field label="Titre de la leçon">
        <input autoFocus={!initial} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Les capitales d'Europe, Le verbe être…" />
      </Field>
      <Field label={initial ? 'Ajouter des questions (une par ligne)' : 'Questions (une par ligne : question = réponse)'}>
        <textarea
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'Capitale de l’Espagne = Madrid\nJe suis (anglais) = I am\n7 × 8 = 56'}
        />
      </Field>
      {parsed.length > 0 && <p className="muted small">{parsed.length} question(s) reconnue(s).</p>}
      {existing.length > 0 && (
        <ul className="items">
          {existing.map((c) => (
            <li key={c.id} className="item">
              <span className="grow">
                {c.question}
                <small className="block">
                  {c.answer} · boîte {c.box}/5
                </small>
              </span>
              <button className="icon-btn subtle" onClick={() => cards.remove(c.id)} aria-label="Supprimer la question">
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="form-actions">
        {initial && (
          <button
            type="button"
            className="btn danger"
            onClick={async () => {
              if (!confirmDelete(`la leçon « ${initial.title} » et ses questions`)) return;
              await engine.data.removeMany('cards', existing.map((c) => c.id));
              await lessons.remove(initial.id);
              onClose();
            }}
          >
            Supprimer
          </button>
        )}
        <button className="btn primary grow" disabled={!subject.trim() || !title.trim()} onClick={save}>
          Enregistrer
        </button>
      </div>
    </div>
  );
}
