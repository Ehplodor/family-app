import { useState } from 'react';
import { ChevronLeft, ChevronRight, ShoppingCart } from 'lucide-react';
import { useCollection } from '../store';
import { addDays, capitalize, fmt, startOfWeek, toISODate, today } from '../dates';
import { navigate } from '../router';
import { Field, Page, Sheet } from '../ui';
import type { Doc } from '../api';
import { ingredientsOf, type Recipe } from './Recipes';
import type { List, ListItem } from './Lists';

export type Slot = 'lunch' | 'dinner';
export type Meal = { date: string; slot: Slot; title: string; recipeId?: string | null };

const SLOTS: { id: Slot; label: string }[] = [
  { id: 'lunch', label: 'Midi' },
  { id: 'dinner', label: 'Soir' },
];

export function MealsSummary() {
  const { docs } = useCollection<Meal>('meals');
  const tonight = docs.find((m) => m.date === today() && m.slot === 'dinner');
  return <>{tonight ? `Ce soir : ${tonight.title}` : 'Planifiez vos repas'}</>;
}

export function MealsPage() {
  const meals = useCollection<Meal>('meals');
  const recipes = useCollection<Recipe>('recipes');
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [editing, setEditing] = useState<{ date: string; slot: Slot; meal?: Doc<Meal> } | null>(null);
  const [shopping, setShopping] = useState(false);

  const days = Array.from({ length: 7 }, (_, i) => toISODate(addDays(weekStart, i)));
  const find = (date: string, slot: Slot) => meals.docs.find((m) => m.date === date && m.slot === slot);
  const weekMeals = meals.docs.filter((m) => days.includes(m.date));
  const weekRecipes = recipes.docs.filter((r) => weekMeals.some((m) => m.recipeId === r.id));

  return (
    <Page title="Repas">
      <div className="week-nav">
        <button className="icon-btn" onClick={() => setWeekStart(addDays(weekStart, -7))} aria-label="Semaine précédente">
          <ChevronLeft />
        </button>
        <strong>
          {fmt(days[0], { day: 'numeric', month: 'short' })} – {fmt(days[6], { day: 'numeric', month: 'short' })}
        </strong>
        <button className="icon-btn" onClick={() => setWeekStart(addDays(weekStart, 7))} aria-label="Semaine suivante">
          <ChevronRight />
        </button>
      </div>

      <div className="stack">
        {days.map((d) => (
          <div key={d} className={`card meal-day ${d === today() ? 'highlight' : ''}`}>
            <div className="meal-date">{capitalize(fmt(d, { weekday: 'short', day: 'numeric' }))}</div>
            <div className="meal-slots">
              {SLOTS.map((s) => {
                const meal = find(d, s.id);
                return (
                  <button key={s.id} className={`meal-slot ${meal ? 'filled' : ''}`} onClick={() => setEditing({ date: d, slot: s.id, meal })}>
                    <small>{s.label}</small>
                    <span>{meal?.title ?? '+'}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <button className="btn wide" onClick={() => setShopping(true)} disabled={!weekRecipes.length}>
        <ShoppingCart size={18} /> Ingrédients de la semaine → liste de courses
      </button>
      {!weekRecipes.length && <p className="muted center">Associez des recettes aux repas pour générer la liste de courses.</p>}

      <Sheet open={!!editing} title={editing ? `${capitalize(fmt(editing.date, { weekday: 'long', day: 'numeric' }))} · ${SLOTS.find((s) => s.id === editing.slot)!.label}` : ''} onClose={() => setEditing(null)}>
        {editing && (
          <MealForm
            meal={editing.meal}
            recipes={recipes.docs}
            onSubmit={async (title, recipeId) => {
              if (editing.meal) await meals.update(editing.meal.id, { title, recipeId });
              else await meals.create({ date: editing.date, slot: editing.slot, title, recipeId });
              setEditing(null);
            }}
            onClear={
              editing.meal
                ? () => {
                    meals.remove(editing.meal!.id);
                    setEditing(null);
                  }
                : undefined
            }
          />
        )}
      </Sheet>

      <Sheet open={shopping} title="Liste de courses" onClose={() => setShopping(false)}>
        <ShoppingForm recipes={weekRecipes} onDone={() => setShopping(false)} />
      </Sheet>
    </Page>
  );
}

function MealForm({
  meal,
  recipes,
  onSubmit,
  onClear,
}: {
  meal?: Meal;
  recipes: Doc<Recipe>[];
  onSubmit: (title: string, recipeId: string | null) => void;
  onClear?: () => void;
}) {
  const [title, setTitle] = useState(meal?.title ?? '');
  const [recipeId, setRecipeId] = useState(meal?.recipeId ?? '');
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) onSubmit(title.trim(), recipeId || null);
      }}
    >
      {recipes.length > 0 && (
        <Field label="Recette">
          <select
            value={recipeId}
            onChange={(e) => {
              setRecipeId(e.target.value);
              const r = recipes.find((x) => x.id === e.target.value);
              if (r) setTitle(r.title);
            }}
          >
            <option value="">— Aucune —</option>
            {recipes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Au menu">
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Pâtes carbonara, restes, pizza…" />
      </Field>
      <div className="form-actions">
        {onClear && (
          <button type="button" className="btn danger" onClick={onClear}>
            Vider
          </button>
        )}
        <button className="btn primary grow" disabled={!title.trim()}>
          Enregistrer
        </button>
      </div>
    </form>
  );
}

function ShoppingForm({ recipes, onDone }: { recipes: Doc<Recipe>[]; onDone: () => void }) {
  const lists = useCollection<List>('lists');
  const items = useCollection<ListItem>('listItems');
  const all = [...new Set(recipes.flatMap(ingredientsOf))];
  const [checked, setChecked] = useState<string[]>(all);
  const [listId, setListId] = useState(lists.docs[0]?.id ?? '');

  const submit = async () => {
    let target = listId;
    if (!target) target = (await lists.create({ name: 'Courses', color: '#2D9CDB' })).id;
    const existing = new Set(items.docs.filter((i) => i.listId === target && !i.done).map((i) => i.text.toLowerCase()));
    await Promise.all(
      checked.filter((t) => !existing.has(t.toLowerCase())).map((text) => items.create({ listId: target, text, done: false })),
    );
    onDone();
    navigate(`/m/lists/${target}`);
  };

  return (
    <div className="form">
      <Field label="Ajouter à la liste">
        <select value={listId} onChange={(e) => setListId(e.target.value)}>
          {lists.docs.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
          <option value="">+ Nouvelle liste « Courses »</option>
        </select>
      </Field>
      <div className="checklist">
        {all.map((ing) => (
          <label key={ing} className="toggle">
            <input
              type="checkbox"
              checked={checked.includes(ing)}
              onChange={(e) => setChecked(e.target.checked ? [...checked, ing] : checked.filter((c) => c !== ing))}
            />
            {ing}
          </label>
        ))}
      </div>
      <button className="btn primary" onClick={submit} disabled={!checked.length}>
        Ajouter {checked.length} élément{checked.length > 1 ? 's' : ''}
      </button>
    </div>
  );
}
