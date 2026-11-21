import { useState } from 'react';
import { Copy, LogOut, RefreshCw, Share2 } from 'lucide-react';
import { api, type Member } from '../api';
import { useMe, useSession } from '../store';
import { Avatar, ColorPicker, Fab, Field, Page, Sheet, PALETTE, confirmDelete } from '../ui';

export function FamilySummary() {
  const { members } = useMe();
  return (
    <>
      {members.length} membre{members.length > 1 ? 's' : ''}
    </>
  );
}

export const formatInvite = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

export function InviteCard() {
  const { family } = useMe();
  const { refresh } = useSession();
  const code = formatInvite(family.inviteCode);
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator.share === 'function';
  const share = async () => {
    const message = `Rejoins « ${family.name} » sur notre appli familiale : ${location.origin} avec le code ${code}`;
    if (canShare) {
      await navigator.share({ title: family.name, text: message }).catch(() => {});
    } else {
      await navigator.clipboard?.writeText(message);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };
  const regenerate = async () => {
    if (!window.confirm("Générer un nouveau code ? L'ancien ne fonctionnera plus (les appareils déjà connectés le restent).")) return;
    await api('POST', '/family/invite');
    refresh();
  };
  return (
    <div className="card invite">
      <small>Code d'invitation</small>
      <div className="invite-code">{code}</div>
      <p className="muted">Donnez ce code à un proche pour qu'il rejoigne la famille depuis son téléphone.</p>
      <div className="form-actions">
        <button className="btn primary grow" onClick={share}>
          {canShare ? <Share2 size={18} /> : <Copy size={18} />} {copied ? 'Copié !' : 'Partager'}
        </button>
        <button className="btn" onClick={regenerate} aria-label="Nouveau code">
          <RefreshCw size={18} />
        </button>
      </div>
    </div>
  );
}

export function FamilyPage() {
  const me = useMe();
  const { refresh, logout } = useSession();
  const [editing, setEditing] = useState<Member | 'new' | null>(null);

  const save = async (m: { name: string; color: string }) => {
    if (editing === 'new') await api('POST', '/members', m);
    else if (editing) await api('PATCH', `/members/${editing.id}`, m);
    setEditing(null);
    refresh();
  };
  const remove = async (m: Member) => {
    if (!confirmDelete(`${m.name} de la famille`)) return;
    await api('DELETE', `/members/${m.id}`);
    setEditing(null);
    refresh();
  };

  return (
    <Page title="Ma Famille">
      <div className="stack">
        {me.members.map((m) => (
          <button key={m.id} className="card row-card" onClick={() => setEditing(m)}>
            <Avatar member={m} size={44} />
            <span className="grow">
              <strong>{m.name}</strong>
              {m.id === me.member.id && <small>C'est vous (sur cet appareil)</small>}
            </span>
          </button>
        ))}
      </div>

      <InviteCard />

      <button className="btn ghost wide" onClick={() => window.confirm('Se déconnecter de cet appareil ?') && logout()}>
        <LogOut size={18} /> Se déconnecter de cet appareil
      </button>

      <Fab onClick={() => setEditing('new')} label="Ajouter un membre" />
      <Sheet open={!!editing} title={editing === 'new' ? 'Ajouter un membre' : 'Modifier le membre'} onClose={() => setEditing(null)}>
        {editing && (
          <MemberForm
            initial={editing === 'new' ? undefined : editing}
            hint={editing === 'new' ? "Pour un enfant sans téléphone par exemple. Les autres peuvent aussi rejoindre avec le code d'invitation." : undefined}
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
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
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
