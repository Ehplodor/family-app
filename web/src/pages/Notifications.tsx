import { useMemo, useState } from 'react';
import { BellOff, BellRing, Send } from 'lucide-react';
import type { Device } from '../lib/engine';
import { DEFAULT_PREFS, type NotifPrefs } from '../lib/reminders';
import { isIOS, isStandalone, prefsOf, pushSupported } from '../lib/notify';
import { RELAY_URL } from '../lib/sync';
import { useCollection, useDoc, useEngine, useMe, useNotifier } from '../store';
import { fmt } from '../dates';
import { Field, Page } from '../ui';

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="item toggle">
      <span className="grow">
        {label}
        {hint && <small className="block">{hint}</small>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function NotificationsPage() {
  const engine = useEngine();
  const notifier = useNotifier();
  const me = useMe();
  const myDevice = useDoc<Device>('devices', engine.deviceId);
  useCollection('prefs');
  const prefs = prefsOf(engine, me.member.id);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);
  // Recalcule l'aperçu quand les données changent.
  const events = useCollection('events').docs;
  const tasks = useCollection('tasks').docs;
  const birthdays = useCollection('birthdays').docs;
  const meals = useCollection('meals').docs;
  const upcoming = useMemo(() => notifier.upcomingForMe().slice(0, 8), [notifier, events, tasks, birthdays, meals, prefs]);

  const set = (patch: Partial<NotifPrefs>) => engine.replica.upsert<NotifPrefs>('prefs', me.member.id, patch);
  const run = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true);
    setError('');
    setInfo('');
    try {
      await fn();
      if (ok) setInfo(ok);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setBusy(false);
  };

  const permission = notifier.permission();
  const enabled = permission === 'granted' && !!myDevice?.push;

  return (
    <Page title="Rappels">
      <div className="card form">
        <h3>Sur cet appareil</h3>
        {!RELAY_URL ? (
          <p className="muted">Les notifications nécessitent le relais (non configuré). Les rappels sont visibles dans l'appli.</p>
        ) : !pushSupported() ? (
          isIOS() && !isStandalone() ? (
            <p className="muted">
              Sur iPhone, ajoutez d'abord l'appli à l'écran d'accueil (bouton Partager → « Sur l'écran d'accueil »), puis ouvrez-la depuis l'icône
              pour activer les notifications.
            </p>
          ) : (
            <p className="muted">Ce navigateur ne prend pas en charge les notifications push.</p>
          )
        ) : permission === 'denied' ? (
          <p className="muted">Les notifications sont bloquées. Autorisez-les dans les réglages du navigateur pour ce site, puis revenez ici.</p>
        ) : enabled ? (
          <>
            <p>
              <BellRing size={18} className="accent-text" /> Notifications activées, même appli fermée.
            </p>
            <div className="form-actions">
              <button className="btn grow" disabled={busy} onClick={() => run(() => notifier.test(), 'Notification de test envoyée.')}>
                <Send size={18} /> Tester
              </button>
              <button className="btn" disabled={busy} onClick={() => run(() => notifier.disable())}>
                <BellOff size={18} /> Désactiver
              </button>
            </div>
          </>
        ) : (
          <button className="btn primary" disabled={busy} onClick={() => run(() => notifier.enable(), 'Notifications activées.')}>
            <BellRing size={18} /> Activer les notifications
          </button>
        )}
        {error && <p className="error">{error}</p>}
        {info && <p className="muted">{info}</p>}
        <p className="muted small">
          Le contenu des notifications est chiffré : le relais connaît seulement l'heure d'envoi, ni le titre ni le texte.
        </p>
      </div>

      <h3 className="apps-title">Mes rappels</h3>
      <ul className="items">
        <Toggle label="Rendez-vous" hint="Avant chaque événement qui vous concerne" checked={prefs.events} onChange={(v) => set({ events: v })} />
        {prefs.events && (
          <li className="item">
            <span className="grow">Délai par défaut</span>
            <select value={prefs.eventLead} onChange={(e) => set({ eventLead: Number(e.target.value) })} className="inline">
              <option value={0}>À l'heure</option>
              <option value={10}>10 min</option>
              <option value={30}>30 min</option>
              <option value={60}>1 h</option>
              <option value={120}>2 h</option>
              <option value={1440}>La veille</option>
            </select>
          </li>
        )}
        <Toggle
          label="Résumé du matin"
          hint="Votre journée en une notification (seulement s'il y a quelque chose)"
          checked={!!prefs.digest}
          onChange={(v) => set({ digest: v ? DEFAULT_PREFS.digest : null })}
        />
        <Toggle label="Anniversaires" hint={`Le jour J et ${prefs.birthdayLeadDays} jours avant pour le cadeau`} checked={prefs.birthdays} onChange={(v) => set({ birthdays: v })} />
        <Toggle label="Tâches" hint="À l'échéance, puis une relance si elle est en retard" checked={prefs.tasks} onChange={(v) => set({ tasks: v })} />
        <Toggle label="Repas du lendemain" hint="La veille au soir (courses, décongélation…)" checked={prefs.meals} onChange={(v) => set({ meals: v })} />
        <Toggle label="Planning de la semaine" hint="Le dimanche si les repas ne sont pas prévus" checked={prefs.weeklyPlanning} onChange={(v) => set({ weeklyPlanning: v })} />
      </ul>

      <h3 className="apps-title">Activité de la famille</h3>
      <ul className="items">
        <Toggle label="Messages" checked={prefs.messages} onChange={(v) => set({ messages: v })} />
        <Toggle label="Listes" hint="Regroupé : « 5 ajouts à Courses »" checked={prefs.lists} onChange={(v) => set({ lists: v })} />
        <Toggle label="Agenda" hint="Quand on ajoute un événement qui vous concerne" checked={prefs.calendarChanges} onChange={(v) => set({ calendarChanges: v })} />
        <Toggle label="Photos" checked={prefs.photos} onChange={(v) => set({ photos: v })} />
      </ul>
      <p className="muted small">Les alertes de sécurité (nouvel appareil dans le cercle) sont toujours envoyées.</p>

      <h3 className="apps-title">Heures calmes</h3>
      <div className="card form">
        <p className="muted">Pendant ces heures, les notifications non urgentes attendent votre réveil. Les rendez-vous et tâches à heure fixe passent toujours.</p>
        <div className="row">
          <Field label="De">
            <input type="time" value={prefs.quietStart} onChange={(e) => set({ quietStart: e.target.value })} />
          </Field>
          <Field label="À">
            <input type="time" value={prefs.quietEnd} onChange={(e) => set({ quietEnd: e.target.value })} />
          </Field>
        </div>
        <div className="row">
          <Field label="Rappel tâches">
            <input type="time" value={prefs.taskHour} onChange={(e) => set({ taskHour: e.target.value })} />
          </Field>
          <Field label="Résumé du matin">
            <input type="time" value={prefs.digest ?? ''} disabled={!prefs.digest} onChange={(e) => set({ digest: e.target.value })} />
          </Field>
        </div>
      </div>

      <h3 className="apps-title">Prochains rappels</h3>
      {upcoming.length ? (
        <ul className="items">
          {upcoming.map((r) => (
            <li key={`${r.tag}-${r.at}`} className="item">
              <span className="grow">
                {r.title}
                <small className="block">
                  {fmt(new Date(r.at), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {r.body}
                </small>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Aucun rappel prévu dans les 14 prochains jours.</p>
      )}
    </Page>
  );
}
