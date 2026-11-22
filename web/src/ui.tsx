import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, Minus, Plus, X } from 'lucide-react';
import type { Member } from './store';
import { goBack } from './router';
import { formatTime, parseTime, stepMinutes, type HM } from './lib/timeValue';

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
  onBack,
}: {
  title: ReactNode;
  back?: string | false;
  /** Retour personnalisé (sinon : historique, puis l'écran `back`). */
  onBack?: () => void;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`page ${className}`}>
      <header className="page-header">
        {back !== false && (
          <button className="icon-btn" onClick={() => (onBack ? onBack() : goBack(back))} aria-label="Retour">
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

/**
 * Choix d'une heure (« HH:MM »), à la place de <input type="time">.
 * Le sélecteur natif d'Android (cadran) est une fenêtre du système que la page ne peut pas mettre en forme :
 * avec une grande taille de texte ou d'affichage, ses boutons (dont « Définir ») sortent de l'écran.
 * Ce sélecteur-ci s'adapte à la largeur de l'écran. La valeur reste une chaîne « HH:MM » (ou '' si vide).
 */
export function TimeInput({
  value,
  onChange,
  required = false,
  disabled = false,
  className = '',
  label = "Choisir l'heure",
}: {
  value: string | undefined;
  onChange: (value: string) => void;
  /** Pas de bouton « Effacer » : une heure est obligatoire. */
  required?: boolean;
  disabled?: boolean;
  className?: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const t = parseTime(value);
  return (
    <>
      <button
        type="button"
        className={`time-input ${className}`}
        disabled={disabled}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {t ? formatTime(t) : <span className="time-placeholder">--:--</span>}
      </button>
      {open && (
        <TimePicker
          value={value}
          required={required}
          label={label}
          onClose={() => setOpen(false)}
          onDone={(v) => {
            setOpen(false);
            if (v !== (value ?? '')) onChange(v);
          }}
        />
      )}
    </>
  );
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 12 }, (_, i) => i * 5);
const pad = (n: number) => String(n).padStart(2, '0');

function TimePicker({
  value,
  required,
  label,
  onClose,
  onDone,
}: {
  value: string | undefined;
  required: boolean;
  label: string;
  onClose: () => void;
  onDone: (value: string) => void;
}) {
  const [t, setT] = useState<HM>(() => parseTime(value) ?? { h: new Date().getHours(), m: 0 });
  useEffect(() => {
    // Phase de capture : « Échap » ferme ce sélecteur sans fermer la feuille qui le contient.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  // Rendu hors du formulaire (portail) : un clic ici n'active pas le <label> ni n'envoie le <form> parent.
  return createPortal(
    <div
      className="time-backdrop"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="time-dialog" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        <div className="time-display" aria-live="polite">
          {pad(t.h)}:{pad(t.m)}
        </div>
        <div className="time-label">Heure</div>
        <div className="time-grid">
          {HOURS.map((h) => (
            <button
              key={h}
              type="button"
              className={`time-cell ${t.h === h ? 'on' : ''}`}
              aria-pressed={t.h === h}
              onClick={() => setT({ ...t, h })}
            >
              {pad(h)}
            </button>
          ))}
        </div>
        <div className="time-label">
          <span>Minutes</span>
          <span className="time-step">
            <button type="button" className="icon-btn" aria-label="Une minute de moins" onClick={() => setT(stepMinutes(t, -1))}>
              <Minus size={18} />
            </button>
            <button type="button" className="icon-btn" aria-label="Une minute de plus" onClick={() => setT(stepMinutes(t, 1))}>
              <Plus size={18} />
            </button>
          </span>
        </div>
        <div className="time-grid">
          {MINUTES.map((m) => (
            <button
              key={m}
              type="button"
              className={`time-cell ${t.m === m ? 'on' : ''}`}
              aria-pressed={t.m === m}
              onClick={() => setT({ ...t, m })}
            >
              {pad(m)}
            </button>
          ))}
        </div>
        <div className="time-actions">
          {!required && (
            <button type="button" className="btn ghost small" onClick={() => onDone('')}>
              Effacer
            </button>
          )}
          <span className="time-actions-gap" />
          <button type="button" className="btn ghost small" onClick={onClose}>
            Annuler
          </button>
          <button type="button" className="btn primary small" onClick={() => onDone(formatTime(t))}>
            OK
          </button>
        </div>
      </div>
    </div>,
    document.body,
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

/** Groupe de boutons (couleurs, membres…) : pas de <label>, qui capterait le premier bouton. */
export function FieldGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="field" role="group" aria-label={label}>
      <span>{label}</span>
      {children}
    </div>
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
