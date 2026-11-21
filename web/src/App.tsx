import { useEffect } from 'react';
import { House, LayoutGrid } from 'lucide-react';
import { AppProvider, useApp, useEngine, useMe } from './store';
import { navigate, useRoute } from './router';
import { moduleById } from './modules';
import { Empty, Page } from './ui';
import { HomePage } from './pages/Home';
import { AppsPage } from './pages/Apps';
import { SettingsPage, DEFAULT_ACCENT } from './pages/Settings';
import { ChooseMember, Onboarding } from './pages/Onboarding';
import { SecurityPage } from './pages/Security';
import { NotificationsPage } from './pages/Notifications';

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
  const me = useMe();
  const route = useRoute();
  const accent = me.family.settings.accent ?? DEFAULT_ACCENT;

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', accent);
  }, [accent]);
  useEffect(() => {
    document.title = me.family.name;
  }, [me.family.name]);
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
  if (first === 'security') return <SecurityPage />;
  if (first === 'notifications') return <NotificationsPage />;
  if (first === 'join') {
    return (
      <Page title="Invitation">
        <Empty>Cet appareil fait déjà partie d'un cercle familial.</Empty>
      </Page>
    );
  }
  const mod = first === 'm' ? moduleById(second) : undefined;
  if (mod) return <mod.Page key={second} params={rest} />;
  return (
    <Page title="Introuvable">
      <Empty>Cette page n'existe pas.</Empty>
    </Page>
  );
}

function Removed() {
  const engine = useEngine();
  return (
    <div className="onboarding">
      <Empty>
        Cet appareil a été retiré du cercle familial : il ne reçoit plus les nouvelles données. Les données déjà présentes restent lisibles
        ici jusqu'à leur effacement.
      </Empty>
      <button
        className="btn danger"
        onClick={async () => {
          await engine.wipeDevice();
          location.replace(location.pathname);
        }}
      >
        Effacer cet appareil
      </button>
    </div>
  );
}

function Gate() {
  const { state, error } = useApp();
  // Clic sur une notification alors que l'appli est ouverte.
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === 'navigate' && typeof e.data.url === 'string') location.hash = e.data.url.replace(/^#/, '');
    };
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, []);

  if (error) return <div className="onboarding"><Empty>Impossible d'ouvrir le stockage local : {error}</Empty></div>;
  if (state === 'loading') return <div className="splash" />;
  if (state === 'setup') return <Onboarding />;
  if (state === 'choose-member') return <ChooseMember />;
  if (state === 'removed') return <Removed />;
  return <Shell />;
}

export function App() {
  return (
    <AppProvider>
      <Gate />
    </AppProvider>
  );
}
