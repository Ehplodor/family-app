/**
 * Choix des calendriers affichés dans l'agenda (réglage propre à chaque appareil)
 * (un calque par cercle, plus les calendriers intégrés et importés) et gestion des calendriers importés (.ics),
 * partagés avec les cercles choisis.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { Lock, Users } from 'lucide-react';
import { useCircles, useCollection, useDefaultGroups, useEngine } from '../store';
import { ColorPicker, Field, PALETTE, confirmDelete } from '../ui';
import { normalizeIcsUrl, parseIcs, SCHOOL_DATA_UNTIL, type ImportedCalendar, type Zone } from '../lib/calendars';
import { RELAY_URL } from '../lib/sync';
import { fmt, today } from '../dates';
import type { Doc } from '../store';

/* ------------------------------------------------------------------ Préférences (par appareil) */

export type CalendarPrefs = { hidden: string[]; zone: Zone | '' };
const PREFS_KEY = 'calendars.prefs';
// Par défaut : tout est affiché, sauf les vacances scolaires (il faut choisir sa zone).
const DEFAULT_PREFS: CalendarPrefs = { hidden: ['vacances'], zone: '' };
const listeners = new Set<() => void>();
let prefs: CalendarPrefs = (() => {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<CalendarPrefs>) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
})();

export function setCalendarPrefs(patch: Partial<CalendarPrefs>) {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* stockage indisponible : réglage gardé en mémoire */
  }
  listeners.forEach((l) => l());
}

export function useCalendarPrefs(): CalendarPrefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => prefs,
  );
}

export const isShown = (p: CalendarPrefs, id: string) => !p.hidden.includes(id);

/** Calque d'un cercle : ses événements sont affichés sauf si l'utilisateur l'a décoché sur cet appareil. */
export const circleLayer = (circleId: string) => `cercle:${circleId}`;

/**
 * Un événement est affiché si au moins un des cercles qui le voient est coché. Un événement sans cercle connu
 * de cet appareil (cas improbable) reste affiché : mieux vaut trop montrer que perdre un rendez-vous.
 */
export function eventShown(p: CalendarPrefs, groups: string[] | undefined, known: (id: string) => boolean): boolean {
  const mine = (groups ?? []).filter(known);
  return !mine.length || mine.some((g) => isShown(p, circleLayer(g)));
}
const toggleShown = (p: CalendarPrefs, id: string) =>
  setCalendarPrefs({ hidden: isShown(p, id) ? [...p.hidden, id] : p.hidden.filter((h) => h !== id) });

export const HOLIDAY_COLOR = '#5B6470';
export const VACATION_COLOR = '#12A594';

/* ------------------------------------------------------------------ Abonnements */

const REFRESH_MS = 6 * 3600_000;

/** Télécharge un calendrier en ligne via le relais (voir relay/src/ics.ts). */
async function downloadIcs(circle: { circleId: string; token: string } | null, url: string): Promise<string> {
  if (!RELAY_URL || !circle) throw new Error('Les abonnements nécessitent le relais');
  const res = await fetch(`${RELAY_URL}/c/${circle.circleId}/ics`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${circle.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Erreur ${res.status}`);
  return res.text();
}

/** Met à jour, en arrière-plan, les abonnements qui n'ont pas été rafraîchis depuis 6 h. */
export function useRefreshSubscriptions() {
  const engine = useEngine();
  const cals = useCollection<ImportedCalendar>('calendars');
  const busy = useRef(new Set<string>());
  useEffect(() => {
    if (engine.sync?.status !== 'online') return;
    for (const c of cals.docs) {
      if (!c.url || busy.current.has(c.id)) continue;
      if (c.fetchedAt && Date.now() - Date.parse(c.fetchedAt) < REFRESH_MS) continue;
      busy.current.add(c.id);
      refresh(engine.circle, c, cals.update).finally(() => busy.current.delete(c.id));
    }
  }, [cals.docs, engine]);
}

async function refresh(
  circle: { circleId: string; token: string } | null,
  c: Doc<ImportedCalendar>,
  update: (id: string, patch: Partial<ImportedCalendar>) => unknown,
) {
  try {
    const { events } = parseIcs(await downloadIcs(circle, c.url!), today());
    await update(c.id, { events, fetchedAt: new Date().toISOString(), error: '' });
  } catch (e) {
    await update(c.id, { fetchedAt: new Date().toISOString(), error: (e as Error).message });
  }
}

/* ------------------------------------------------------------------ Écran « Calendriers » */

// L'ancien calque « Calendrier de la famille » (id 'main') regroupait tous les événements : il est remplacé par un
// calque par cercle. Une ancienne préférence 'main' est simplement ignorée.
const BUILT_IN = [
  { id: 'birthdays', name: 'Anniversaires', color: '#F2784B' },
  { id: 'school', name: 'École (contrôles, exposés…)', color: '#E5484D' },
  { id: 'holidays', name: 'Jours fériés (France)', color: HOLIDAY_COLOR },
];

export function CalendarsSheet() {
  const p = useCalendarPrefs();
  const engine = useEngine();
  const cals = useCollection<ImportedCalendar>('calendars');
  const circles = [...useCircles()].sort((a, b) => (a.personal ? -1 : 0) - (b.personal ? -1 : 0));
  const defaults = useDefaultGroups();
  const sharedWith = circles.filter((c) => defaults.includes(c.id)).map((c) => (c.personal ? 'Moi seul' : c.name));
  const [adding, setAdding] = useState<'url' | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const nextColor = PALETTE[(cals.docs.length * 5 + 3) % PALETTE.length];

  const importFile = async (file: File) => {
    setError('');
    try {
      const { name, events } = parseIcs(await file.text(), today());
      await cals.create({ name: name || file.name.replace(/\.ics$/i, ''), color: nextColor, events, fetchedAt: new Date().toISOString() });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="form">
      <p className="muted small">Cochez les calendriers à afficher sur cet appareil.</p>
      <ul className="cal-list">
        {circles.map((c) => (
          <li key={c.id}>
            <label className="toggle">
              <input type="checkbox" checked={isShown(p, circleLayer(c.id))} onChange={() => toggleShown(p, circleLayer(c.id))} />
              <i className="cal-swatch" style={{ background: c.color }} />
              <span className="grow">
                {c.personal ? <Lock size={14} /> : <Users size={14} />} {c.personal ? 'Moi seul' : c.name}
              </span>
            </label>
          </li>
        ))}
        {BUILT_IN.map((c) => (
          <li key={c.id}>
            <label className="toggle">
              <input type="checkbox" checked={isShown(p, c.id)} onChange={() => toggleShown(p, c.id)} />
              <i className="cal-swatch" style={{ background: c.color }} />
              <span className="grow">{c.name}</span>
            </label>
          </li>
        ))}
        <li>
          <label className="toggle">
            <input
              type="checkbox"
              checked={isShown(p, 'vacances')}
              onChange={() => {
                toggleShown(p, 'vacances');
                if (!p.zone) setCalendarPrefs({ zone: 'C' });
              }}
            />
            <i className="cal-swatch" style={{ background: VACATION_COLOR }} />
            <span className="grow">Vacances scolaires</span>
          </label>
          {isShown(p, 'vacances') && (
            <select className="cal-zone" value={p.zone || 'C'} onChange={(e) => setCalendarPrefs({ zone: e.target.value as Zone })}>
              <option value="A">Zone A (Lyon, Bordeaux, Grenoble…)</option>
              <option value="B">Zone B (Lille, Nantes, Strasbourg…)</option>
              <option value="C">Zone C (Paris, Montpellier, Toulouse)</option>
            </select>
          )}
        </li>
        {cals.docs.map((c) => (
          <li key={c.id}>
            <label className="toggle">
              <input type="checkbox" checked={isShown(p, c.id)} onChange={() => toggleShown(p, c.id)} />
              <i className="cal-swatch" style={{ background: c.color }} />
              <span className="grow">
                {c.name}
                <small className="muted">
                  {' '}
                  · {c.url ? 'abonnement' : 'fichier'} · {(c.events ?? []).length} év.
                  {c.error ? ` · ⚠️ ${c.error}` : ''}
                </small>
              </span>
            </label>
            <button type="button" className="btn small" onClick={() => setEditing(editing === c.id ? null : c.id)}>
              Modifier
            </button>
            {editing === c.id && (
              <EditImported
                cal={c}
                onSave={(patch) => cals.update(c.id, patch)}
                onRefresh={() => refresh(engine.circle, c, cals.update)}
                onDelete={() => {
                  if (confirmDelete(`le calendrier « ${c.name} » (pour tous ceux qui le voient)`)) {
                    cals.remove(c.id);
                    setEditing(null);
                  }
                }}
              />
            )}
          </li>
        ))}
      </ul>
      {p.zone && isShown(p, 'vacances') && today() > SCHOOL_DATA_UNTIL && (
        <p className="muted small">Les vacances scolaires ne sont connues que jusqu'au {fmt(SCHOOL_DATA_UNTIL, { dateStyle: 'long' })}.</p>
      )}

      <h3>Ajouter un calendrier</h3>
      <p className="muted small">
        Un calendrier ajouté est visible par {sharedWith.length > 1 ? 'les cercles' : 'le cercle'} {sharedWith.join(', ') || '—'}, comme
        vos nouveaux éléments (chiffré, comme le reste).
      </p>
      <input
        ref={fileInput}
        type="file"
        accept=".ics,text/calendar"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importFile(f);
          e.target.value = '';
        }}
      />
      <div className="form-actions">
        <button type="button" className="btn grow" onClick={() => fileInput.current?.click()}>
          Importer un .ics
        </button>
        <button type="button" className="btn grow" onClick={() => setAdding(adding ? null : 'url')} disabled={!RELAY_URL}>
          S'abonner (adresse)
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {adding === 'url' && (
        <SubscribeForm
          onSubmit={async (name, url) => {
            const c = await cals.create({ name, url, color: nextColor, events: [] });
            await refresh(engine.circle, c, cals.update);
            setAdding(null);
          }}
        />
      )}
      <details className="muted small">
        <summary>Où trouver l'adresse d'un calendrier ?</summary>
        <ul>
          <li>
            <b>Google Agenda</b> (sur ordinateur) : Paramètres → choisir l'agenda → « Adresse publique au format iCal » (agenda
            rendu public) ou « Adresse secrète au format iCal ».
          </li>
          <li>
            <b>Outlook / Hotmail</b> : Paramètres → Calendrier → Calendriers partagés → Publier un calendrier → copier le lien ICS.
          </li>
          <li>
            <b>iCloud (iPhone)</b> : appli Calendrier → (i) à côté du calendrier → Calendrier public → partager le lien (webcal://).
          </li>
          <li>
            <b>Club de sport, école, mairie</b> : cherchez « s'abonner », « iCal » ou « .ics » sur leur site (ex. calendriers
            des matchs).
          </li>
        </ul>
      </details>
    </div>
  );
}

function SubscribeForm({ onSubmit }: { onSubmit: (name: string, url: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = normalizeIcsUrl(url);
  return (
    <div className="card form">
      <p className="small">
        ⚠️ <b>Confidentialité</b> : pour télécharger ce calendrier, notre relais doit en lire l'adresse et le contenu (les sites
        de calendriers n'autorisent pas l'appli à le faire elle-même). Rien n'est conservé sur le relais, mais n'utilisez que des
        calendriers que vous acceptez de lui confier. Une « adresse secrète » Google donne accès à tout l'agenda : préférez
        l'import de fichier si c'est sensible.
      </p>
      <Field label="Nom">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Matchs de Léo, Agenda pro…" />
      </Field>
      <Field label="Adresse (https:// ou webcal://)">
        <input value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" placeholder="https://…/basic.ics" />
      </Field>
      <button
        type="button"
        className="btn primary"
        disabled={!valid || !name.trim() || busy}
        onClick={async () => {
          setBusy(true);
          await onSubmit(name.trim(), valid!).finally(() => setBusy(false));
        }}
      >
        {busy ? 'Téléchargement…' : "J'ai compris, m'abonner"}
      </button>
    </div>
  );
}

function EditImported({
  cal,
  onSave,
  onRefresh,
  onDelete,
}: {
  cal: Doc<ImportedCalendar>;
  onSave: (patch: Partial<ImportedCalendar>) => void;
  onRefresh: () => Promise<void>;
  onDelete: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="card form">
      <Field label="Nom">
        <input defaultValue={cal.name} onBlur={(e) => e.target.value.trim() && onSave({ name: e.target.value.trim() })} />
      </Field>
      <ColorPicker value={cal.color} onChange={(color) => onSave({ color })} />
      {cal.fetchedAt && <p className="muted small">Mis à jour le {fmt(new Date(cal.fetchedAt), { dateStyle: 'short', timeStyle: 'short' })}</p>}
      <div className="form-actions">
        <button type="button" className="btn danger" onClick={onDelete}>
          <Trash2 size={16} /> Supprimer
        </button>
        {cal.url && (
          <button
            type="button"
            className="btn grow"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onRefresh().finally(() => setBusy(false));
            }}
          >
            <RefreshCw size={16} /> {busy ? 'Mise à jour…' : 'Mettre à jour'}
          </button>
        )}
      </div>
    </div>
  );
}
