import { useEffect, useRef, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useEngine } from '../store';
import { pollApproval, sendJoinRequest } from '../lib/invite';
import type { InviteKeys } from '../lib/crypto';

/** Nouvel appareil : envoie sa demande puis attend l'approbation d'un membre. */
export function JoinWaiting({ secret, onCancel }: { secret: Uint8Array<ArrayBuffer>; onCancel: () => void }) {
  const engine = useEngine();
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<'waiting' | 'syncing'>('waiting');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let timer: ReturnType<typeof setInterval>;
    let keys: InviteKeys;
    sendJoinRequest(engine, secret)
      .then((r) => {
        keys = r.keys;
        setCode(r.code);
        timer = setInterval(async () => {
          try {
            const ok = await pollApproval(engine, keys);
            if (ok) {
              clearInterval(timer);
              setPhase('syncing');
              await engine.joinCircle(ok.secret, ok.member);
            }
          } catch (err) {
            clearInterval(timer);
            setError(err instanceof Error ? err.message : String(err));
          }
        }, 2000);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    return () => clearInterval(timer);
  }, [engine, secret]);

  return (
    <div className="card form center">
      <ShieldCheck size={48} className="accent-text" />
      {phase === 'syncing' ? (
        <p>Approuvé ! Récupération des données de la famille…</p>
      ) : (
        <>
          <h2>Demande envoyée</h2>
          <p className="muted">Sur le téléphone qui vous invite, vérifiez que ce code s'affiche à l'identique, puis approuvez.</p>
          <div className="safety">{code || '…'}</div>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <button className="link" onClick={onCancel}>
        Annuler
      </button>
    </div>
  );
}
