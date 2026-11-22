import { useEffect, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Check, Copy, ShieldCheck, Share2 } from 'lucide-react';
import { useCircles, useEngine, useMembers } from '../store';
import { approveJoin, createInvitation, pollJoinRequest, requestSafetyCode, type Invitation, type JoinRequest } from '../lib/invite';
import { RELAY_URL } from '../lib/sync';
import { Empty } from '../ui';

function qrDataUrl(text: string) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(6, 2);
}

/** Contenu de la feuille « Inviter / ajouter un appareil ». */
export function InvitePanel({ onDone }: { onDone: () => void }) {
  const engine = useEngine();
  const [inv, setInv] = useState<Invitation | null>(null);
  const [req, setReq] = useState<(JoinRequest & { code: string }) | null>(null);
  const [state, setState] = useState<'waiting' | 'approving' | 'done' | 'expired'>('waiting');
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  const circles = useCircles();
  const { byId } = useMembers();
  // Qui arrive : un autre de mes appareils, une nouvelle personne, ou un nouvel appareil d'une personne de mes cercles.
  const adminOf = circles.filter((c) => c.isAdmin && !c.personal);
  const people = [...new Set(adminOf.flatMap((c) => c.members))].filter((m) => m !== engine.memberId);
  const [who, setWho] = useState<'me' | 'new' | string>('me');
  const [chosen, setChosen] = useState<string[]>([]);
  useEffect(() => {
    if (who === 'new') setChosen(adminOf.map((c) => c.id));
    else if (who !== 'me') setChosen(adminOf.filter((c) => c.members.includes(who)).map((c) => c.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [who]);

  useEffect(() => {
    createInvitation().then(setInv);
  }, []);

  // On interroge le relais toutes les 2 s jusqu'à recevoir une demande.
  useEffect(() => {
    if (!inv || req || state !== 'waiting') return;
    const timer = setInterval(async () => {
      setNow(Date.now());
      if (Date.now() > inv.expiresAt) return setState('expired');
      try {
        const r = await pollJoinRequest(inv);
        if (r) setReq({ ...r, code: await requestSafetyCode(inv.secret, r) });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [inv, req, state]);

  if (!RELAY_URL) return <Empty>Aucun relais n'est configuré : le partage entre appareils est désactivé (voir le README).</Empty>;
  if (!inv) return null;

  const share = async () => {
    const text = `Rejoins notre famille sur l'appli (lien valable 15 min, à usage unique) : ${inv.link}`;
    if (typeof navigator.share === 'function') await navigator.share({ text }).catch(() => {});
    else {
      await navigator.clipboard?.writeText(inv.link);
      setCopied(true);
    }
  };

  if (state === 'done') {
    return (
      <div className="form center">
        <ShieldCheck size={56} className="accent-text" />
        <p>
          <strong>{req?.label}</strong> a reçu ses accès. La synchronisation commence.
        </p>
        <button className="btn primary" onClick={onDone}>
          Terminé
        </button>
      </div>
    );
  }

  if (req) {
    return (
      <div className="form">
        <p>
          Demande reçue de <strong>{req.label}</strong>.
        </p>
        <div className="card center">
          <small>Code de vérification</small>
          <div className="safety">{req.code}</div>
          <p className="muted">Vérifiez que le nouvel appareil affiche exactement les mêmes émojis.</p>
        </div>
        <div className="chips">
          <button type="button" className={`chip ${who === 'me' ? 'on plain-on' : ''}`} onClick={() => setWho('me')}>
            Un autre de mes appareils
          </button>
          {adminOf.length > 0 && (
            <button type="button" className={`chip ${who === 'new' ? 'on plain-on' : ''}`} onClick={() => setWho('new')}>
              Une nouvelle personne
            </button>
          )}
          {people.map((m) => (
            <button key={m} type="button" className={`chip ${who === m ? 'on plain-on' : ''}`} onClick={() => setWho(m)}>
              Appareil de {byId(m)?.name ?? '?'}
            </button>
          ))}
        </div>
        {who !== 'me' && (
          <>
            <p className="muted small">Cercles où la faire entrer (vous en êtes l'admin) :</p>
            <div className="chips">
              {adminOf.map((c) => {
                const on = chosen.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`chip ${on ? 'on' : ''}`}
                    style={on ? { background: c.color, borderColor: c.color } : { borderColor: c.color }}
                    onClick={() => setChosen(on ? chosen.filter((x) => x !== c.id) : [...chosen, c.id])}
                  >
                    {c.name}
                  </button>
                );
              })}
            </div>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <div className="form-actions">
          <button className="btn danger" onClick={onDone}>
            Refuser
          </button>
          <button
            className="btn primary grow"
            disabled={state === 'approving' || (who !== 'me' && !chosen.length)}
            onClick={async () => {
              setState('approving');
              try {
                await approveJoin(engine, inv, req, who === 'me' ? 'me' : { member: who === 'new' ? undefined : who, circles: chosen });
                setState('done');
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                // Quelqu'un d'autre a répondu à l'invitation : le lien a probablement fuité.
                if (/déjà utilisée/.test(msg)) {
                  return setError(
                    "⚠️ Quelqu'un d'autre a déjà répondu à cette invitation : le lien a peut-être été intercepté. " +
                      "Sur le nouvel appareil, n'utilisez pas la famille qu'il affiche : effacez-le (Sécurité) et recommencez avec une nouvelle invitation, transmise en main propre.",
                  );
                }
                setError(msg);
                setState('waiting');
              }
            }}
          >
            <Check size={18} /> Les codes sont identiques
          </button>
        </div>
      </div>
    );
  }

  const left = Math.max(0, Math.round((inv.expiresAt - now) / 60_000));
  return (
    <div className="form center">
      {state === 'expired' ? (
        <Empty>Invitation expirée. Fermez et recommencez.</Empty>
      ) : (
        <>
          <p className="muted">Sur le nouvel appareil : ouvrez l'appli → « J'ai une invitation » → scannez ce code.</p>
          <img className="qr" src={qrDataUrl(inv.link)} alt="QR code d'invitation" />
          <p className="muted">
            Valable encore {left} min · usage unique · votre approbation sera demandée.
          </p>
          <button className="btn" onClick={share}>
            {typeof navigator.share === 'function' ? <Share2 size={18} /> : <Copy size={18} />} {copied ? 'Lien copié' : 'Envoyer le lien'}
          </button>
          <p className="muted small">En attente du nouvel appareil…</p>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
