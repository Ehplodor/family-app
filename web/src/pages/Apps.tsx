import { Sparkles } from 'lucide-react';
import { navigate } from '../router';
import { MODULES } from '../modules';
import { IconBadge } from '../ui';

export function AppsPage() {
  const sections = [...new Set(MODULES.map((m) => m.section))];
  return (
    <div className="page apps">
      <button className="banner" onClick={() => navigate('/settings')}>
        <div>
          <h2>À votre goût</h2>
          <p>Choisissez les modules de l'accueil, leur ordre et la couleur de l'appli.</p>
        </div>
        <Sparkles size={56} />
      </button>
      {sections.map((s) => (
        <section key={s}>
          <h3 className="apps-title">{s}</h3>
          <div className="app-grid">
            {MODULES.filter((m) => m.section === s).map((m) => (
              <button key={m.id} className="app" onClick={() => navigate(`/m/${m.id}`)}>
                <IconBadge color={m.color} size={64}>
                  <m.icon size={32} />
                </IconBadge>
                <span>{m.title}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
