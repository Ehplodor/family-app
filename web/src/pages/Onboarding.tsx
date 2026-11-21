import { useCallback, useEffect, useState } from 'react';
import { HeartHandshake, Lock } from 'lucide-react';
import { randomId } from '../lib/bytes';
import { parseInviteLink } from '../lib/invite';
import { RELAY_URL } from '../lib/sync';
import type { Member } from '../lib/engine';
import { useCollection, useEngine, useSyncStatus } from '../store';
import { ColorPicker, Field, PALETTE } from '../ui';
import { JoinWaiting } from './Join';
import { Scanner } from './Scanner';

type Mode = 'choose' | 'create' | 'join';

function Hero() {
  return (
    <div className="onboarding-hero">
      <HeartHandshake size={64} />
      <h1>Notre famille</h1>
      <p>Listes, agenda, anniversaires, repas, messages… gardés sur vos téléphones et partagés en privé, chiffrés de bout en bout.</p>
    </div>
  );
}

/** Lien d'invitation ouvert directement (#/join/…) : on le retire aussitôt de l'adresse. */
function inviteFromUrl(): Uint8Array<ArrayBuffer> | null {
  const s = parseInviteLink(location.hash);
  if (s) history.replaceState(null, '', `${location.pathname}#/`);
  return s;
}

export function Onboarding() {
  const engine = useEngine();
  const [initialInvite] = useState(inviteFromUrl);
  const [mode, setMode] = useState<Mode>(initialInvite ? 'join' : 'choose');
  const [invite, setInvite] = useState<Uint8Array<ArrayBuffer> | null>(initialInvite);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [familyName, setFamilyName] = useState('');
  const [name, setName] = useState('');
  const [color, setColor] = useState(PALETTE[5]);
  const [paste, setPaste] = useState('');
  const [scanning, setScanning] = useState(false);

  const onScan = useCallback((text: string) => {
    setScanning(false);
    const s = parseInviteLink(text);
    if (s) setInvite(s);
    else setError("Ce QR code n'est pas une invitation valide.");
  }, []);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      await engine.createCircle(familyName.trim(), name.trim(), color);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="onboarding">
      <Hero />

      {mode === 'choose' && (
        <div className="stack">
          <button className="btn primary big" onClick={() => setMode('create')}>
            Créer notre cercle familial
          </button>
          <button className="btn big" onClick={() => setMode('join')}>
            J'ai une invitation
          </button>
          <p className="muted center small">
            <Lock size={14} /> Vos données restent sur vos appareils.
            {RELAY_URL ? ' Le partage passe par un relais qui ne voit que des données chiffrées.' : ' (Mode local : aucun partage configuré.)'}
          </p>
        </div>
      )}

      {mode === 'create' && (
        <form className="card form" onSubmit={(e) => (e.preventDefault(), create())}>
          <Field label="Nom de la famille">
            <input autoFocus value={familyName} onChange={(e) => setFamilyName(e.target.value)} placeholder="Les Dupont" />
          </Field>
          <Field label="Votre prénom">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Votre couleur">
            <ColorPicker value={color} onChange={setColor} />
          </Field>
          {error && <p className="error">{error}</p>}
          <button className="btn primary" disabled={busy || !familyName.trim() || !name.trim()}>
            C'est parti
          </button>
          <button type="button" className="link" onClick={() => setMode('choose')}>
            Retour
          </button>
        </form>
      )}

      {mode === 'join' && invite && <JoinWaiting secret={invite} onCancel={() => (setInvite(null), setMode('choose'))} />}

      {mode === 'join' && !invite && (
        <div className="card form">
          <p className="muted">Demandez à un membre de la famille : Ma Famille → « Inviter / ajouter un appareil ».</p>
          {scanning ? (
            <Scanner onResult={onScan} />
          ) : (
            <button className="btn primary" onClick={() => setScanning(true)}>
              Scanner le QR code
            </button>
          )}
          <Field label="… ou collez le lien reçu">
            <input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="https://…#/join/…" autoComplete="off" />
          </Field>
          {error && <p className="error">{error}</p>}
          <button
            className="btn"
            disabled={!paste.trim()}
            onClick={() => {
              const s = parseInviteLink(paste);
              if (s) setInvite(s);
              else setError('Lien invalide');
            }}
          >
            Continuer
          </button>
          <button type="button" className="link" onClick={() => (setScanning(false), setMode('choose'))}>
            Retour
          </button>
        </div>
      )}
    </div>
  );
}

/** Après avoir rejoint un cercle : qui êtes-vous ? */
export function ChooseMember() {
  const engine = useEngine();
  const status = useSyncStatus();
  const { docs: members } = useCollection<Member>('members');
  const [name, setName] = useState('');
  const [color, setColor] = useState(PALETTE[8]);
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), 8000);
    return () => clearTimeout(t);
  }, []);

  const pick = async (id: string) => {
    await engine.setMember(id);
    await engine.registerDevice();
  };

  return (
    <div className="onboarding">
      <Hero />
      <div className="card form">
        <h2>Qui êtes-vous ?</h2>
        {!members.length && !waited && status !== 'online' ? (
          <p className="muted">Synchronisation des données de la famille…</p>
        ) : (
          <div className="chips">
            {members.map((m) => (
              <button key={m.id} className="chip on" style={{ background: m.color, borderColor: m.color }} onClick={() => pick(m.id)}>
                {m.name}
              </button>
            ))}
          </div>
        )}
        <p className="muted">… ou je suis nouveau :</p>
        <Field label="Votre prénom">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Votre couleur">
          <ColorPicker value={color} onChange={setColor} />
        </Field>
        <button
          className="btn primary"
          disabled={!name.trim()}
          onClick={async () => {
            const id = randomId();
            await engine.setMember(id);
            await engine.replica.upsert<Member>('members', id, { name: name.trim(), color });
            await engine.registerDevice();
          }}
        >
          Rejoindre
        </button>
      </div>
    </div>
  );
}
