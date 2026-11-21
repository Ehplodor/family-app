import { useEffect } from 'react';
import { House, LayoutGrid } from 'lucide-react';
import { SessionProvider, useSession } from './store';
import { navigate, useRoute } from './router';
import { moduleById } from './modules';
import { Empty, Page } from './ui';
import { HomePage } from './pages/Home';
import { AppsPage } from './pages/Apps';
import { SettingsPage, DEFAULT_ACCENT } from './pages/Settings';
import { Onboarding } from './pages/Onboarding';

function BottomNav({ active }: { active: 'home' | 'apps' }) {
  return (
    <nav className="bottom-nav">
      <button className={active === 'home' ? 'on' : ''} onClick={() => navigate('/')} aria-label="Accueil">
        <House size={28} />
      </button>
      <button className={active === 'apps' ? 'on' : ''} onClick={() => navigate('/apps')} aria-label="Applications">
        <LayoutGrid size={28} />
      </button>
    </nav>
  );
}

function Shell() {
  const { me } = useSession();
  const route = useRoute();
  const accent = me?.family.settings.accent ?? DEFAULT_ACCENT;

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accent);
  }, [accent]);

  useEffect(() => {
    if (me) document.title = me.family.name;
  }, [me]);

  // Remonter en haut de page à chaque changement d'écran.
  const key = route.join('/');
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [key]);

  const [first, second, ...rest] = route;
  if (!first) {
    return (
      <>
        <HomePage />
        <BottomNav active="home" />
      </>
    );
  }
  if (first === 'apps') {
    return (
      <>
        <AppsPage />
        <BottomNav active="apps" />
      </>
    );
  }
  if (first === 'settings') return <SettingsPage />;
  const mod = first === 'm' ? moduleById(second) : undefined;
  if (mod) return <mod.Page key={second} params={rest} />;
  return (
    <Page title="Introuvable">
      <Empty>Cette page n'existe pas.</Empty>
    </Page>
  );
}

function Gate() {
  const { status, refresh } = useSession();
  if (status === 'loading') return <div className="splash" />;
  if (status === 'anon') return <Onboarding />;
  if (status === 'offline') {
    return (
      <div className="onboarding">
        <Empty>Impossible de joindre le serveur. Vérifiez votre connexion.</Empty>
        <button className="btn primary" onClick={refresh}>
          Réessayer
        </button>
      </div>
    );
  }
  return <Shell />;
}

export function App() {
  return (
    <SessionProvider>
      <Gate />
    </SessionProvider>
  );
}
