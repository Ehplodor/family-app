/**
 * Cercles restreints du calendrier (« Moi seul », « Parents »…) : gestion, autorisation des appareils,
 * et choix de la visibilité d'un évènement. La cryptographie est dans lib/groups.ts.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Lock, ShieldCheck, Users } from 'lucide-react';
import { useEngine, useGroups, useMe, useMembers, useNotifier } from '../store';
import { Avatar, ColorPicker, Field, FieldGroup, MemberChips, PALETTE, confirmDelete } from '../ui';
import type { GroupInfo } from '../lib/groupManager';

/* ------------------------------------------------------------------ Visibilité par défaut (par appareil) */

export type DefaultVisibility = 'family' | 'personal';
const DEFAULT_KEY = 'calendar.defaultVisibility';
const listeners = new Set<() => void>();
let defaultVisibility: DefaultVisibility = (() => {
  try {
    return localStorage.getItem(DEFAULT_KEY) === 'personal' ? 'personal' : 'family';
  } catch {
    return 'family';
  }
})();

export function setDefaultVisibility(v: DefaultVisibility) {
  defaultVisibility = v;
  try {
    localStorage.setItem(DEFAULT_KEY, v);
  } catch {
    /* stockage indisponible : réglage gardé en mémoire */
  }
  listeners.forEach((l) => l());
}

export function useDefaultVisibility(): DefaultVisibility {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => defaultVisibility,
  );
}

/** Cercles à utiliser pour un nouvel évènement, selon le réglage de cet appareil. */
export function useDefaultGroups(): string[] {
  const v = useDefaultVisibility();
  const groups = useGroups();
  const { member } = useMe();
  const personal = groups.list().find((g) => g.personal === member.id && g.access === 'ok');
  return v === 'personal' && personal ? [personal.id] : [];
}

/** Nom affiché d'un cercle. */
export const groupLabel = (g: Pick<GroupInfo, 'name' | 'personal'>) => (g.personal ? 'Moi seul' : g.name);

/* ------------------------------------------------------------------ Choix « Visible par » */

export function VisibilityPicker({ value, onChange }: { value: string[]; onChange: (groups: string[]) => void }) {
  const groups = useGroups();
  const mine = groups.list().filter((g) => g.access === 'ok');
  // Cercles de l'évènement dont cet appareil n'a pas (ou plus) la clé en vigueur : gardés, affichés à part.
  const others = value.filter((id) => !mine.some((g) => g.id === id));
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <div className="chips">
      <button
        type="button"
        className={`chip ${!value.length ? 'on' : ''}`}
        style={!value.length ? { background: 'var(--accent)', borderColor: 'var(--accent)' } : undefined}
        onClick={() => onChange([])}
      >
        <Users size={14} /> Toute la famille
      </button>
      {mine.map((g) => {
        const on = value.includes(g.id);
        return (
          <button
            key={g.id}
            type="button"
            className={`chip ${on ? 'on' : ''}`}
            style={on ? { background: g.color, borderColor: g.color } : { borderColor: g.color }}
            onClick={() => toggle(g.id)}
          >
            <Lock size={14} /> {groupLabel(g)}
          </button>
        );
      })}
      {others.map((id) => (
        <button key={id} type="button" className="chip on" onClick={() => toggle(id)} title="Retirer ce cercle">
          <Lock size={14} /> Autre cercle ✕
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Écran « Cercles » */

export function CirclesSheet() {
  const groups = useGroups();
  const engine = useEngine();
  const { member } = useMe();
  const visibility = useDefaultVisibility();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [error, setError] = useState('');
  const [personal, setPersonal] = useState<'none' | 'ok' | 'waiting'>('ok');
  const list = groups.list();
  useEffect(() => {
    groups.personalStatus().then(setPersonal);
  }, [groups, list]);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="form">
      <p className="muted small">
        Un évènement réservé à un ou plusieurs cercles est chiffré avec leur clé : les autres appareils de la famille ne
        reçoivent qu'un paquet illisible (ni titre, ni date).
      </p>
      {personal === 'waiting' && (
        <p className="banner-info small">
          🔒 Votre cercle « Moi seul » existe déjà sur un autre de vos appareils. Ouvrez l'appli sur cet appareil, puis{' '}
          <b>Calendrier → Cercles → Autoriser</b> pour donner l'accès à celui-ci.
        </p>
      )}
      {error && <p className="error">{error}</p>}
      <ul className="cal-list">
        {list.map((g) => (
          <li key={g.id}>
            <GroupRow
              group={g}
              open={editing === g.id}
              onToggle={() => setEditing(editing === g.id ? null : g.id)}
              onError={setError}
            />
          </li>
        ))}
      </ul>
      {!list.length && personal !== 'waiting' && <p className="muted small">Préparation de votre cercle personnel…</p>}

      <FieldGroup label="Mes nouveaux évènements sont visibles par">
        <div className="segmented">
          <button type="button" className={visibility === 'family' ? 'on' : ''} onClick={() => setDefaultVisibility('family')}>
            Toute la famille
          </button>
          <button type="button" className={visibility === 'personal' ? 'on' : ''} onClick={() => setDefaultVisibility('personal')}>
            Moi seul
          </button>
        </div>
      </FieldGroup>

      {editing === 'new' ? (
        <GroupForm
          onCancel={() => setEditing(null)}
          onSubmit={(meta) =>
            run(async () => {
              await groups.create({ ...meta, members: [member.id, ...meta.members.filter((m) => m !== member.id)] });
              setEditing(null);
            })
          }
        />
      ) : (
        <button type="button" className="btn" onClick={() => setEditing('new')} disabled={!engine.memberId}>
          Nouveau cercle
        </button>
      )}
      <details className="muted small">
        <summary>Comment ça marche ?</summary>
        <ul>
          <li>Chaque personne a son cercle « Moi seul », pour ses évènements privés.</li>
          <li>
            Un nouvel appareil n'a <b>pas</b> accès automatiquement aux cercles : un appareil qui y a déjà accès doit
            l'autoriser (bouton « Autoriser »). Ainsi, un téléphone qui choisit votre prénom à son arrivée ne peut pas lire vos
            évènements privés.
          </li>
          <li>
            Retirer quelqu'un d'un cercle change sa clé : la personne garde ce qu'elle avait déjà vu, mais ne lit plus ce qui
            est ajouté ou modifié ensuite.
          </li>
          <li>Les rappels d'un évènement privé ne sont envoyés qu'aux membres de ses cercles.</li>
        </ul>
      </details>
    </div>
  );
}

function GroupRow({ group: g, open, onToggle, onError }: { group: GroupInfo; open: boolean; onToggle: () => void; onError: (e: string) => void }) {
  const groups = useGroups();
  const engine = useEngine();
  const notifier = useNotifier();
  const { byId } = useMembers();
  const pending = groups.pending(g.id);
  const holders = groups.holders(g.id);
  const members = g.members.map((id) => byId(id)).filter((m) => !!m);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    onError('');
    try {
      await fn();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="toggle">
        <i className="cal-swatch" style={{ background: g.color }} />
        <span className="grow">
          <Lock size={14} /> {groupLabel(g)}
          {g.access === 'outdated' && <small className="muted"> · accès à renouveler</small>}
        </span>
        <span className="avatars">
          {members.map((m) => (
            <Avatar key={m!.id} member={m} size={22} />
          ))}
        </span>
        <button type="button" className="btn small" onClick={onToggle}>
          {open ? 'Fermer' : 'Détails'}
        </button>
      </div>
      {g.access === 'outdated' && (
        <p className="muted small">
          La clé de ce cercle a changé et cet appareil ne l'a pas reçue : soit vous avez été retiré du cercle, soit un appareil
          qui y a accès doit vous autoriser de nouveau. Les anciens évènements restent lisibles ici.
        </p>
      )}
      {pending.map((d) => (
        <div key={d.id} className="banner-info small row-line">
          <span className="grow">
            <ShieldCheck size={14} /> <b>{d.label || 'Appareil'}</b> ({byId(d.memberId)?.name ?? '?'}) attend l'accès. Autorisez-le
            seulement si c'est bien son appareil.
          </span>
          <button type="button" className="btn small primary" disabled={busy} onClick={() => act(() => groups.grant(g.id, d.id))}>
            Autoriser
          </button>
        </div>
      ))}
      {open && (
        <div className="card form">
          <p className="small">
            <b>Appareils qui ont accès :</b>{' '}
            {holders.map((d) => `${d.label || 'Appareil'} (${byId(d.memberId)?.name ?? '?'})${d.id === engine.deviceId ? ' – celui-ci' : ''}`).join(', ') ||
              'aucun'}
          </p>
          {!g.personal && g.access === 'ok' && (
            <GroupForm
              initial={g}
              onSubmit={(meta) =>
                act(async () => {
                  const removed = g.members.filter((m) => !meta.members.includes(m));
                  if (removed.length && !confirm(`Retirer ${removed.map((id) => byId(id)?.name ?? '?').join(', ')} du cercle ? Ce qu'ils ont déjà vu reste sur leurs appareils.`)) return;
                  await groups.update(g.id, meta);
                  // Leurs appareils ne doivent plus recevoir les rappels des évènements de ce cercle.
                  if (removed.length) await notifier.clearPartsFor(g.id, removed);
                })
              }
              onDelete={() =>
                act(async () => {
                  if (!confirmDelete(`le cercle « ${g.name} »`)) return;
                  await groups.remove(g.id);
                  await notifier.clearPartsFor(g.id, g.members);
                })
              }
              usage={groups.usage(g.id)}
            />
          )}
          {g.personal && <p className="muted small">Votre cercle personnel ne contient que vous : il ne peut être ni modifié ni supprimé.</p>}
        </div>
      )}
    </div>
  );
}

function GroupForm({
  initial,
  onSubmit,
  onCancel,
  onDelete,
  usage = 0,
}: {
  initial?: GroupInfo;
  onSubmit: (meta: { name: string; color: string; members: string[] }) => void;
  onCancel?: () => void;
  onDelete?: () => void;
  usage?: number;
}) {
  const { members } = useMembers();
  const { member } = useMe();
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState(initial?.color ?? PALETTE[3]);
  const [ids, setIds] = useState<string[]>(initial?.members ?? [member.id]);
  return (
    <div className="card form">
      <Field label="Nom du cercle">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Parents, Rod & Julie, Surprise pour mamie…" />
      </Field>
      <FieldGroup label="Couleur">
        <ColorPicker value={color} onChange={setColor} />
      </FieldGroup>
      <FieldGroup label="Membres">
        <MemberChips members={members} value={ids} onChange={setIds} />
      </FieldGroup>
      <p className="muted small">
        Les appareils des nouveaux membres devront être autorisés depuis un appareil qui a déjà accès (bouton « Autoriser »).
      </p>
      <div className="form-actions">
        {onDelete && (
          <button type="button" className="btn danger" onClick={onDelete} disabled={usage > 0} title={usage ? `Utilisé par ${usage} évènement(s)` : undefined}>
            Supprimer
          </button>
        )}
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            Annuler
          </button>
        )}
        <button
          type="button"
          className="btn primary grow"
          disabled={!name.trim() || !ids.length}
          onClick={() => onSubmit({ name: name.trim(), color, members: ids })}
        >
          Enregistrer
        </button>
      </div>
      {onDelete && usage > 0 && <p className="muted small">Ce cercle sert à {usage} évènement(s) : retirez-le d'abord de ces évènements pour le supprimer.</p>}
    </div>
  );
}
