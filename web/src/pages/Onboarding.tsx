import { useCallback, useState } from 'react';
import { HeartHandshake, Lock } from 'lucide-react';
import { parseInviteLink } from '../lib/invite';
import { RELAY_URL } from '../lib/sync';
import { useCircles, useEngine } from '../store';
import { ColorPicker, Field, FieldGroup, PALETTE } from '../ui';
import { JoinWaiting } from './Join';
import { Scanner } from './Scanner';
import { AboutPage, InstallCard } from './About';

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
  const [about, setAbout] = useState(false);

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

  if (about) {
    return <AboutPage onBack={() => setAbout(false)} />;
  }

  return (
    <div className="onboarding">
      <Hero />
      <InstallCard />

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
          <button className="link" onClick={() => setAbout(true)}>
            À propos et confidentialité
          </button>
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
          <FieldGroup label="Votre couleur">
            <ColorPicker value={color} onChange={setColor} />
          </FieldGroup>
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

/** Après avoir rejoint : votre profil (prénom, couleur), visible par vos cercles. */
export function ChooseMember() {
  const engine = useEngine();
  const circles = useCircles();
  const [name, setName] = useState('');
  const [color, setColor] = useState(PALETTE[8]);
  const [error, setError] = useState('');
  const ready = circles.some((c) => c.writable);
  // Appareil de l'ancien format : son profil est repris automatiquement (lib/migrate.ts).
  const migrating = engine.replica.allRecords((x) => x.c === 'members' && x.id === engine.memberId).length > 0;

  return (
    <div className="onboarding">
      <Hero />
      <div className="card form">
        {!ready || migrating ? (
          <>
            <h2>{migrating ? 'Mise à jour…' : 'Bienvenue !'}</h2>
            <p className="muted">Réception de vos accès… Gardez l'appli ouverte sur l'appareil qui vous a invité quelques secondes.</p>
          </>
        ) : (
          <>
            <h2>Qui êtes-vous ?</h2>
            <Field label="Votre prénom">
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <FieldGroup label="Votre couleur">
              <ColorPicker value={color} onChange={setColor} />
            </FieldGroup>
            {error && <p className="error">{error}</p>}
            <button
              className="btn primary"
              disabled={!name.trim()}
              onClick={async () => {
                try {
                  await engine.saveProfile({ name: name.trim(), color });
                  await engine.registerDevice();
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              C'est parti
            </button>
          </>
        )}
      </div>
    </div>
  );
}
