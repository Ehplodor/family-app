import { useEffect, useMemo, useRef, useState } from 'react';
import { AlarmClock, Moon } from 'lucide-react';
import type { Device } from '../lib/engine';
import {
  DAY_LETTERS,
  DEFAULT_SNOOZE,
  MODE_LABEL,
  daysLabel,
  isRight,
  makeChallenges,
  nextRing,
  ringsBetween,
  untilLabel,
  type Alarm,
  type AlarmMode,
} from '../lib/alarms';
import { alarmDoneAt, markAlarmDone } from '../lib/alarmState';
import { useCollection, useDoc, useEngine, useMe, useNotifier, type Doc } from '../store';
import { navigate } from '../router';
import { Empty, Fab, Field, FieldGroup, Page, Sheet, confirmDelete } from '../ui';

export type { Alarm };

/* ------------------------------------------------------------------ Données */

/** Mes réveils (les réveils des autres membres ne sont jamais affichés). */
function useMyAlarms() {
  const col = useCollection<Alarm>('alarms');
  const me = useMe();
  return { ...col, mine: col.docs.filter((a) => a.memberId === me.member.id) };
}

function useMyDevices() {
  const { docs } = useCollection<Device>('devices');
  const me = useMe();
  return docs.filter((d) => d.memberId === me.member.id && !d.revoked);
}

const hhmm = (ms: number) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

/* ------------------------------------------------------------------ Snoozes locaux (cet appareil) */

const SNOOZE_KEY = 'alarmSnoozes';
type LocalSnooze = { id: string; at: number };
function readSnoozes(): LocalSnooze[] {
  try {
    return JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? '[]') as LocalSnooze[];
  } catch {
    return [];
  }
}
function writeSnoozes(list: LocalSnooze[]) {
  try {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify(list.filter((s) => s.at > Date.now() - 3600_000)));
  } catch {
    /* stockage indisponible */
  }
}

/* ------------------------------------------------------------------ Tuile de l'accueil */

export function AlarmsSummary() {
  const engine = useEngine();
  const { mine } = useMyAlarms();
  const now = Date.now();
  const next = mine
    .filter((a) => a.deviceId === engine.deviceId)
    .map((a) => nextRing(a, now))
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b)[0];
  return <>{next ? `Prochain : ${hhmm(next)}` : 'Aucun réveil ici'}</>;
}

/* ------------------------------------------------------------------ Surveillance (appli ouverte) */

/**
 * Appli ouverte : vérifie chaque seconde si un réveil de CET appareil doit sonner,
 * et ouvre alors l'écran de sonnerie. Appli fermée, c'est la notification qui prend le relais.
 */
export function AlarmWatcher() {
  const engine = useEngine();
  const last = useRef(Date.now());
  useEffect(() => {
    const tick = async () => {
      const now = Date.now();
      const from = last.current;
      last.current = now;
      if (location.hash.includes('/alarms/ring/')) return;
      const mine = engine.replica.list<Alarm>('alarms').filter((a) => a.deviceId === engine.deviceId && a.memberId === engine.memberId);
      const due: LocalSnooze[] = [
        ...mine.flatMap((a) => ringsBetween(a, from, now).map((at) => ({ id: a.id, at }))),
        ...readSnoozes().filter((s) => s.at > from && s.at <= now),
      ];
      for (const d of due) {
        if ((await alarmDoneAt(d.id)) >= d.at) continue;
        navigate(`/m/alarms/ring/${d.id}/${d.at}`);
        return;
      }
    };
    const timer = setInterval(() => void tick(), 1000);
    return () => clearInterval(timer);
  }, [engine]);
  return null;
}

/* ------------------------------------------------------------------ Écran principal */

export function AlarmsPage({ params }: { params: string[] }) {
  if (params[0] === 'ring' && params[1]) return <RingScreen id={params[1]} at={Number(params[2]) || Date.now()} />;
  if (params[0] === 'chevet') return <Bedside />;
  return <AlarmList />;
}

function AlarmList() {
  const engine = useEngine();
  const me = useMe();
  const alarms = useMyAlarms();
  const devices = useMyDevices();
  const myDevice = useDoc<Device>('devices', engine.deviceId);
  const [editing, setEditing] = useState<Doc<Alarm> | 'new' | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const now = Date.now();
  const label = (id: string) => (id === engine.deviceId ? 'Sur cet appareil' : `Sur ${devices.find((d) => d.id === id)?.label ?? 'un autre appareil'}`);
  const groups = useMemo(() => {
    const map = new Map<string, Doc<Alarm>[]>();
    for (const a of [...alarms.mine].sort((x, y) => x.time.localeCompare(y.time))) {
      map.set(a.deviceId, [...(map.get(a.deviceId) ?? []), a]);
    }
    return [...map.entries()].sort(([a], [b]) => (a === engine.deviceId ? -1 : b === engine.deviceId ? 1 : 0));
  }, [alarms.mine, engine.deviceId]);

  const toggle = (a: Doc<Alarm>) => alarms.update(a.id, { enabled: !a.enabled, ...(!a.enabled && !a.days.length ? { armedAt: Date.now() } : {}) });

  return (
    <Page
      title="Réveils"
      actions={
        <button className="icon-btn" onClick={() => navigate('/m/alarms/chevet')} aria-label="Mode chevet">
          <Moon size={22} />
        </button>
      }
    >
      {!myDevice?.push && (
        <div className="card">
          <p className="muted">
            ⚠️ Les notifications ne sont pas activées sur cet appareil : ses réveils ne sonneront que si l'appli est ouverte.{' '}
            <button className="link" onClick={() => navigate('/notifications')}>
              Activer
            </button>
          </p>
        </div>
      )}
      {!alarms.mine.length && (
        <Empty icon={<AlarmClock size={48} />}>
          Vos réveils, propres à chaque appareil : votre téléphone sonne, pas votre ordinateur. Personne d'autre dans la famille ne les voit.
        </Empty>
      )}
      {groups.map(([deviceId, list]) => (
        <section key={deviceId}>
          <div className="section-title">
            <span>{label(deviceId)}</span>
          </div>
          <ul className="items">
            {list.map((a) => {
              const next = nextRing(a, now);
              return (
                <li key={a.id} className={`item alarm-row ${a.enabled ? '' : 'done'}`}>
                  <span className="grow" onClick={() => setEditing(a)}>
                    <span className="alarm-time">{a.time}</span>
                    <small className="block">
                      {[a.label, daysLabel(a.days), a.mode !== 'simple' && MODE_LABEL[a.mode], a.gentle && 'en douceur'].filter(Boolean).join(' · ')}
                      {next && ` · ${untilLabel(next, now)}`}
                    </small>
                  </span>
                  <input type="checkbox" className="switch" checked={a.enabled} onChange={() => toggle(a)} aria-label="Activer" />
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <details className="card alarm-help">
        <summary>Bon à savoir : appli fermée, comment ça sonne ?</summary>
        <p className="muted small">
          <b>Appli ouverte</b> (idéalement en <b>mode chevet</b>, icône lune) : vraie sonnerie en boucle, écran allumé, défis.
        </p>
        <p className="muted small">
          <b>Appli fermée</b> : une notification arrive à l'heure, avec le son et la vibration des notifications du téléphone, puis deux
          relances (3 et 6 min) si vous ne répondez pas. Pas de sonnerie continue : un site web ne peut pas faire sonner le téléphone comme
          l'appli Horloge. En mode Ne pas déranger ou Concentration, elle peut rester muette. Il faut aussi du réseau à l'heure du réveil.
        </p>
        <p className="muted small">
          Pour un réveil important, gardez l'alarme du téléphone en secours. Ouvrez l'appli au moins une fois par semaine pour que les
          réveils suivants soient programmés.
        </p>
      </details>

      <Fab onClick={() => setEditing('new')} label="Nouveau réveil" />
      <Sheet open={!!editing} title={editing === 'new' ? 'Nouveau réveil' : 'Modifier le réveil'} onClose={() => setEditing(null)}>
        {editing && (
          <AlarmForm
            initial={editing === 'new' ? undefined : editing}
            devices={devices}
            defaults={{ memberId: me.member.id, deviceId: engine.deviceId }}
            onSubmit={async (a) => {
              const data = { ...a, enabled: true, armedAt: Date.now() };
              if (editing === 'new') await alarms.create(data);
              else await alarms.update(editing.id, data);
              setEditing(null);
            }}
            onDelete={
              editing === 'new'
                ? undefined
                : () => {
                    if (confirmDelete('ce réveil')) {
                      alarms.remove(editing.id);
                      setEditing(null);
                    }
                  }
            }
          />
        )}
      </Sheet>
    </Page>
  );
}

function AlarmForm({
  initial,
  devices,
  defaults,
  onSubmit,
  onDelete,
}: {
  initial?: Alarm;
  devices: (Device & { id: string })[];
  defaults: { memberId: string; deviceId: string };
  onSubmit: (a: Alarm) => void;
  onDelete?: () => void;
}) {
  const [a, setA] = useState<Alarm>(
    initial ?? { ...defaults, time: '07:00', days: [], enabled: true, mode: 'simple', gentle: false, snoozeMin: DEFAULT_SNOOZE },
  );
  const set = (patch: Partial<Alarm>) => setA((x) => ({ ...x, ...patch }));
  const toggleDay = (d: number) => set({ days: a.days.includes(d) ? a.days.filter((x) => x !== d) : [...a.days, d].sort() });
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ ...a, label: a.label?.trim() || undefined });
      }}
    >
      <Field label="Heure">
        <input type="time" required className="alarm-time-input" value={a.time} onChange={(e) => set({ time: e.target.value })} />
      </Field>
      <FieldGroup label={`Répéter : ${daysLabel(a.days).toLowerCase()}`}>
        <div className="chips">
          {[1, 2, 3, 4, 5, 6, 0].map((d) => (
            <button key={d} type="button" className={`chip ${a.days.includes(d) ? 'on' : ''}`} onClick={() => toggleDay(d)}>
              {DAY_LETTERS[d]}
            </button>
          ))}
        </div>
      </FieldGroup>
      <Field label="Nom (option)">
        <input value={a.label ?? ''} placeholder="École, sport…" onChange={(e) => set({ label: e.target.value })} />
      </Field>
      <div className="row">
        <Field label="Pour l'arrêter">
          <select value={a.mode} onChange={(e) => set({ mode: e.target.value as AlarmMode })}>
            {Object.entries(MODE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Répétition">
          <select value={a.snoozeMin ?? DEFAULT_SNOOZE} onChange={(e) => set({ snoozeMin: Number(e.target.value) })}>
            {[5, 10, 15].map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </Field>
      </div>
      <label className="item toggle">
        <span className="grow">
          Réveil en douceur
          <small className="block">Le son monte peu à peu et l'écran s'éclaire comme une aube (appli ouverte).</small>
        </span>
        <input type="checkbox" checked={!!a.gentle} onChange={(e) => set({ gentle: e.target.checked })} />
      </label>
      {devices.length > 1 && (
        <Field label="Sonne sur">
          <select value={a.deviceId} onChange={(e) => set({ deviceId: e.target.value })}>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
                {d.id === defaults.deviceId ? ' (cet appareil)' : ''}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="form-actions">
        {onDelete && (
          <button type="button" className="btn danger" onClick={onDelete}>
            Supprimer
          </button>
        )}
        <button className="btn primary grow">Enregistrer</button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ Écran allumé, son, vibration */

type WakeLockLike = { release: () => Promise<void> };
function useWakeLock() {
  useEffect(() => {
    let lock: WakeLockLike | null = null;
    const nav = navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<WakeLockLike> } };
    const get = () => nav.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => {});
    void get();
    const onVis = () => document.visibilityState === 'visible' && void get();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release().catch(() => {});
    };
  }, []);
}

/** Contexte audio partagé : « débloqué » par un geste (mode chevet), il peut ensuite sonner seul. */
let audioCtx: AudioContext | null = null;
function audio(): AudioContext | null {
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

/** Bip-bip en boucle (généré, aucun fichier). En douceur : volume qui monte sur 60 s. */
function useAlarmSound(on: boolean, gentle: boolean, quiet: boolean) {
  const volume = useRef(1);
  volume.current = quiet ? 0.25 : 1;
  useEffect(() => {
    if (!on) return;
    const start = Date.now();
    const beep = () => {
      const ctx = audio();
      if (!ctx) return;
      const level = (gentle ? Math.min(1, 0.05 + (Date.now() - start) / 60_000) : 1) * volume.current * 0.6;
      for (const offset of [0, 0.25]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = gentle ? 'sine' : 'square';
        osc.frequency.value = gentle ? 660 : 880;
        const t = ctx.currentTime + offset;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(level, t + 0.02);
        gain.gain.linearRampToValueAtTime(0, t + 0.18);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.2);
      }
      navigator.vibrate?.([400]);
    };
    beep();
    const timer = setInterval(beep, 1000);
    // Un navigateur peut bloquer le son tant qu'on n'a pas touché l'écran : le premier toucher le débloque.
    const unlock = () => audio();
    window.addEventListener('pointerdown', unlock);
    return () => {
      clearInterval(timer);
      window.removeEventListener('pointerdown', unlock);
      navigator.vibrate?.(0);
    };
  }, [on, gentle]);
}

/* ------------------------------------------------------------------ Sonnerie */

async function closeAlarmNotifications(id: string) {
  const reg = await navigator.serviceWorker?.getRegistration();
  for (const n of (await reg?.getNotifications({ tag: `alarm-${id}` })) ?? []) n.close();
}

function RingScreen({ id, at }: { id: string; at: number }) {
  const engine = useEngine();
  const notifier = useNotifier();
  const alarm = useDoc<Alarm>('alarms', id);
  const [phase, setPhase] = useState<'ring' | 'challenge'>('ring');
  const [checked, setChecked] = useState(false);
  const [now, setNow] = useState(Date.now());
  const gentle = !!alarm?.gentle;
  useWakeLock();

  // Réveil déjà arrêté (notification ouverte en retard, autre onglet…) : on ne sonne pas.
  useEffect(() => {
    alarmDoneAt(id).then((done) => (done >= at ? leave() : setChecked(true)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, at]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useAlarmSound(checked && !!alarm, gentle, phase === 'challenge');

  const leave = () => location.replace('#/m/alarms');
  const finish = async () => {
    await markAlarmDone(id, at);
    await closeAlarmNotifications(id);
    if (alarm && !alarm.days.length) await engine.replica.update<Alarm>('alarms', id, { enabled: false });
    leave();
  };
  const snooze = async () => {
    if (!alarm) return;
    const next = Date.now() + (alarm.snoozeMin ?? DEFAULT_SNOOZE) * 60_000;
    await markAlarmDone(id, at);
    await closeAlarmNotifications(id);
    writeSnoozes([...readSnoozes(), { id, at: next }]);
    // Au cas où l'appli serait fermée d'ici là.
    if (engine.replica.get<Device>('devices', engine.deviceId)?.push) notifier.snoozeAlarm(alarm, next).catch(() => {});
    leave();
  };

  if (!alarm) {
    return (
      <Page title="Réveil" back="/m/alarms">
        <Empty>Ce réveil a été supprimé.</Empty>
      </Page>
    );
  }
  const elapsed = Math.max(0, now - at);
  const dawn = gentle ? Math.min(1, elapsed / 60_000) : 1;

  return (
    <div className={`ring-screen ${gentle ? 'gentle' : ''}`} style={{ ['--dawn' as string]: dawn }}>
      {phase === 'ring' ? (
        <>
          <button className="ring-snooze" onClick={snooze}>
            <span className="ring-clock">{hhmm(now)}</span>
            <span className="ring-label">{alarm.label || 'Réveil'}</span>
            <span className="ring-hint">Touchez n'importe où ici pour répéter dans {alarm.snoozeMin ?? DEFAULT_SNOOZE} min</span>
          </button>
          <SwipeUp label={alarm.mode === 'simple' ? 'Glisser vers le haut pour arrêter' : 'Glisser vers le haut pour le défi'} onDone={() => (alarm.mode === 'simple' ? finish() : setPhase('challenge'))} />
        </>
      ) : (
        <ChallengeView mode={alarm.mode} onSolved={finish} onBack={() => setPhase('ring')} />
      )}
    </div>
  );
}

function SwipeUp({ label, onDone }: { label: string; onDone: () => void }) {
  const [dy, setDy] = useState(0);
  const start = useRef<number | null>(null);
  const THRESHOLD = 140;
  return (
    <div
      className="ring-swipe"
      onPointerDown={(e) => {
        start.current = e.clientY;
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => start.current !== null && setDy(Math.min(0, e.clientY - start.current))}
      onPointerUp={() => {
        if (dy <= -THRESHOLD) onDone();
        start.current = null;
        setDy(0);
      }}
      onPointerCancel={() => {
        start.current = null;
        setDy(0);
      }}
    >
      <div className="ring-knob" style={{ transform: `translateY(${dy}px)`, opacity: 1 + dy / (THRESHOLD * 2) }}>
        ⌃
      </div>
      <span>{label}</span>
    </div>
  );
}

function ChallengeView({ mode, onSolved, onBack }: { mode: AlarmMode; onSolved: () => void; onBack: () => void }) {
  const [list, setList] = useState(() => makeChallenges(mode));
  const [i, setI] = useState(0);
  const [input, setInput] = useState('');
  const [wrong, setWrong] = useState(false);
  const c = list[i];
  if (!c) return null;
  return (
    <form
      className="ring-challenge"
      onSubmit={(e) => {
        e.preventDefault();
        if (isRight(c, input)) {
          setInput('');
          setWrong(false);
          if (i + 1 >= list.length) onSolved();
          else setI(i + 1);
        } else {
          // Erreur : on recommence avec de nouvelles questions (le cerveau doit vraiment s'allumer).
          setWrong(true);
          setInput('');
          setList(makeChallenges(mode));
          setI(0);
        }
      }}
    >
      <p className="ring-hint">
        {mode === 'math' ? `Calcul ${i + 1} sur ${list.length}` : 'Recopiez exactement :'}
      </p>
      <p className="ring-prompt">{c.prompt}{mode === 'math' ? ' = ?' : ''}</p>
      <input
        autoFocus
        inputMode={mode === 'math' ? 'numeric' : 'text'}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      {wrong && <p className="error">Raté ! Nouvelle série…</p>}
      <div className="form-actions">
        <button type="button" className="btn" onClick={onBack}>
          Retour
        </button>
        <button className="btn primary grow">Valider</button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ Mode chevet */

/** Écran allumé toute la nuit, horloge sombre : la sonnerie fonctionnera à coup sûr (appli ouverte). */
function Bedside() {
  const engine = useEngine();
  const { mine } = useMyAlarms();
  const [now, setNow] = useState(Date.now());
  useWakeLock();
  useEffect(() => {
    audio(); // l'ouverture du mode chevet est un geste : on débloque le son pour plus tard
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const next = mine
    .filter((a) => a.deviceId === engine.deviceId)
    .map((a) => nextRing(a, now))
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b)[0];
  return (
    <div className="bedside" onClick={() => location.replace('#/m/alarms')}>
      <span className="bedside-clock">{hhmm(now)}</span>
      <span className="bedside-next">{next ? `⏰ ${hhmm(next)} · ${untilLabel(next, now)}` : 'Aucun réveil programmé sur cet appareil'}</span>
      <span className="bedside-hint">Laissez l'appli ouverte et le téléphone branché. Touchez pour quitter.</span>
    </div>
  );
}
