import { useMemo, useState } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { useCollection, useDoc, type Doc } from '../../store';
import { answerCard, profileOf, type Card, type Homework, type Lesson, type SchoolProfile, type Slot } from '../../lib/school';
import { today } from '../../dates';
import { PALETTE } from '../../ui';

/** Toutes les données école d'un enfant. */
export function useSchool(childId: string) {
  const homework = useCollection<Homework>('homework');
  const timetable = useCollection<Slot>('timetable');
  const lessons = useCollection<Lesson>('lessons');
  const cards = useCollection<Card>('cards');
  const profileDoc = useDoc<Partial<SchoolProfile>>('schoolProfiles', childId);
  return useMemo(
    () => ({
      homework,
      timetable,
      lessons,
      cards,
      profile: profileOf(profileDoc),
      myHomework: homework.docs.filter((h) => h.childId === childId),
      mySlots: timetable.docs.filter((s) => s.childId === childId),
      myLessons: lessons.docs.filter((l) => l.childId === childId),
      myCards: cards.docs.filter((c) => c.childId === childId),
    }),
    [homework, timetable, lessons, cards, profileDoc, childId],
  );
}

/** Couleur stable pour une matière. */
export function subjectColor(subject: string): string {
  let h = 0;
  for (const ch of subject.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function SubjectDot({ subject }: { subject: string }) {
  return <span className="list-dot" style={{ background: subjectColor(subject) }} />;
}

export const subjectsOf = (slots: Slot[], homework: Homework[]) =>
  [...new Set([...slots.map((s) => s.subject), ...homework.map((h) => h.subject)])].filter(Boolean).sort((a, b) => a.localeCompare(b, 'fr'));

/** Une petite question : on réfléchit, on retourne la carte, on dit si on savait. */
export function QuizCard({ card, onAnswered }: { card: Doc<Card>; onAnswered?: (knew: boolean) => void }) {
  const cards = useCollection<Card>('cards');
  const [shown, setShown] = useState(false);
  const answer = (knew: boolean) => {
    cards.update(card.id, answerCard(card, knew, today()));
    setShown(false);
    onAnswered?.(knew);
  };
  return (
    <div className="card quiz" style={{ borderColor: subjectColor(card.subject) }}>
      <small>
        🧠 {card.subject} · boîte {card.box}/5
      </small>
      <p className="quiz-q">{card.question}</p>
      {shown ? (
        <>
          <p className="quiz-a">{card.answer}</p>
          <div className="form-actions">
            <button className="btn grow" onClick={() => answer(false)}>
              <RotateCcw size={18} /> À revoir
            </button>
            <button className="btn primary grow" onClick={() => answer(true)}>
              <Check size={18} /> Je savais
            </button>
          </div>
        </>
      ) : (
        <button className="btn primary" onClick={() => setShown(true)}>
          Voir la réponse
        </button>
      )}
    </div>
  );
}
