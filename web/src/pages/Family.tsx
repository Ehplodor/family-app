import { useState } from 'react';
import { Bell, ShieldCheck, UserPlus } from 'lucide-react';
import type { Device, Member as MemberData } from '../lib/engine';
import { useCollection, useEngine, useMe, type Member } from '../store';
import { navigate } from '../router';
import { Avatar, ColorPicker, Fab, Field, Page, Sheet, PALETTE } from '../ui';
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
  const { docs: devices } = useCollection<Device>('devices');
  const [editing, setEditing] = useState<Member | 'new' | null>(null);
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState('');

  const activeDevices = (memberId: string) => devices.filter((d) => d.memberId === memberId && !d.revoked);

  const save = async (m: { name: string; color: string }) => {
    if (editing === 'new') await engine.replica.create<MemberData>('members', m);
    else if (editing) await engine.replica.update<MemberData>('members', editing.id, m);
    setEditing(null);
  };

  const remove = async (m: Member) => {
    const devs = activeDevices(m.id);
    const msg = devs.length
      ? `Retirer ${m.name} ? Ses ${devs.length} appareil(s) perdront l'accès : une nouvelle clé sera créée et transmise uniquement aux autres appareils.`
      : `Retirer ${m.name} de la famille ?`;
    if (!window.confirm(msg)) return;
    setEditing(null);
    if (devs.length) {
      setBusy('Renouvellement de la clé du cercle…');
      try {
        await engine.rotateKey(devs.map((d) => d.id));
      } catch (err) {
        window.alert(`Échec : ${err instanceof Error ? err.message : err}`);
      }
      setBusy('');
    }
    await engine.replica.remove('members', m.id);
  };

  return (
    <Page title="Ma Famille">
      {busy && <p className="banner-info">{busy}</p>}
      <div className="stack">
        {me.members.map((m) => {
          const n = activeDevices(m.id).length;
          return (
            <button key={m.id} className="card row-card" onClick={() => setEditing(m)}>
              <Avatar member={m} size={44} />
              <span className="grow">
                <strong>{m.name}</strong>
                <small>
                  {m.id === me.member.id ? "C'est vous · " : ''}
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
}: {
  initial?: { name: string; color: string };
  hint?: string;
  onSubmit: (m: { name: string; color: string }) => void;
  onDelete?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState(initial?.color ?? PALETTE[Math.floor(Math.random() * PALETTE.length)]);
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSubmit({ name: name.trim(), color });
      }}
    >
      {hint && <p className="muted">{hint}</p>}
      <Field label="Prénom">
        <input autoFocus={!initial} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </Field>
      <Field label="Couleur">
        <ColorPicker value={color} onChange={setColor} />
      </Field>
      <div className="form-actions">
        {onDelete && (
          <button type="button" className="btn danger" onClick={onDelete}>
            Retirer
          </button>
        )}
        <button className="btn primary grow" disabled={!name.trim()}>
          Enregistrer
        </button>
      </div>
    </form>
  );
}
