import { useEffect, useState } from 'react';
import { Download, Lock, Share } from 'lucide-react';
import { useInstall } from '../lib/install';
import { RELAY_URL } from '../lib/sync';
import { Page } from '../ui';

type Limits = { quotaMb: number; quotaStartMb: number; quotaPerDayMb: number; inactiveDays: number };

/** Bouton « Installer l'appli » (ou instructions iPhone). Rien si déjà installée. */
export function InstallCard({ compact = false }: { compact?: boolean }) {
  const install = useInstall();
  if (install.installed || (!install.canPrompt && !install.iosHint)) return null;
  return (
    <div className={`card install ${compact ? 'compact' : ''}`}>
      <Download size={26} className="accent-text" />
      <div className="grow">
        <strong>Installer l'appli</strong>
        {install.iosHint ? (
          <small className="block">
            Dans Safari : bouton Partager <Share size={13} /> puis « Sur l'écran d'accueil ». Ouvrez ensuite l'appli depuis son icône.
          </small>
        ) : (
          <small className="block">Une icône sur l'écran d'accueil, plein écran, et les notifications.</small>
        )}
      </div>
      {install.canPrompt && (
        <button className="btn primary small" onClick={install.prompt}>
          Installer
        </button>
      )}
    </div>
  );
}

export function AboutPage({ back = '/', onBack }: { back?: string; onBack?: () => void }) {
  const [limits, setLimits] = useState<Limits | null>(null);
  useEffect(() => {
    if (RELAY_URL) fetch(`${RELAY_URL}/limits`).then((r) => r.json()).then(setLimits).catch(() => {});
  }, []);
  const months = limits ? Math.round(limits.inactiveDays / 30) : 13;

  return (
    <Page title="À propos" back={back} onBack={onBack}>
      <div className="card security-head">
        <Lock size={36} className="accent-text" />
        <div>
          <strong>Votre famille, vos données</strong>
          <p className="muted">
            Chaque famille crée son propre cercle. Les clés de chiffrement sont générées sur vos appareils et n'en sortent jamais : personne
            d'autre, ni la personne qui publie ce site, ni l'hébergeur, ne peut lire vos listes, messages ou photos.
          </p>
        </div>
      </div>

      <div className="card prose">
        <h3>Où sont mes données ?</h3>
        <p>
          <strong>Sur vos appareils</strong>, dans le stockage du navigateur. L'appli fonctionne même sans réseau.
        </p>
        {RELAY_URL ? (
          <p>
            Pour le partage et les rappels, des copies <strong>chiffrées de bout en bout</strong> transitent par un relais ({new URL(RELAY_URL).host}).
            Il ne voit que des données illisibles, leur taille et leur heure, ainsi que l'heure d'envoi des rappels.
          </p>
        ) : (
          <p>Ce site fonctionne en mode local : aucune donnée ne quitte l'appareil, mais il n'y a ni partage ni notifications.</p>
        )}

        <h3>Comment rejoindre une famille ?</h3>
        <p>
          Un membre de la famille affiche un QR code d'invitation (valable 15 minutes, à usage unique). Vous comparez un code de 5 émojis, il
          approuve, et votre appareil reçoit la clé.
        </p>

        {RELAY_URL && (
          <>
            <h3>Limites de ce service gratuit</h3>
            <ul>
              <li>
                Jusqu'à {limits?.quotaMb ?? 250} Mo d'espace partagé par famille, surtout pour les photos. Une nouvelle famille commence avec{' '}
                {limits?.quotaStartMb ?? 20} Mo, puis gagne {limits?.quotaPerDayMb ?? 10} Mo par jour : cela protège le service contre les abus.
              </li>
              <li>
                Une famille dont aucun appareil ne se connecte pendant {months} mois est effacée du relais. Les données restent sur les
                appareils, et sont renvoyées automatiquement si l'un d'eux se reconnecte.
              </li>
              <li>Service fourni gratuitement, sans garantie de disponibilité : faites de temps en temps une sauvegarde chiffrée (Sécurité).</li>
            </ul>
          </>
        )}

        <h3>Effacer mes données</h3>
        <p>
          Dans Ma Famille → Sécurité : « Effacer cet appareil » et « Effacer les données du relais ». Désinstaller l'appli et effacer les
          données du site dans le navigateur supprime aussi tout ce qui est sur l'appareil.
        </p>

        <h3>Code source</h3>
        <p>L'appli et le relais sont libres de consultation : leur fonctionnement peut être vérifié par tous.</p>
      </div>
    </Page>
  );
}
