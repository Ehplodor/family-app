import { useState } from 'react';
import { CheckCircle2, PartyPopper } from 'lucide-react';
import { useEngine } from '../../store';
import { dueCards, KIND_EMOJI, KIND_LABEL, planSessions, progressOf, effortOf, slotsOn, type Homework } from '../../lib/school';
import { addDays, capitalize, fmt, relativeDay, today, toISODate } from '../../dates';
import { Empty } from '../../ui';
import { QuizCard, SubjectDot, useSchool } from './shared';

export function TodayTab({ childId }: { childId: string }) {
  const engine = useEngine();
  const s = useSchool(childId);
  const t = today();
  const now = new Date();
  const sessions = planSessions(s.myHomework, childId, s.mySlots, s.profile, t, now.getHours() * 60 + now.getMinutes());
  const todays = sessions.filter((x) => x.date === t);
  const next = sessions.filter((x) => x.date > t).slice(0, 4);
  const hw = (id: string) => s.myHomework.find((h) => h.id === id)!;
  const quiz = dueCards(s.myCards, s.myHomework, childId, t);
  const [answered, setAnswered] = useState(0);
  const tomorrow = toISODate(addDays(new Date(), 1));
  const tomorrowSlots = slotsOn(s.mySlots, childId, tomorrow, s.profile);
  const tomorrowDue = s.myHomework.filter((h) => h.due === tomorrow && !h.done);
  const soon = s.myHomework
    .filter((h) => !h.done && h.due > t && h.due <= toISODate(addDays(new Date(), 7)) && (h.kind === 'controle' || h.kind === 'expose'))
    .sort((a, b) => a.due.localeCompare(b.due));

  const logWork = (h: Homework & { id: string }, minutes: number) => {
    const log = { ...(h.log ?? {}), [t]: (h.log?.[t] ?? 0) + minutes };
    const finished = Object.values(log).reduce((a, b) => a + b, 0) >= effortOf(h) && h.kind !== 'controle';
    engine.data.update<Homework>('homework', h.id, { log, ...(finished ? { done: true } : {}) });
  };

  return (
    <div className="stack">
      <div className="card">
        <h3>Travail du jour</h3>
        {todays.length ? (
          <ul className="plain">
            {todays.map((x) => {
              const h = hw(x.hwId);
              return (
                <li key={x.hwId} className="session">
                  <SubjectDot subject={h.subject} />
                  <span className="grow">
                    <strong>
                      {KIND_EMOJI[h.kind]} {h.subject} · {x.minutes} min
                    </strong>
                    <small className="block">
                      {h.title} — {h.kind === 'controle' ? 'contrôle' : 'pour'} {relativeDay(h.due).toLowerCase()}
                      {x.late ? ' · ⚠️ il est temps !' : ''}
                    </small>
                  </span>
                  <button className="btn small primary" onClick={() => logWork(h, x.minutes)}>
                    <CheckCircle2 size={16} /> Fait
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty icon={<PartyPopper size={36} />}>Rien à faire aujourd'hui. Bravo !</Empty>
        )}
        {next.length > 0 && (
          <small className="block muted">
            Ensuite : {next.map((x) => `${fmt(x.date, { weekday: 'short' })} ${hw(x.hwId).subject} ${x.minutes} min`).join(' · ')}
          </small>
        )}
      </div>

      {/* Une carte répondue quitte la liste (sa prochaine date est repoussée) : on affiche toujours la première. */}
      {quiz.length > 0 && answered < 3 && <QuizCard key={quiz[0].id} card={quiz[0]} onAnswered={() => setAnswered((n) => n + 1)} />}

      {(tomorrowSlots.length > 0 || tomorrowDue.length > 0) && (
        <div className="card">
          <h3>🎒 {capitalize(fmt(tomorrow, { weekday: 'long' }))}</h3>
          {tomorrowSlots.length > 0 && <p className="muted">{[...new Set(tomorrowSlots.map((x) => x.subject))].join(' · ')}</p>}
          {tomorrowDue.map((h) => (
            <p key={h.id}>
              {KIND_EMOJI[h.kind]} {h.kind === 'prevoir' ? h.title : `${KIND_LABEL[h.kind]} de ${h.subject} : ${h.title}`}
            </p>
          ))}
        </div>
      )}

      {soon.length > 0 && (
        <div className="card">
          <h3>Bientôt</h3>
          {soon.map((h) => (
            <div key={h.id} className="row-line">
              <SubjectDot subject={h.subject} />
              <span className="grow">
                {KIND_EMOJI[h.kind]} {KIND_LABEL[h.kind]} de {h.subject}
                <small className="block">{relativeDay(h.due)}</small>
              </span>
              <span className="progress">
                <span style={{ width: `${Math.min(100, (progressOf(h) / effortOf(h)) * 100)}%`, background: 'var(--accent)' }} />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
