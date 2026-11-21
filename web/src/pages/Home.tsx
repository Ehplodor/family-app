import { BellRing, Cloud, CloudOff, HardDrive, Sparkles, X } from 'lucide-react';
import { useDoc, useEngine, useLocalState, useMe, useNotifier, useSyncStatus } from '../store';
import type { Device } from '../lib/engine';
import { pushSupported } from '../lib/notify';
import { RELAY_URL } from '../lib/sync';
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

function SyncBadge() {
  const status = useSyncStatus();
  const label = { local: 'Sur cet appareil uniquement', connecting: 'Connexion…', online: 'Synchronisé, chiffré de bout en bout', offline: 'Hors ligne', denied: 'Accès refusé', closed: 'Cercle fermé' }[status];
  const Icon = status === 'local' ? HardDrive : status === 'online' ? Cloud : CloudOff;
  return (
    <button className={`sync-badge ${status}`} onClick={() => navigate('/security')} aria-label={label} title={label}>
      <Icon size={18} />
    </button>
  );
}

function PushBanner() {
  const engine = useEngine();
  const notifier = useNotifier();
  const device = useDoc<Device>('devices', engine.deviceId);
  const [dismissed, setDismissed] = useLocalState('pushBannerDismissed', false);
  if (!RELAY_URL || dismissed || device?.push || notifier.permission() === 'denied') return null;
  if (!pushSupported() && !/iPhone|iPad/.test(navigator.userAgent)) return null;
  return (
    <div className="card push-banner">
      <BellRing size={28} className="accent-text" />
      <button className="grow" onClick={() => navigate('/notifications')}>
        <strong>Activer les rappels</strong>
        <small className="block">Rendez-vous, anniversaires, tâches… même appli fermée.</small>
      </button>
      <button className="icon-btn subtle" onClick={() => setDismissed(true)} aria-label="Masquer">
        <X size={18} />
      </button>
    </div>
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
        <SyncBadge />
        <button className="avatar-btn" onClick={() => navigate('/m/family')} aria-label="Ma famille">
          <Avatar member={member} size={48} />
        </button>
      </header>
      <PushBanner />
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
