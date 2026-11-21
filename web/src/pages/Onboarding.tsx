import { useState } from 'react';
import { HeartHandshake } from 'lucide-react';
import { api, type Me, type Member } from '../api';
import { useSession } from '../store';
import { ColorPicker, Field, PALETTE } from '../ui';

type Mode = 'choose' | 'create' | 'join';

export function Onboarding() {
  const { setMe } = useSession();
  const [mode, setMode] = useState<Mode>('choose');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [familyName, setFamilyName] = useState('');
  const [name, setName] = useState('');
  const [color, setColor] = useState(PALETTE[5]);
  const [code, setCode] = useState('');
  const [found, setFound] = useState<{ familyName: string; members: Member[] } | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur');
    } finally {
      setBusy(false);
    }
  };

  const create = () =>
    run(async () => setMe(await api<Me>('POST', '/families', { familyName, memberName: name, color })));
  const lookup = () => run(async () => setFound(await api('POST', '/join/lookup', { inviteCode: code })));
  const join = (memberId?: string) =>
    run(async () =>
      setMe(await api<Me>('POST', '/join', memberId ? { inviteCode: code, memberId } : { inviteCode: code, memberName: name, color })),
    );

  return (
    <div className="onboarding">
      <div className="onboarding-hero">
        <HeartHandshake size={64} />
        <h1>Notre famille</h1>
        <p>Listes, agenda, anniversaires, repas, messages… tout au même endroit, pour toute la famille.</p>
      </div>

      {mode === 'choose' && (
        <div className="stack">
          <button className="btn primary big" onClick={() => setMode('create')}>
            Créer notre espace famille
          </button>
          <button className="btn big" onClick={() => setMode('join')}>
            J'ai un code d'invitation
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

      {mode === 'join' && !found && (
        <form className="card form" onSubmit={(e) => (e.preventDefault(), lookup())}>
          <Field label="Code d'invitation">
            <input
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABCD-EFGH"
              autoCapitalize="characters"
              autoComplete="off"
              className="code-input"
            />
          </Field>
          {error && <p className="error">{error}</p>}
          <button className="btn primary" disabled={busy || code.replace(/[^A-Za-z0-9]/g, '').length < 8}>
            Continuer
          </button>
          <button type="button" className="link" onClick={() => setMode('choose')}>
            Retour
          </button>
        </form>
      )}

      {mode === 'join' && found && (
        <div className="card form">
          <h2>Rejoindre « {found.familyName} »</h2>
          <p className="muted">Qui êtes-vous ?</p>
          <div className="chips">
            {found.members.map((m) => (
              <button key={m.id} className="chip on" style={{ background: m.color, borderColor: m.color }} onClick={() => join(m.id)} disabled={busy}>
                {m.name}
              </button>
            ))}
          </div>
          <p className="muted">… ou je suis nouveau :</p>
          <Field label="Votre prénom">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Votre couleur">
            <ColorPicker value={color} onChange={setColor} />
          </Field>
          {error && <p className="error">{error}</p>}
          <button className="btn primary" onClick={() => join()} disabled={busy || !name.trim()}>
            Rejoindre
          </button>
          <button type="button" className="link" onClick={() => setFound(null)}>
            Retour
          </button>
        </div>
      )}
    </div>
  );
}
