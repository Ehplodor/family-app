import { useState } from 'react';
import { Bell, ShieldCheck, UserPlus, Users } from 'lucide-react';
import type { Device, Member as MemberData } from '../lib/engine';
import { useCircles, useCollection, useEngine, useMe, useDefaultGroups, type Member } from '../store';
import { navigate } from '../router';
import { Avatar, ColorPicker, Fab, Field, FieldGroup, Page, Sheet, PALETTE } from '../ui';
import { InvitePanel } from './Invite';

export function FamilySummary() {
  const { members } = useMe();
  return (
    <>
      {members.length} membre{members.length > 1 ? 's' : ''}
    </>
  );
}

export function FamilyPage() {
  const me = useMe();
  const engine = useEngine();
  const { docs: devices } = useCollection<Device>('deviceInfo');
  const [editing, setEditing] = useState<Member | 'new' | null>(null);
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState('');
  const circles = useCircles();
  const defaults = useDefaultGroups();

  const activeDevices = (memberId: string) => devices.filter((d) => d.memberId === memberId && d.owner === memberId && !d.revoked);
  const canEdit = (m: Member) => engine.data.canEdit('members', m.id, ['name']);

  const save = async (m: { name: string; color: string; kind?: 'child' | 'adult' }) => {
    try {
      // Nouveau profil (un enfant sans téléphone par exemple) : visible par les cercles choisis par défaut.
      if (editing === 'new') await engine.data.create<MemberData>('members', { ...m, groups: defaults });
      else if (editing && editing.id === me.member.id) await engine.saveProfile(m);
      else if (editing) await engine.data.update<MemberData>('members', editing.id, m);
      setEditing(null);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    }
  };

  /** Retirer quelqu'un : l'exclure des cercles dont on est l'admin (ou effacer un profil qu'on a créé). */
  const remove = async (m: Member) => {
    const adminOf = circles.filter((c) => c.isAdmin && c.members.includes(m.id) && c.admin !== m.id);
    const mine = engine.data.get('members', m.id)?.owner === me.member.id;
    if (!adminOf.length && !mine) {
      window.alert(`Seul l'admin d'un cercle peut en exclure quelqu'un. ${m.name} est dans des cercles dont vous n'êtes pas l'admin.`);
      return;
    }
    const msg = adminOf.length
      ? `Exclure ${m.name} de : ${adminOf.map((c) => c.name).join(', ')} ? Ses appareils ne recevront plus rien de nouveau (nouvelle clé pour ces cercles).`
      : `Retirer ${m.name} ?`;
    if (!window.confirm(msg)) return;
    setEditing(null);
    setBusy('Changement de clé…');
    try {
      for (const c of adminOf) await engine.vault.exclude(c.id, m.id);
      if (mine) await engine.data.remove('members', m.id);
    } catch (err) {
      window.alert(`Échec : ${err instanceof Error ? err.message : err}`);
    }
    setBusy('');
  };

  return (
    <Page title="Ma Famille">
      {busy && <p className="banner-info">{busy}</p>}
      <div className="stack">
        {me.members.map((m) => {
          const n = activeDevices(m.id).length;
          return (
            <button key={m.id} className="card row-card" onClick={() => (canEdit(m) || circles.some((c) => c.isAdmin && c.members.includes(m.id)) ? setEditing(m) : undefined)}>
              <Avatar member={m} size={44} />
              <span className="grow">
                <strong>{m.name}</strong>
                <small>
                  {m.id === me.member.id ? "C'est vous · " : ''}
                  {m.kind === 'child' ? 'Enfant · ' : ''}
                  {n ? `${n} appareil${n > 1 ? 's' : ''}` : 'Sans appareil'}
                </small>
              </span>
            </button>
          );
        })}
      </div>

      <button className="btn primary wide" onClick={() => setInviting(true)}>
        <UserPlus size={18} /> Inviter / ajouter un appareil
      </button>
      <div className="row">
        <button className="btn" onClick={() => navigate('/circles')}>
          <Users size={18} /> Cercles
        </button>
        <button className="btn" onClick={() => navigate('/security')}>
          <ShieldCheck size={18} /> Sécurité
        </button>
        <button className="btn" onClick={() => navigate('/notifications')}>
          <Bell size={18} /> Rappels
        </button>
      </div>

      <Fab onClick={() => setEditing('new')} label="Ajouter un membre" />
      <Sheet open={inviting} title="Ajouter un appareil" onClose={() => setInviting(false)}>
        {inviting && <InvitePanel onDone={() => setInviting(false)} />}
      </Sheet>
      <Sheet open={!!editing} title={editing === 'new' ? 'Ajouter un membre' : 'Modifier le membre'} onClose={() => setEditing(null)}>
        {editing && (
          <MemberForm
            initial={editing === 'new' ? undefined : editing}
            hint={editing === 'new' ? "Pour un enfant sans téléphone par exemple. Pour qu'une personne utilise l'appli sur son téléphone, utilisez plutôt « Inviter »." : undefined}
            onSubmit={save}
            readOnly={editing !== 'new' && !canEdit(editing)}
            onDelete={editing !== 'new' && editing.id !== me.member.id ? () => remove(editing) : undefined}
          />
        )}
      </Sheet>
    </Page>
  );
}

export function MemberForm({
  initial,
  hint,
  onSubmit,
  onDelete,
  readOnly,
}: {
  initial?: { name: string; color: string; kind?: 'child' | 'adult' };
  hint?: string;
  /** Profil d'une autre personne : elle seule le modifie (on peut seulement l'exclure de ses cercles). */
  readOnly?: boolean;
  onSubmit: (m: { name: string; color: string; kind: 'child' | 'adult' }) => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState(initial?.color ?? PALETTE[Math.floor(Math.random() * PALETTE.length)]);
  const [child, setChild] = useState(initial?.kind === 'child');
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSubmit({ name: name.trim(), color, kind: child ? 'child' : 'adult' });
      }}
    >
      {hint && <p className="muted">{hint}</p>}
      {readOnly && <p className="muted small">Seule cette personne peut modifier son profil.</p>}
      <Field label="Prénom">
        <input autoFocus={!initial} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </Field>
      <FieldGroup label="Couleur">
        <ColorPicker value={color} onChange={setColor} />
      </FieldGroup>
      <label className="toggle">
        <input type="checkbox" checked={child} onChange={(e) => setChild(e.target.checked)} />
        Enfant (active son espace École)
      </label>
      <div className="form-actions">
        {onDelete && (
          <button type="button" className="btn danger" onClick={onDelete}>
            Retirer
          </button>
        )}
        {!readOnly && (
          <button className="btn primary grow" disabled={!name.trim()}>
            Enregistrer
          </button>
        )}
      </div>
    </form>
  );
}
