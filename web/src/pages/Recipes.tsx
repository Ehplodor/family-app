import { useState } from 'react';
import { Clock, CookingPot, Pencil, Search, Trash2, Users } from 'lucide-react';
import { useCollection } from '../store';
import { navigate, goBack } from '../router';
import { Empty, Fab, Field, Page, Sheet, confirmDelete } from '../ui';

export type Recipe = {
  title: string;
  duration?: string;
  servings?: string;
  ingredients: string; // un ingrédient par ligne
  steps: string;
  link?: string;
};

export const ingredientsOf = (r: Recipe) =>
  r.ingredients
    .split('\n')
    .map((s) => s.replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean);

export function RecipesSummary() {
  const { docs } = useCollection<Recipe>('recipes');
  return <>{docs.length ? `${docs.length} recette${docs.length > 1 ? 's' : ''}` : 'Votre livre de recettes'}</>;
}

export function RecipesPage({ params }: { params: string[] }) {
  return params[0] ? <RecipeDetail id={params[0]} /> : <RecipeList />;
}

function RecipeList() {
  const recipes = useCollection<Recipe>('recipes');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const q = query.trim().toLowerCase();
  const list = recipes.docs
    .filter((r) => !q || `${r.title} ${r.ingredients}`.toLowerCase().includes(q))
    .sort((a, b) => a.title.localeCompare(b.title, 'fr'));

  return (
    <Page title="Recettes">
      {recipes.docs.length > 5 && (
        <label className="search">
          <Search size={18} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Titre ou ingrédient" />
        </label>
      )}
      {recipes.loaded && !recipes.docs.length && (
        <Empty icon={<CookingPot size={48} />}>Les recettes de la famille, à utiliser ensuite dans le planning des repas.</Empty>
      )}
      <div className="stack">
        {list.map((r) => (
          <button key={r.id} className="card row-card" onClick={() => navigate(`/m/recipes/${r.id}`)}>
            <span className="grow">
              <strong>{r.title}</strong>
              <small>
                {[r.duration, `${ingredientsOf(r).length} ingrédients`].filter(Boolean).join(' · ')}
              </small>
            </span>
          </button>
        ))}
      </div>
      <Fab onClick={() => setAdding(true)} label="Nouvelle recette" />
      <Sheet open={adding} title="Nouvelle recette" onClose={() => setAdding(false)}>
        <RecipeForm
          onSubmit={async (r) => {
            const doc = await recipes.create(r);
            setAdding(false);
            navigate(`/m/recipes/${doc.id}`);
          }}
        />
      </Sheet>
    </Page>
  );
}

function RecipeDetail({ id }: { id: string }) {
  const recipes = useCollection<Recipe>('recipes');
  const [editing, setEditing] = useState(false);
  const r = recipes.docs.find((x) => x.id === id);
  if (!r) return <Page title="Recette" back="/m/recipes">{recipes.loaded && <Empty>Recette introuvable.</Empty>}</Page>;

  return (
    <Page
      title={r.title}
      back="/m/recipes"
      actions={
        <>
          <button className="icon-btn" onClick={() => setEditing(true)} aria-label="Modifier">
            <Pencil size={20} />
          </button>
          <button
            className="icon-btn"
            aria-label="Supprimer"
            onClick={async () => {
              if (confirmDelete(`la recette « ${r.title} »`)) {
                await recipes.remove(id);
                goBack('/m/recipes');
              }
            }}
          >
            <Trash2 size={20} />
          </button>
        </>
      }
    >
      <div className="chips">
        {r.duration && (
          <span className="pill">
            <Clock size={14} /> {r.duration}
          </span>
        )}
        {r.servings && (
          <span className="pill">
            <Users size={14} /> {r.servings}
          </span>
        )}
        {safeLink(r.link) && (
          <a className="pill accent" href={safeLink(r.link)} target="_blank" rel="noreferrer">
            Source
          </a>
        )}
      </div>
      <div className="card">
        <h3>Ingrédients</h3>
        <ul className="bullets">
          {ingredientsOf(r).map((ing, i) => (
            <li key={i}>{ing}</li>
          ))}
        </ul>
      </div>
      {r.steps.trim() && (
        <div className="card">
          <h3>Préparation</h3>
          <p className="prewrap">{r.steps}</p>
        </div>
      )}
      <Sheet open={editing} title="Modifier la recette" onClose={() => setEditing(false)}>
        <RecipeForm
          initial={r}
          onSubmit={async (x) => {
            await recipes.update(id, x);
            setEditing(false);
          }}
        />
      </Sheet>
    </Page>
  );
}

function RecipeForm({ initial, onSubmit }: { initial?: Recipe; onSubmit: (r: Recipe) => void }) {
  const [r, setR] = useState<Recipe>(initial ?? { title: '', duration: '', servings: '', ingredients: '', steps: '', link: '' });
  const set = (patch: Partial<Recipe>) => setR((x) => ({ ...x, ...patch }));
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (r.title.trim()) onSubmit({ ...r, title: r.title.trim() });
      }}
    >
      <Field label="Titre">
        <input autoFocus={!initial} value={r.title} onChange={(e) => set({ title: e.target.value })} />
      </Field>
      <div className="row">
        <Field label="Durée">
          <input value={r.duration ?? ''} onChange={(e) => set({ duration: e.target.value })} placeholder="30 min" />
        </Field>
        <Field label="Portions">
          <input value={r.servings ?? ''} onChange={(e) => set({ servings: e.target.value })} placeholder="4 pers." />
        </Field>
      </div>
      <Field label="Ingrédients (un par ligne)">
        <textarea rows={6} value={r.ingredients} onChange={(e) => set({ ingredients: e.target.value })} placeholder={'200 g de farine\n3 œufs\n50 cl de lait'} />
      </Field>
      <Field label="Préparation">
        <textarea rows={6} value={r.steps} onChange={(e) => set({ steps: e.target.value })} />
      </Field>
      <Field label="Lien (optionnel)">
        <input type="url" value={r.link ?? ''} onChange={(e) => set({ link: e.target.value })} placeholder="https://…" />
      </Field>
      <button className="btn primary" disabled={!r.title.trim()}>
        Enregistrer
      </button>
    </form>
  );
}

/** N'accepte que les liens web (http/https) : jamais « javascript: » ou « data: » saisis dans une recette. */
function safeLink(link?: string): string | undefined {
  if (!link) return undefined;
  try {
    const url = new URL(link.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}
