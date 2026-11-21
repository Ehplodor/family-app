import { useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, ListChecks, Pencil, Trash2, X } from 'lucide-react';
import { useCollection, useMe, useMembers, type Collection, type Doc } from '../store';
import { navigate, goBack } from '../router';
import { ColorPicker, Empty, Fab, Field, FieldGroup, Page, Sheet, confirmDelete } from '../ui';
import { LIST_KINDS, groupByAisle, itemStatus, listKind, progress, statusPatch, type ItemStatus, type ListKind } from '../lib/lists';

// `kind` et `status` sont facultatifs : les listes créées avant leur ajout restent des listes à cocher.
export type List = { name: string; color: string; kind?: ListKind };
export type ListItem = { listId: string; text: string; done: boolean; doneBy?: string | null; status?: ItemStatus };

export function ListsSummary() {
  const { docs } = useCollection<List>('lists');
  const { docs: items } = useCollection<ListItem>('listItems');
  const simple = new Set(docs.filter((l) => listKind(l) === 'bullet').map((l) => l.id));
  const todo = items.filter((i) => !i.done && !simple.has(i.listId)).length;
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
  const [kind, setKind] = useState<ListKind>(initial ? listKind(initial) : 'todo');
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSubmit({ name: name.trim(), color, kind });
      }}
    >
      <FieldGroup label="Type">
        <div className="chips">
          {LIST_KINDS.map((k) => (
            <button
              type="button"
              key={k.id}
              className={`chip ${kind === k.id ? 'on' : ''}`}
              style={kind === k.id ? { background: color, borderColor: color } : { borderColor: color, color }}
              onClick={() => setKind(k.id)}
            >
              {k.label}
            </button>
          ))}
        </div>
        <small className="muted">{LIST_KINDS.find((k) => k.id === kind)?.hint}</small>
      </FieldGroup>
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
        <Empty icon={<ListChecks size={48} />}>Créez votre première liste : courses, choses à faire, livres à lire, projet…</Empty>
      )}
      <div className="stack">
        {lists.docs.map((l) => {
          const mine = items.filter((i) => i.listId === l.id);
          const done = mine.filter((i) => i.done).length;
          const kind = listKind(l);
          const ratio = kind === 'kanban' ? progress(mine) : mine.length ? done / mine.length : 0;
          const label = !mine.length
            ? 'Vide'
            : kind === 'bullet'
              ? `${mine.length} élément${mine.length > 1 ? 's' : ''}`
              : kind === 'kanban'
                ? `Projet · ${Math.round(ratio * 100)} % · ${mine.length} tâche${mine.length > 1 ? 's' : ''}`
                : `${mine.length - done} à ${kind === 'shopping' ? 'acheter' : 'faire'} · ${done} fait${done > 1 ? 's' : ''}`;
          return (
            <button key={l.id} className="card list-card" onClick={() => navigate(`/m/lists/${l.id}`)}>
              <span className="list-dot" style={{ background: l.color }} />
              <span className="grow">
                <strong>{l.name}</strong>
                <small>{label}</small>
              </span>
              {mine.length > 0 && kind !== 'bullet' && (
                <span className="progress">
                  <span style={{ width: `${ratio * 100}%`, background: l.color }} />
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

  const kind = listKind(list);
  const mine = items.docs.filter((i) => i.listId === id);
  const todo = mine.filter((i) => !i.done);
  const done = mine.filter((i) => i.done);
  // Plusieurs éléments d'un coup en les séparant par des virgules (pas pour les listes simples et les
  // projets, où un titre de livre ou de tâche peut contenir une virgule).
  const multi = kind === 'todo' || kind === 'shopping';

  const add = (e: FormEvent) => {
    e.preventDefault();
    const parts = (multi ? text.split(',') : [text]).map((s) => s.trim()).filter(Boolean);
    parts.forEach((t) => items.create({ listId: id, text: t, done: false }));
    setText('');
  };
  const check = (i: Doc<ListItem>) => items.update(i.id, { done: true, doneBy: me.member.id });
  const placeholder = {
    todo: 'Ajouter (ex : appeler le dentiste, arroser)',
    shopping: 'Ajouter (ex : lait, pain, œufs)',
    bullet: 'Ajouter un élément',
    kanban: 'Nouvelle tâche',
  }[kind];

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
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} />
        <button className="btn primary" disabled={!text.trim()} style={{ background: list.color }}>
          Ajouter
        </button>
      </form>

      {!mine.length && <Empty>La liste est vide.</Empty>}

      {kind === 'bullet' && (
        <ul className="items">
          {mine.map((i) => (
            <li key={i.id} className="item">
              <span className="list-dot" style={{ background: list.color, width: 8, height: 8 }} />
              <span className="grow">{i.text}</span>
              <button className="icon-btn subtle" onClick={() => items.remove(i.id)} aria-label="Supprimer">
                <X size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {kind === 'kanban' && <Kanban list={list} mine={mine} items={items} />}

      {kind === 'todo' && (
        <ul className="items">
          {todo.map((i) => (
            <Item key={i.id} item={i} color={list.color} onToggle={() => check(i)} onDelete={() => items.remove(i.id)} />
          ))}
        </ul>
      )}

      {kind === 'shopping' &&
        groupByAisle(todo).map((g) => (
          <div key={g.aisle}>
            <div className="section-title">
              <span>{g.aisle}</span>
            </div>
            <ul className="items">
              {g.items.map((i) => (
                <Item key={i.id} item={i} color={list.color} onToggle={() => check(i)} onDelete={() => items.remove(i.id)} />
              ))}
            </ul>
          </div>
        ))}

      {(kind === 'todo' || kind === 'shopping') && done.length > 0 && (
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

const COLUMNS: { id: ItemStatus; label: string }[] = [
  { id: 'todo', label: 'À faire' },
  { id: 'doing', label: 'En cours' },
  { id: 'done', label: 'Fait' },
];

function Kanban({
  list,
  mine,
  items,
}: {
  list: List;
  mine: Doc<ListItem>[];
  items: Collection<ListItem>;
}) {
  const { byId } = useMembers();
  const me = useMe();
  if (!mine.length) return null;
  const ratio = progress(mine);
  const move = (i: Doc<ListItem>, to: ItemStatus) =>
    items.update(i.id, { ...statusPatch(to), doneBy: to === 'done' ? me.member.id : null });

  return (
    <>
      <div className="kanban-progress">
        <span className="progress grow">
          <span style={{ width: `${ratio * 100}%`, background: list.color }} />
        </span>
        <strong>{Math.round(ratio * 100)} %</strong>
      </div>
      {COLUMNS.map((col, c) => {
        const cards = mine.filter((i) => itemStatus(i) === col.id);
        return (
          <div key={col.id}>
            <div className="section-title">
              <span>
                {col.label} ({cards.length})
              </span>
            </div>
            <ul className="items">
              {cards.map((i) => (
                <li key={i.id} className={`item ${col.id === 'done' ? 'done' : ''}`}>
                  <button
                    className="icon-btn subtle"
                    disabled={c === 0}
                    onClick={() => move(i, COLUMNS[c - 1].id)}
                    aria-label={c > 0 ? `Remettre dans « ${COLUMNS[c - 1].label} »` : undefined}
                  >
                    <ArrowLeft size={18} />
                  </button>
                  <span className="grow">
                    {i.text}
                    {col.id === 'done' && byId(i.doneBy) && <small> · {byId(i.doneBy)?.name}</small>}
                  </span>
                  {c < COLUMNS.length - 1 ? (
                    <button
                      className="icon-btn subtle"
                      onClick={() => move(i, COLUMNS[c + 1].id)}
                      aria-label={`Passer à « ${COLUMNS[c + 1].label} »`}
                      style={{ color: list.color }}
                    >
                      <ArrowRight size={18} />
                    </button>
                  ) : (
                    <button className="icon-btn subtle" onClick={() => items.remove(i.id)} aria-label="Supprimer">
                      <X size={18} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </>
  );
}
