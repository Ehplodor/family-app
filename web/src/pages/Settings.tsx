import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check } from 'lucide-react';
import type { FamilySettings } from '../lib/engine';
import { useEngine, useLocalState, useMe } from '../store';
import {
  applyDisplayPrefs,
  loadPrefs,
  TEXT_SIZE_KEY,
  TEXT_SIZES,
  THEME_KEY,
  THEMES,
  type TextSize,
  type ThemeId,
} from '../lib/theme';
import { DEFAULT_HOME, MODULES } from '../modules';
import { ColorPicker, Field, FieldGroup, IconBadge, Page } from '../ui';
import { MemberForm } from './Family';

export const DEFAULT_ACCENT = '#8E5CE6';

/** Thème et taille du texte : réglages de cet appareil uniquement (stockage local, non partagés). */
function DisplaySettings() {
  const initial = loadPrefs();
  const [theme, setTheme] = useLocalState<ThemeId>(THEME_KEY, initial.theme);
  const [textSize, setTextSize] = useLocalState<TextSize>(TEXT_SIZE_KEY, initial.textSize);
  useEffect(() => applyDisplayPrefs({ theme, textSize }), [theme, textSize]);
  return (
    <>
      <h3 className="apps-title">Affichage</h3>
      <p className="muted">Propre à cet appareil : chacun choisit ce qui convient à ses yeux.</p>
      <div className="theme-grid" role="radiogroup" aria-label="Thème">
        {THEMES.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={theme === t.id}
            className={`theme-card ${theme === t.id ? 'on' : ''}`}
            onClick={() => setTheme(t.id)}
          >
            <span className="theme-preview" style={{ background: t.preview.bg }} aria-hidden="true">
              <span className="theme-preview-card" style={{ background: t.preview.surface }}>
                <i style={{ background: t.preview.text }} />
                <i style={{ background: t.preview.text, width: '55%', opacity: 0.6 }} />
                <b style={{ background: t.preview.accent ?? 'var(--accent)' }} />
              </span>
              {theme === t.id && (
                <span className="theme-check">
                  <Check size={14} strokeWidth={3} />
                </span>
              )}
            </span>
            <strong>{t.name}</strong>
            <small>{t.description}</small>
          </button>
        ))}
      </div>
      <div className="card form">
        <FieldGroup label="Taille du texte">
          <div className="size-picker">
            {TEXT_SIZES.map((s) => (
              <button key={s.id} type="button" className={textSize === s.id ? 'on' : ''} aria-pressed={textSize === s.id} onClick={() => setTextSize(s.id)}>
                <span style={{ fontSize: 14 * s.scale }}>{s.name}</span>
              </button>
            ))}
          </div>
        </FieldGroup>
      </div>
    </>
  );
}

export function SettingsPage() {
  const me = useMe();
  const engine = useEngine();
  const [name, setName] = useState(me.family.name);
  const settings = me.family.settings;
  const home = settings.homeModules ?? DEFAULT_HOME;

  /** Le nom affiché est celui du cercle partagé principal ; les autres réglages sont un élément commun. */
  const save = async (patch: { name?: string; settings?: Omit<FamilySettings, 'name'> }) => {
    if (patch.name) {
      const main = engine.vault.circles().filter((c) => !c.personal && c.writable).sort((a, b) => b.members.length - a.members.length)[0];
      if (main) await engine.vault.updateCircle(main.id, { name: patch.name });
    }
    if (patch.settings) await engine.data.upsert<FamilySettings>('settings', 'family', patch.settings);
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
        <FieldGroup label="Couleur de l'appli">
          <ColorPicker value={settings.accent ?? DEFAULT_ACCENT} onChange={(accent) => save({ settings: { accent } })} />
        </FieldGroup>
      </div>

      <DisplaySettings />

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
          onSubmit={(m) => engine.saveProfile(m)}
        />
      </div>
    </Page>
  );
}
