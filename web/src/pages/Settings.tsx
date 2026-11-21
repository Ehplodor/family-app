import { useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { api, type FamilySettings } from '../api';
import { useMe, useSession } from '../store';
import { DEFAULT_HOME, MODULES } from '../modules';
import { ColorPicker, Field, IconBadge, Page } from '../ui';
import { InviteCard, MemberForm } from './Family';

export const DEFAULT_ACCENT = '#8E5CE6';

export function SettingsPage() {
  const me = useMe();
  const { refresh, setMe } = useSession();
  const [name, setName] = useState(me.family.name);
  const settings = me.family.settings;
  const home = settings.homeModules ?? DEFAULT_HOME;

  const save = async (patch: { name?: string; settings?: FamilySettings }) => {
    // Affichage immédiat, puis confirmation par le serveur.
    setMe({
      ...me,
      family: { ...me.family, name: patch.name ?? me.family.name, settings: { ...me.family.settings, ...patch.settings } },
    });
    try {
      await api('PATCH', '/family', patch);
    } finally {
      refresh();
    }
  };

  // Ordre affiché : d'abord les modules de l'accueil (dans leur ordre), puis les autres.
  const ordered = [...home.filter((id) => MODULES.some((m) => m.id === id)), ...MODULES.map((m) => m.id).filter((id) => !home.includes(id))];

  const toggle = (id: string) =>
    save({ settings: { homeModules: home.includes(id) ? home.filter((x) => x !== id) : [...home, id] } });
  const move = (id: string, dir: -1 | 1) => {
    const list = [...home];
    const i = list.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    save({ settings: { homeModules: list } });
  };

  return (
    <Page title="Personnaliser">
      <div className="card form">
        <Field label="Nom de la famille">
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== me.family.name && save({ name })} />
        </Field>
        <Field label="Couleur de l'appli">
          <ColorPicker value={settings.accent ?? DEFAULT_ACCENT} onChange={(accent) => save({ settings: { accent } })} />
        </Field>
      </div>

      <h3 className="apps-title">Accueil</h3>
      <p className="muted">Cochez les modules à afficher sur l'accueil et réglez leur ordre. Tous restent accessibles depuis l'onglet Applications.</p>
      <ul className="items">
        {ordered.map((id) => {
          const m = MODULES.find((x) => x.id === id)!;
          const on = home.includes(id);
          return (
            <li key={id} className="item">
              <IconBadge color={m.color} size={36}>
                <m.icon size={20} />
              </IconBadge>
              <label className="grow toggle">
                <input type="checkbox" checked={on} onChange={() => toggle(id)} />
                {m.title}
              </label>
              {on && (
                <>
                  <button className="icon-btn subtle" onClick={() => move(id, -1)} aria-label="Monter">
                    <ArrowUp size={18} />
                  </button>
                  <button className="icon-btn subtle" onClick={() => move(id, 1)} aria-label="Descendre">
                    <ArrowDown size={18} />
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ul>
      <button className="btn ghost wide" onClick={() => save({ settings: { homeModules: DEFAULT_HOME } })}>
        Rétablir l'accueil par défaut
      </button>

      <h3 className="apps-title">Mon profil</h3>
      <div className="card">
        <MemberForm
          key={`${me.member.name}${me.member.color}`}
          initial={me.member}
          onSubmit={async (m) => {
            await api('PATCH', `/members/${me.member.id}`, m);
            refresh();
          }}
        />
      </div>

      <InviteCard />
    </Page>
  );
}
