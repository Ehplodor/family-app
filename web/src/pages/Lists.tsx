import { useState, type FormEvent } from 'react';
import { Check, ListChecks, Pencil, Trash2, X } from 'lucide-react';
import { useCollection, useMe, useMembers } from '../store';
import { navigate, goBack } from '../router';
import { ColorPicker, Empty, Fab, Field, FieldGroup, Page, Sheet, confirmDelete } from '../ui';

export type List = { name: string; color: string };
export type ListItem = { listId: string; text: string; done: boolean; doneBy?: string | null };

export function ListsSummary() {
  const { docs } = useCollection<List>('lists');
  const { docs: items } = useCollection<ListItem>('listItems');
  const todo = items.filter((i) => !i.done).length;
  if (!docs.length) return <>Aucune liste</>;
  return (
    <>
      {docs.length} liste{docs.length > 1 ? 's' : ''}
      {todo > 0 && ` · ${todo} élément${todo > 1 ? 's' : ''}`}
    </>
  );
}

export function ListsPage({ params }: { params: string[] }) {
  return params[0] ? <ListDetail id={params[0]} /> : <ListsOverview />;
}

function ListForm({ initial, onSubmit }: { initial?: List; onSubmit: (l: List) => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [color, setColor] = useState(initial?.color ?? '#2D9CDB');
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSubmit({ name: name.trim(), color });
      }}
    >
      <Field label="Nom">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Courses, À faire, Vacances…" />
      </Field>
      <FieldGroup label="Couleur">
        <ColorPicker value={color} onChange={setColor} />
      </FieldGroup>
      <button className="btn primary" disabled={!name.trim()}>
        Enregistrer
      </button>
    </form>
  );
}

function ListsOverview() {
  const lists = useCollection<List>('lists');
  const { docs: items } = useCollection<ListItem>('listItems');
  const [adding, setAdding] = useState(false);

  return (
    <Page title="Listes">
      {lists.loaded && !lists.docs.length && (
        <Empty icon={<ListChecks size={48} />}>Créez votre première liste : courses, choses à faire, idées cadeaux…</Empty>
      )}
      <div className="stack">
        {lists.docs.map((l) => {
          const mine = items.filter((i) => i.listId === l.id);
          const done = mine.filter((i) => i.done).length;
          return (
            <button key={l.id} className="card list-card" onClick={() => navigate(`/m/lists/${l.id}`)}>
              <span className="list-dot" style={{ background: l.color }} />
              <span className="grow">
                <strong>{l.name}</strong>
                <small>{mine.length ? `${mine.length - done} à faire · ${done} fait${done > 1 ? 's' : ''}` : 'Vide'}</small>
              </span>
              {mine.length > 0 && (
                <span className="progress">
                  <span style={{ width: `${(done / mine.length) * 100}%`, background: l.color }} />
                </span>
              )}
            </button>
          );
        })}
      </div>
      <Fab onClick={() => setAdding(true)} label="Nouvelle liste" />
      <Sheet open={adding} title="Nouvelle liste" onClose={() => setAdding(false)}>
        <ListForm
          onSubmit={async (l) => {
            setAdding(false);
            const doc = await lists.create(l);
            navigate(`/m/lists/${doc.id}`);
          }}
        />
      </Sheet>
    </Page>
  );
}

function ListDetail({ id }: { id: string }) {
  const lists = useCollection<List>('lists');
  const items = useCollection<ListItem>('listItems');
  const { byId } = useMembers();
  const me = useMe();
  const [text, setText] = useState('');
  const [editing, setEditing] = useState(false);
  const list = lists.docs.find((l) => l.id === id);

  if (!list) {
    return <Page title="Liste" back="/m/lists">{lists.loaded && <Empty>Cette liste n'existe plus.</Empty>}</Page>;
  }

  const mine = items.docs.filter((i) => i.listId === id);
  const todo = mine.filter((i) => !i.done);
  const done = mine.filter((i) => i.done);

  const add = (e: FormEvent) => {
    e.preventDefault();
    // Plusieurs éléments d'un coup en les séparant par des virgules.
    const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
    parts.forEach((t) => items.create({ listId: id, text: t, done: false }));
    setText('');
  };

  const removeList = async () => {
    if (!confirmDelete(`la liste « ${list.name} » et ses ${mine.length} éléments`)) return;
    await Promise.all(mine.map((i) => items.remove(i.id)));
    await lists.remove(id);
    goBack('/m/lists');
  };

  return (
    <Page
      title={list.name}
      back="/m/lists"
      actions={
        <>
          <button className="icon-btn" onClick={() => setEditing(true)} aria-label="Modifier">
            <Pencil size={20} />
          </button>
          <button className="icon-btn" onClick={removeList} aria-label="Supprimer la liste">
            <Trash2 size={20} />
          </button>
        </>
      }
    >
      <form className="add-row" onSubmit={add}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ajouter (ex : lait, pain, œufs)" />
        <button className="btn primary" disabled={!text.trim()} style={{ background: list.color }}>
          Ajouter
        </button>
      </form>

      {!mine.length && <Empty>La liste est vide.</Empty>}

      <ul className="items">
        {todo.map((i) => (
          <Item key={i.id} item={i} color={list.color} onToggle={() => items.update(i.id, { done: true, doneBy: me.member.id })} onDelete={() => items.remove(i.id)} />
        ))}
      </ul>

      {done.length > 0 && (
        <>
          <div className="section-title">
            <span>Cochés ({done.length})</span>
            <button className="link" onClick={() => done.forEach((i) => items.remove(i.id))}>
              Tout effacer
            </button>
          </div>
          <ul className="items">
            {done.map((i) => (
              <Item
                key={i.id}
                item={i}
                color={list.color}
                by={byId(i.doneBy)?.name}
                onToggle={() => items.update(i.id, { done: false, doneBy: null })}
                onDelete={() => items.remove(i.id)}
              />
            ))}
          </ul>
        </>
      )}

      <Sheet open={editing} title="Modifier la liste" onClose={() => setEditing(false)}>
        <ListForm
          initial={list}
          onSubmit={(l) => {
            lists.update(id, l);
            setEditing(false);
          }}
        />
      </Sheet>
    </Page>
  );
}

function Item({
  item,
  color,
  by,
  onToggle,
  onDelete,
}: {
  item: ListItem;
  color: string;
  by?: string;
  onToggle: () => void;
  onDelete: () => void;
}) {
  return (
    <li className={`item ${item.done ? 'done' : ''}`}>
      <button
        className="check"
        style={item.done ? { background: color, borderColor: color } : { borderColor: color }}
        onClick={onToggle}
        aria-label={item.done ? 'Décocher' : 'Cocher'}
      >
        {item.done && <Check size={16} />}
      </button>
      <span className="grow" onClick={onToggle}>
        {item.text}
        {by && <small> · {by}</small>}
      </span>
      <button className="icon-btn subtle" onClick={onDelete} aria-label="Supprimer">
        <X size={18} />
      </button>
    </li>
  );
}
