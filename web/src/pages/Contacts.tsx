import { useState } from 'react';
import { Contact as ContactIcon, Mail, MapPin, Phone, Search } from 'lucide-react';
import { useCollection } from '../store';
import { Empty, Fab, Field, Page, Sheet, confirmDelete } from '../ui';
import type { Doc } from '../store';
import { VisibleBy, useItemGroups, withGroups } from './Circles';

export type Contact = { name: string; category?: string; phone?: string; email?: string; address?: string; notes?: string };

const CATEGORIES = ['Famille', 'Amis', 'École', 'Santé', 'Nounou / garde', 'Urgences', 'Autre'];

export function ContactsSummary() {
  const { docs } = useCollection<Contact>('contacts');
  return <>{docs.length ? `${docs.length} contact${docs.length > 1 ? 's' : ''}` : 'Aucun contact'}</>;
}

const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

export function ContactsPage() {
  const contacts = useCollection<Contact>('contacts');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Doc<Contact> | 'new' | null>(null);

  const q = norm(query.trim());
  const list = contacts.docs
    .filter((c) => !q || norm([c.name, c.category, c.phone, c.email, c.notes].join(' ')).includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));

  return (
    <Page title="Contacts">
      {contacts.docs.length > 5 && (
        <label className="search">
          <Search size={18} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher" />
        </label>
      )}
      {contacts.loaded && !contacts.docs.length && (
        <Empty icon={<ContactIcon size={48} />}>Les numéros utiles de la famille : pédiatre, école, baby-sitter, voisins…</Empty>
      )}
      <div className="stack">
        {list.map((c) => (
          <div key={c.id} className="card row-card" onClick={() => setEditing(c)} role="button">
            <span className="grow">
              <strong>{c.name}</strong>
              <small>{[c.category, c.phone].filter(Boolean).join(' · ')}</small>
            </span>
            {c.phone && (
              <a className="icon-btn tinted" href={`tel:${c.phone}`} onClick={(e) => e.stopPropagation()} aria-label="Appeler">
                <Phone size={18} />
              </a>
            )}
            {c.email && (
              <a className="icon-btn tinted" href={`mailto:${c.email}`} onClick={(e) => e.stopPropagation()} aria-label="E-mail">
                <Mail size={18} />
              </a>
            )}
            {c.address && (
              <a
                className="icon-btn tinted"
                href={`https://www.openstreetmap.org/search?query=${encodeURIComponent(c.address)}`}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                aria-label="Carte"
              >
                <MapPin size={18} />
              </a>
            )}
          </div>
        ))}
      </div>
      <Fab onClick={() => setEditing('new')} label="Nouveau contact" />
      <Sheet open={!!editing} title={editing === 'new' ? 'Nouveau contact' : 'Contact'} onClose={() => setEditing(null)}>
        {editing && (
          <ContactForm
            initial={editing === 'new' ? undefined : editing}
            onSubmit={async (c) => {
              if (editing === 'new') await contacts.create(c);
              else await contacts.update(editing.id, c);
              setEditing(null);
            }}
            onDelete={
              editing === 'new'
                ? undefined
                : () => {
                    if (confirmDelete(editing.name)) {
                      contacts.remove(editing.id);
                      setEditing(null);
                    }
                  }
            }
          />
        )}
      </Sheet>
    </Page>
  );
}

function ContactForm({ initial, onSubmit, onDelete }: { initial?: Contact; onSubmit: (c: Contact) => void; onDelete?: () => void }) {
  const [groups, setGroups] = useItemGroups(initial);
  const [c, setC] = useState<Contact>(initial ?? { name: '', category: '', phone: '', email: '', address: '', notes: '' });
  const set = (patch: Partial<Contact>) => setC((x) => ({ ...x, ...patch }));
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (c.name.trim()) onSubmit(withGroups({ ...c, name: c.name.trim() }, groups));
      }}
    >
      <Field label="Nom">
        <input autoFocus={!initial} value={c.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="Catégorie">
        <select value={c.category ?? ''} onChange={(e) => set({ category: e.target.value })}>
          <option value="">—</option>
          {CATEGORIES.map((cat) => (
            <option key={cat}>{cat}</option>
          ))}
        </select>
      </Field>
      <Field label="Téléphone">
        <input type="tel" value={c.phone ?? ''} onChange={(e) => set({ phone: e.target.value })} />
      </Field>
      <Field label="E-mail">
        <input type="email" value={c.email ?? ''} onChange={(e) => set({ email: e.target.value })} />
      </Field>
      <Field label="Adresse">
        <input value={c.address ?? ''} onChange={(e) => set({ address: e.target.value })} />
      </Field>
      <Field label="Notes">
        <textarea rows={3} value={c.notes ?? ''} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
      <VisibleBy value={groups} onChange={setGroups} />
      <div className="form-actions">
        {onDelete && (
          <button type="button" className="btn danger" onClick={onDelete}>
            Supprimer
          </button>
        )}
        <button className="btn primary grow" disabled={!c.name.trim()}>
          Enregistrer
        </button>
      </div>
    </form>
  );
}
