import { Sparkles } from 'lucide-react';
import { useMe } from '../store';
import { navigate } from '../router';
import { DEFAULT_HOME, moduleById, type ModuleDef } from '../modules';
import { capitalize, fmt, today } from '../dates';
import { Avatar } from '../ui';
import { AgendaList, useDayAgenda } from './Calendar';

function Tile({ mod }: { mod: ModuleDef }) {
  const Icon = mod.icon;
  return (
    <button className="tile" onClick={() => navigate(`/m/${mod.id}`)}>
      <strong>{mod.title}</strong>
      <small>{mod.Summary ? <mod.Summary /> : null}</small>
      <Icon className="tile-icon" size={40} strokeWidth={1.8} style={{ color: mod.color }} />
    </button>
  );
}

function TodayCard() {
  const agenda = useDayAgenda();
  const items = agenda(today());
  return (
    <button className="card today-card" onClick={() => navigate('/m/calendar')}>
      <div className="today-date">
        <small>{capitalize(fmt(new Date(), { weekday: 'long' }))}</small>
        <strong>{fmt(new Date(), { day: 'numeric', month: 'long' })}</strong>
      </div>
      {items.length ? (
        <AgendaList items={items.slice(0, 3)} />
      ) : (
        <p className="muted">Rien de prévu aujourd'hui. Profitez-en !</p>
      )}
      {items.length > 3 && <small className="muted">+ {items.length - 3} autre(s)</small>}
    </button>
  );
}

export function HomePage() {
  const { family, member } = useMe();
  const ids = family.settings.homeModules ?? DEFAULT_HOME;
  const mods = ids.map(moduleById).filter((m): m is ModuleDef => !!m);

  return (
    <div className="page home">
      <header className="home-header">
        <h1>{family.name}</h1>
        <button className="avatar-btn" onClick={() => navigate('/m/family')} aria-label="Ma famille">
          <Avatar member={member} size={48} />
        </button>
      </header>
      <TodayCard />
      <div className="tiles">
        {mods.map((m) => (
          <Tile key={m.id} mod={m} />
        ))}
        <button className="tile tile-accent" onClick={() => navigate('/settings')}>
          <strong>Personnaliser</strong>
          <small>Mettez l'appli à votre goût</small>
          <Sparkles className="tile-icon" size={40} />
        </button>
      </div>
    </div>
  );
}
