import { useState } from 'react';
import { GraduationCap } from 'lucide-react';
import { useCollection, useEngine, useLocalState, useMe, useMembers } from '../../store';
import { navigate } from '../../router';
import { planSessions, profileOf, type Card, type Homework, type SchoolProfile, type Slot } from '../../lib/school';
import type { Member } from '../../lib/engine';
import { today } from '../../dates';
import { Avatar, ColorPicker, Empty, Field, FieldGroup, Page, PALETTE } from '../../ui';
import { QuizCard } from './shared';
import { TodayTab } from './TodayTab';
import { HomeworkTab } from './HomeworkTab';
import { TimetableTab } from './TimetableTab';
import { LessonsTab } from './LessonsTab';
import { SettingsTab } from './SettingsTab';

const TABS = [
  ['today', "Aujourd'hui"],
  ['homework', 'Devoirs'],
  ['timetable', 'Emploi du temps'],
  ['lessons', 'Révisions'],
  ['settings', 'Réglages'],
] as const;
type Tab = (typeof TABS)[number][0];

/** Résumé sur la tuile de l'accueil. */
export function SchoolSummary() {
  const { members } = useMe();
  const { docs: homework } = useCollection<Homework>('homework');
  const { docs: slots } = useCollection<Slot>('timetable');
  const { docs: profiles } = useCollection<Partial<SchoolProfile>>('schoolProfiles');
  const children = members.filter((m) => m.kind === 'child');
  if (!children.length) return <>Devoirs, emploi du temps, révisions</>;
  const now = new Date();
  return (
    <>
      {children
        .map((c) => {
          const p = profileOf(profiles.find((x) => x.id === c.id));
          const min = planSessions(homework, c.id, slots, p, today(), now.getHours() * 60 + now.getMinutes())
            .filter((x) => x.date === today())
            .reduce((a, x) => a + x.minutes, 0);
          return `${c.name} : ${min ? `${min} min` : 'rien'}`;
        })
        .join(' · ')}
    </>
  );
}

export function SchoolPage({ params }: { params: string[] }) {
  const me = useMe();
  const children = me.members.filter((m) => m.kind === 'child');
  const isChild = me.member.kind === 'child';
  const [stored, setStored] = useLocalState<string>('school.child', '');
  const [tab, setTab] = useLocalState<Tab>('school.tab', 'today');
  const visible = isChild ? children.filter((c) => c.id === me.member.id) : children;
  const childId = (params[0] && visible.some((c) => c.id === params[0]) ? params[0] : null) ?? (visible.some((c) => c.id === stored) ? stored : visible[0]?.id);

  if (params[1] === 'quiz' && params[2] && childId) return <QuizPage childId={childId} cardId={params[2]} />;

  if (!childId) {
    return (
      <Page title="École">
        <AddChild />
      </Page>
    );
  }

  return (
    <Page title="École" className="school">
      {visible.length > 1 && (
        <div className="chips child-picker">
          {visible.map((c) => (
            <button
              key={c.id}
              className={`chip ${c.id === childId ? 'on' : ''}`}
              style={c.id === childId ? { background: c.color, borderColor: c.color } : { borderColor: c.color }}
              onClick={() => {
                setStored(c.id);
                navigate(`/m/school/${c.id}`);
              }}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
      <div className="tabs" role="tablist">
        {TABS.filter(([id]) => !(isChild && id === 'settings')).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'today' && <TodayTab childId={childId} />}
      {tab === 'homework' && <HomeworkTab childId={childId} />}
      {tab === 'timetable' && <TimetableTab childId={childId} />}
      {tab === 'lessons' && <LessonsTab childId={childId} />}
      {tab === 'settings' && !isChild && <SettingsTab childId={childId} />}
    </Page>
  );
}

/** Ouverte depuis une notification « petite question ». */
function QuizPage({ childId, cardId }: { childId: string; cardId: string }) {
  const { docs } = useCollection<Card>('cards');
  const card = docs.find((c) => c.id === cardId);
  const [done, setDone] = useState<boolean | null>(null);
  return (
    <Page title="Petite question" back={`/m/school/${childId}`}>
      {!card ? (
        <Empty>Cette question n'existe plus.</Empty>
      ) : done === null ? (
        <QuizCard card={card} onAnswered={setDone} />
      ) : (
        <div className="card center">
          <h3>{done ? 'Bien joué ! 🎉' : "Pas grave, elle reviendra demain 💪"}</h3>
          <button className="btn primary" onClick={() => navigate(`/m/school/${childId}`)}>
            Retour à l'espace école
          </button>
        </div>
      )}
    </Page>
  );
}

function AddChild() {
  const engine = useEngine();
  const me = useMe();
  const { members } = useMembers();
  const [name, setName] = useState('');
  const [color, setColor] = useState(PALETTE[2]);
  const others = members.filter((m) => m.kind !== 'child' && m.id !== me.member.id);
  return (
    <div className="stack">
      <Empty icon={<GraduationCap size={48} />}>
        L'espace école regroupe l'emploi du temps, le cahier de textes et les révisions de chaque enfant, avec des rappels pour ne rien faire au
        dernier moment.
      </Empty>
      {others.length > 0 && (
        <div className="card form">
          <h3>Déjà dans la famille ?</h3>
          <p className="muted">Indiquez qui est un enfant :</p>
          <div className="chips">
            {others.map((m) => (
              <button key={m.id} className="chip" style={{ borderColor: m.color }} onClick={() => engine.data.update<Member>('members', m.id, { kind: 'child' })}>
                <Avatar member={m} size={20} /> {m.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <form
        className="card form"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) engine.data.create<Member>('members', { name: name.trim(), color, kind: 'child' });
        }}
      >
        <h3>Ajouter un enfant</h3>
        <Field label="Prénom">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <FieldGroup label="Couleur">
          <ColorPicker value={color} onChange={setColor} />
        </FieldGroup>
        <button className="btn primary" disabled={!name.trim()}>
          Ajouter
        </button>
      </form>
    </div>
  );
}
