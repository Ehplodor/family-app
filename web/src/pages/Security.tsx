import { useEffect, useState } from 'react';
import { Download, KeyRound, Lock, ShieldAlert, ShieldCheck, Smartphone, Upload } from 'lucide-react';
import type { Device } from '../lib/engine';
import { RELAY_URL } from '../lib/sync';
import { useCollection, useEngine, useMembers, useSyncStatus } from '../store';
import { Field, Page } from '../ui';

const STATUS_LABEL = {
  local: 'Mode local (aucun relais configuré)',
  connecting: 'Connexion au relais…',
  online: 'Synchronisé en temps réel',
  offline: 'Hors ligne : les modifications partiront dès le retour du réseau',
  denied: 'Accès refusé par le relais',
  closed: 'Ce cercle a été fermé (clé renouvelée)',
  full: "Espace de la famille plein sur le relais : supprimez des photos pour reprendre la synchronisation",
} as const;

export function SecurityPage() {
  const engine = useEngine();
  const status = useSyncStatus();
  const { byId } = useMembers();
  const { docs: devices } = useCollection<Device>('devices');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [withPhotos, setWithPhotos] = useState(true);
  const [importPass, setImportPass] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    engine.circleSafetyCode().then(setCode);
  }, [engine, engine.circle?.circleId]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setMsg('');
    try {
      await fn();
    } catch (err) {
      setMsg(`Erreur : ${err instanceof Error ? err.message : err}`);
    }
    setBusy('');
  };

  const revoke = (d: Device & { id: string }) => {
    if (!window.confirm(`Retirer « ${d.label} » (${byId(d.memberId)?.name ?? '?'}) ? Une nouvelle clé sera créée et transmise uniquement aux autres appareils.`)) return;
    run('Renouvellement de la clé…', async () => {
      await engine.rotateKey([d.id]);
      setMsg('Appareil retiré. Nouvelle clé en service.');
    });
  };

  const exportBackup = () =>
    run('Chiffrement de la sauvegarde…', async () => {
      const blob = await engine.exportBackup(pass, withPhotos);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `famille-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      setPass('');
      setPass2('');
      setMsg('Sauvegarde téléchargée. Gardez la phrase secrète en lieu sûr : sans elle, le fichier est illisible.');
    });

  const active = devices.filter((d) => !d.revoked);
  const revoked = devices.filter((d) => d.revoked);
  const passOk = pass.length >= 10 && pass === pass2;

  return (
    <Page title="Sécurité">
      {busy && <p className="banner-info">{busy}</p>}
      {msg && <p className="banner-info">{msg}</p>}

      <div className="card security-head">
        <ShieldCheck size={40} className="accent-text" />
        <div>
          <strong>Chiffré de bout en bout</strong>
          <p className="muted">
            Vos données sont stockées sur vos appareils. Ce qui transite par le relais est chiffré (AES-256-GCM) avec une clé que seuls les
            appareils du cercle possèdent.
          </p>
        </div>
      </div>

      <div className="card">
        <h3>État</h3>
        <p className={`status-dot ${status}`}>{STATUS_LABEL[status]}</p>
        {RELAY_URL && <small className="block">Relais : {new URL(RELAY_URL).host}</small>}
        {(engine.sync?.rejected ?? 0) > 0 && (
          <p className="error">
            <ShieldAlert size={16} /> {engine.sync!.rejected} paquet(s) illisible(s) ignoré(s) (clé différente ou données altérées).
          </p>
        )}
      </div>

      <div className="card center">
        <h3>Code du cercle</h3>
        <div className="safety">{code}</div>
        <p className="muted">Tous les appareils de la famille doivent afficher ce même code. S'il diffère, l'appareil n'est pas dans le même cercle.</p>
      </div>

      <h3 className="apps-title">Appareils ({active.length})</h3>
      <ul className="items">
        {active.map((d) => (
          <li key={d.id} className="item">
            <Smartphone size={22} />
            <span className="grow">
              {d.label}
              <small className="block">
                {byId(d.memberId)?.name ?? 'Membre inconnu'} · ajouté le {new Date(d.createdAt).toLocaleDateString('fr-FR')}
                {d.id === engine.deviceId ? ' · cet appareil' : ''}
                {d.push ? ' · notifications ✓' : ''}
              </small>
            </span>
            {d.id !== engine.deviceId && (
              <button className="btn small danger" onClick={() => revoke(d)} disabled={!!busy}>
                Retirer
              </button>
            )}
          </li>
        ))}
      </ul>
      {revoked.length > 0 && <p className="muted small">{revoked.length} appareil(s) retiré(s) : ils n'ont plus accès aux nouvelles données.</p>}
      <button
        className="btn wide"
        disabled={!!busy || !RELAY_URL}
        onClick={() =>
          window.confirm('Créer une nouvelle clé pour le cercle ? Tous les appareils actuels la recevront automatiquement.') &&
          run('Renouvellement de la clé…', async () => {
            await engine.rotateKey([]);
            setMsg('Nouvelle clé en service.');
          })
        }
      >
        <KeyRound size={18} /> Renouveler la clé du cercle
      </button>

      <h3 className="apps-title">Sauvegarde chiffrée</h3>
      <div className="card form">
        <p className="muted">Un fichier protégé par une phrase secrète (PBKDF2 600 000 itérations + AES-256-GCM), à garder hors du téléphone.</p>
        <Field label="Phrase secrète (10 caractères minimum)">
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="Confirmer">
          <input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" />
        </Field>
        <label className="toggle">
          <input type="checkbox" checked={withPhotos} onChange={(e) => setWithPhotos(e.target.checked)} /> Inclure les photos
        </label>
        <button className="btn primary" disabled={!passOk || !!busy} onClick={exportBackup}>
          <Download size={18} /> Télécharger la sauvegarde
        </button>
        <hr />
        <Field label="Restaurer une sauvegarde">
          <input type="file" accept="application/json,.json" onChange={(e) => setImportFile(e.target.files?.[0] ?? null)} />
        </Field>
        <Field label="Phrase secrète de la sauvegarde">
          <input type="password" value={importPass} onChange={(e) => setImportPass(e.target.value)} />
        </Field>
        <button
          className="btn"
          disabled={!importFile || !importPass || !!busy}
          onClick={() =>
            run('Restauration…', async () => {
              await engine.importBackup(importPass, importFile!);
              setMsg('Sauvegarde restaurée et fusionnée avec les données actuelles.');
            })
          }
        >
          <Upload size={18} /> Restaurer
        </button>
      </div>

      <button className="btn ghost wide" onClick={() => (location.hash = '#/about')}>
        À propos et confidentialité
      </button>

      <h3 className="apps-title">Zone sensible</h3>
      <div className="stack">
        <button
          className="btn danger wide"
          disabled={!!busy || !RELAY_URL}
          onClick={() =>
            window.confirm(
              "Effacer tout ce que le relais détient pour ce cercle ? Les appareils connectés renverront leurs données : à utiliser pour fermer définitivement le cercle, après avoir effacé les autres appareils.",
            ) && run('Effacement…', async () => (await engine.wipeRelay(), setMsg('Données du relais effacées.')))
          }
        >
          Effacer les données du relais
        </button>
        <button
          className="btn danger wide"
          onClick={() =>
            window.confirm('Effacer TOUTES les données de cet appareil ? (Les autres membres gardent les leurs.)') &&
            run('Effacement…', async () => {
              await engine.wipeDevice();
              location.replace(location.pathname);
            })
          }
        >
          <Lock size={18} /> Effacer cet appareil
        </button>
      </div>
    </Page>
  );
}
