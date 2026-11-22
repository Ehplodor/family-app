import { useState } from 'react';
import { ChevronLeft, ChevronRight, PiggyBank } from 'lucide-react';
import { useCollection } from '../store';
import { addMonths, capitalize, fmt, today } from '../dates';
import { Empty, Fab, Field, Page, Sheet, confirmDelete } from '../ui';
import type { Doc } from '../store';
import { VisibleBy, useItemGroups, withGroups } from './Circles';

export type Entry = { label: string; amount: number; type: 'expense' | 'income'; category: string; date: string };

const CATEGORIES = ['Courses', 'Logement', 'Transport', 'Enfants', 'Loisirs', 'Santé', 'Vacances', 'Salaire', 'Autre'];
const euros = (n: number) => n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

export function BudgetSummary() {
  const { docs } = useCollection<Entry>('budget');
  const m = monthKey(new Date());
  const spent = docs.filter((e) => e.type === 'expense' && e.date.startsWith(m)).reduce((s, e) => s + e.amount, 0);
  return <>{spent ? `${euros(spent)} dépensés ce mois` : 'Suivez vos dépenses'}</>;
}

export function BudgetPage() {
  const budget = useCollection<Entry>('budget');
  const [month, setMonth] = useState(() => new Date());
  const [editing, setEditing] = useState<Doc<Entry> | 'new' | null>(null);

  const key = monthKey(month);
  const entries = budget.docs.filter((e) => e.date.startsWith(key)).sort((a, b) => b.date.localeCompare(a.date));
  const income = entries.filter((e) => e.type === 'income').reduce((s, e) => s + e.amount, 0);
  const expenses = entries.filter((e) => e.type === 'expense').reduce((s, e) => s + e.amount, 0);
  const byCat = Object.entries(
    entries.filter((e) => e.type === 'expense').reduce<Record<string, number>>((acc, e) => {
      acc[e.category] = (acc[e.category] ?? 0) + e.amount;
      return acc;
    }, {}),
  ).sort((a, b) => b[1] - a[1]);

  return (
    <Page title="Budget">
      <div className="week-nav">
        <button className="icon-btn" onClick={() => setMonth(addMonths(month, -1))} aria-label="Mois précédent">
          <ChevronLeft />
        </button>
        <strong>{capitalize(fmt(month, { month: 'long', year: 'numeric' }))}</strong>
        <button className="icon-btn" onClick={() => setMonth(addMonths(month, 1))} aria-label="Mois suivant">
          <ChevronRight />
        </button>
      </div>

      <div className="stats">
        <div className="card stat">
          <small>Entrées</small>
          <strong className="pos">{euros(income)}</strong>
        </div>
        <div className="card stat">
          <small>Dépenses</small>
          <strong className="neg">{euros(expenses)}</strong>
        </div>
        <div className="card stat">
          <small>Solde</small>
          <strong>{euros(income - expenses)}</strong>
        </div>
      </div>

      {byCat.length > 0 && (
        <div className="card">
          {byCat.map(([cat, total]) => (
            <div key={cat} className="bar-row">
              <span>{cat}</span>
              <span className="bar">
                <span style={{ width: `${(total / byCat[0][1]) * 100}%` }} />
              </span>
              <span className="num">{euros(total)}</span>
            </div>
          ))}
        </div>
      )}

      {budget.loaded && !entries.length && <Empty icon={<PiggyBank size={48} />}>Aucune opération ce mois-ci.</Empty>}
      <ul className="items">
        {entries.map((e) => (
          <li key={e.id} className="item" onClick={() => setEditing(e)}>
            <span className="grow">
              {e.label}
              <small className="block">
                {e.category} · {fmt(e.date, { day: 'numeric', month: 'short' })}
              </small>
            </span>
            <span className={`num ${e.type === 'income' ? 'pos' : 'neg'}`}>
              {e.type === 'income' ? '+' : '−'}
              {euros(e.amount)}
            </span>
          </li>
        ))}
      </ul>

      <Fab onClick={() => setEditing('new')} label="Nouvelle opération" />
      <Sheet open={!!editing} title={editing === 'new' ? 'Nouvelle opération' : "Modifier l'opération"} onClose={() => setEditing(null)}>
        {editing && (
          <EntryForm
            initial={editing === 'new' ? undefined : editing}
            onSubmit={async (e) => {
              if (editing === 'new') await budget.create(e);
              else await budget.update(editing.id, e);
              setEditing(null);
            }}
            onDelete={
              editing === 'new'
                ? undefined
                : () => {
                    if (confirmDelete(`« ${editing.label} »`)) {
                      budget.remove(editing.id);
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

function EntryForm({ initial, onSubmit, onDelete }: { initial?: Entry; onSubmit: (e: Entry) => void; onDelete?: () => void }) {
  const [groups, setGroups] = useItemGroups(initial);
  const [e, setE] = useState({
    label: initial?.label ?? '',
    amount: initial ? String(initial.amount).replace('.', ',') : '',
    type: initial?.type ?? ('expense' as Entry['type']),
    category: initial?.category ?? 'Courses',
    date: initial?.date ?? today(),
  });
  const set = (patch: Partial<typeof e>) => setE((x) => ({ ...x, ...patch }));
  const amount = Number(e.amount.replace(',', '.').replace(/\s/g, ''));
  const valid = e.label.trim() && amount > 0;
  return (
    <form
      className="form"
      onSubmit={(ev) => {
        ev.preventDefault();
        if (valid) onSubmit(withGroups({ ...e, label: e.label.trim(), amount: Math.round(amount * 100) / 100 }, groups));
      }}
    >
      <div className="segmented">
        <button type="button" className={e.type === 'expense' ? 'on' : ''} onClick={() => set({ type: 'expense' })}>
          Dépense
        </button>
        <button type="button" className={e.type === 'income' ? 'on' : ''} onClick={() => set({ type: 'income' })}>
          Entrée
        </button>
      </div>
      <Field label="Libellé">
        <input autoFocus={!initial} value={e.label} onChange={(x) => set({ label: x.target.value })} />
      </Field>
      <div className="row">
        <Field label="Montant (€)">
          <input inputMode="decimal" value={e.amount} onChange={(x) => set({ amount: x.target.value })} placeholder="0,00" />
        </Field>
        <Field label="Date">
          <input type="date" value={e.date} onChange={(x) => set({ date: x.target.value })} />
        </Field>
      </div>
      <Field label="Catégorie">
        <select value={e.category} onChange={(x) => set({ category: x.target.value })}>
          {CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </Field>
      <VisibleBy value={groups} onChange={setGroups} />
      <div className="form-actions">
        {onDelete && (
          <button type="button" className="btn danger" onClick={onDelete}>
            Supprimer
          </button>
        )}
        <button className="btn primary grow" disabled={!valid}>
          Enregistrer
        </button>
      </div>
    </form>
  );
}
