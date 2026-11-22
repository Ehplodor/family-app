/**
 * Famille encore à l'ancien format : l'admin lance la mise à jour ; les autres appareils attendent
 * (ils suivront automatiquement). Voir lib/migrate.ts.
 */
import { useState } from 'react';
import { HeartHandshake, ShieldCheck } from 'lucide-react';
import { useEngine, useSyncStatus } from '../store';
import { migrationAdmin, startMigration } from '../lib/migrate';

export function MigrationScreen() {
  const engine = useEngine();
  const status = useSyncStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [force, setForce] = useState(false);
  const r = engine.replica;
  const admin = migrationAdmin(r);
  const adminName = String((admin && r.allRecords((x) => x.c === 'members' && x.id === admin)[0]?.f.name?.v) || "l'admin de la famille");
  const isAdmin = !!engine.memberId && engine.memberId === admin;

  const go = async () => {
    setBusy(true);
    setError('');
    try {
      await startMigration(engine);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="onboarding">
      <div className="onboarding-hero">
        <HeartHandshake size={64} />
        <h1>Mise à jour de la famille</h1>
      </div>
      <div className="card form">
        <p>
          Cette version range tout dans des <b>cercles</b> (« Famille », « Moi seul »…), et chaque modification est
          <b> signée</b> par l'appareil qui la fait. Les appareils qui ne sont pas encore à jour ne pourront plus échanger
          avec la famille tant qu'ils n'auront pas été mis à jour (il suffit d'ouvrir l'appli).
        </p>
        {isAdmin || force ? (
          <>
            <p>
              <ShieldCheck size={16} /> {isAdmin ? 'Vous êtes' : 'Vous allez devenir'} l'<b>admin</b> du cercle « Famille » : vous
              seul pourrez inviter, faire entrer ou exclure quelqu'un. Une <b>masterkey</b> vous sera affichée ensuite : rangez-la
              dans un gestionnaire de mots de passe.
            </p>
            {error && <p className="error">{error}</p>}
            <button className="btn primary" disabled={busy || status !== 'online'} onClick={go}>
              {busy ? 'Mise à jour en cours…' : 'Mettre à jour la famille'}
            </button>
            {status !== 'online' && <p className="muted small">En attente de connexion au relais…</p>}
          </>
        ) : (
          <>
            <p className="muted">
              En attente de la mise à jour par <b>{adminName}</b>. Dès qu'il ou elle aura ouvert la nouvelle version et lancé la
              mise à jour, cet appareil suivra tout seul.
            </p>
            <details className="small">
              <summary>{adminName} n'utilise plus l'appli ?</summary>
              <p className="muted">
                Vous pouvez lancer la mise à jour à sa place : vous deviendrez alors l'admin du cercle « Famille ». À ne faire que si
                vous êtes sûr qu'il ou elle ne le fera pas.
              </p>
              <button className="btn" onClick={() => confirm(`Lancer la mise à jour à la place de ${adminName} ?`) && setForce(true)}>
                Je m'en occupe
              </button>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
