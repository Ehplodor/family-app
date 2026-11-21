import { useEffect, type ReactNode } from 'react';
import { ChevronLeft, Plus, X } from 'lucide-react';
import type { Member } from './api';
import { goBack } from './router';

export const PALETTE = [
  '#E5484D', '#F76B15', '#F2B705', '#30A46C', '#12A594', '#0090FF',
  '#3E63DD', '#7C5CE0', '#AB4ABA', '#D6409F', '#8D6E63', '#5B6470',
];

export function Page({
  title,
  back = '/',
  actions,
  children,
  className = '',
}: {
  title: ReactNode;
  back?: string | false;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`page ${className}`}>
      <header className="page-header">
        {back !== false && (
          <button className="icon-btn" onClick={() => goBack(back)} aria-label="Retour">
            <ChevronLeft size={26} />
          </button>
        )}
        <h1>{title}</h1>
        <div className="page-actions">{actions}</div>
      </header>
      <div className="page-body">{children}</div>
    </div>
  );
}

export function Sheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer">
            <X size={22} />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

export function Fab({ onClick, label = 'Ajouter' }: { onClick: () => void; label?: string }) {
  return (
    <button className="fab" onClick={onClick} aria-label={label}>
      <Plus size={28} />
    </button>
  );
}

export function Avatar({ member, size = 36 }: { member?: Member; size?: number }) {
  const initials = member ? member.name.slice(0, 2) : '?';
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.42, background: member?.color ?? '#9aa0a6' }}
      title={member?.name}
    >
      {initials}
    </span>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Empty({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <p>{children}</p>
    </div>
  );
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="swatches">
      {PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          className={`swatch ${c.toLowerCase() === value.toLowerCase() ? 'selected' : ''}`}
          style={{ background: c }}
          onClick={() => onChange(c)}
          aria-label={`Couleur ${c}`}
        />
      ))}
    </div>
  );
}

/** Sélection d'un ou plusieurs membres de la famille. */
export function MemberChips({
  members,
  value,
  onChange,
  multiple = true,
}: {
  members: Member[];
  value: string[];
  onChange: (ids: string[]) => void;
  multiple?: boolean;
}) {
  const toggle = (id: string) => {
    if (multiple) onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
    else onChange(value.includes(id) ? [] : [id]);
  };
  return (
    <div className="chips">
      {members.map((m) => {
        const on = value.includes(m.id);
        return (
          <button
            key={m.id}
            type="button"
            className={`chip ${on ? 'on' : ''}`}
            style={on ? { background: m.color, borderColor: m.color } : { borderColor: m.color }}
            onClick={() => toggle(m.id)}
          >
            {m.name}
          </button>
        );
      })}
    </div>
  );
}

export function IconBadge({ color, children, size = 52 }: { color: string; children: ReactNode; size?: number }) {
  return (
    <span className="icon-badge" style={{ color, background: `${color}1f`, width: size, height: size }}>
      {children}
    </span>
  );
}

export function confirmDelete(what: string) {
  return window.confirm(`Supprimer ${what} ?`);
}
