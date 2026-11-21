// Types de listes et petits calculs associés (fonctions pures, testées dans lists.test.ts).
//
// Compatibilité : `kind` et `status` sont des champs facultatifs ajoutés après coup. Une liste sans `kind`
// est une liste « à cocher » (comportement d'origine). Le champ `done` reste toujours à jour, pour que les
// anciennes versions de l'appli continuent d'afficher correctement les éléments.

export type ListKind = 'todo' | 'bullet' | 'shopping' | 'kanban';
export type ItemStatus = 'todo' | 'doing' | 'done';

export const LIST_KINDS: { id: ListKind; label: string; hint: string }[] = [
  { id: 'todo', label: 'À cocher', hint: 'Choses à faire, avec cases à cocher' },
  { id: 'shopping', label: 'Courses', hint: 'Rangée par rayon, on coche en magasin' },
  { id: 'bullet', label: 'Simple', hint: 'Une liste à puces : livres, idées, films…' },
  { id: 'kanban', label: 'Projet', hint: 'Tâches en colonnes : à faire, en cours, fait' },
];

const KINDS = new Set<string>(LIST_KINDS.map((k) => k.id));

export function listKind(list: { kind?: unknown }): ListKind {
  return typeof list.kind === 'string' && KINDS.has(list.kind) ? (list.kind as ListKind) : 'todo';
}

/** Statut d'un élément : `done` (que les anciennes versions modifient) a toujours le dernier mot. */
export function itemStatus(item: { done?: boolean; status?: unknown }): ItemStatus {
  if (item.done) return 'done';
  return item.status === 'doing' ? 'doing' : 'todo';
}

/** Champs à écrire pour passer un élément à un statut (garde `done` cohérent). */
export function statusPatch(status: ItemStatus) {
  return { status, done: status === 'done' };
}

/** Avancement d'un projet, de 0 à 1 (« en cours » compte pour moitié). */
export function progress(items: { done?: boolean; status?: unknown }[]): number {
  if (!items.length) return 0;
  const score = items.reduce((s, i) => s + { todo: 0, doing: 0.5, done: 1 }[itemStatus(i)], 0);
  return score / items.length;
}

// Rayons du magasin, dans l'ordre d'un parcours habituel. Devinés à partir de mots-clés (début de mot).
export const AISLES: { name: string; words: string[] }[] = [
  { name: 'Fruits et légumes', words: ['pomme', 'poire', 'banane', 'orange', 'citron', 'fraise', 'raisin', 'kiwi', 'clementine', 'mandarine', 'peche', 'abricot', 'melon', 'pasteque', 'ananas', 'mangue', 'avocat', 'tomate', 'salade', 'laitue', 'carotte', 'courgette', 'aubergine', 'poivron', 'concombre', 'oignon', 'ail', 'echalote', 'patate', 'pomme de terre', 'poireau', 'chou', 'brocoli', 'epinard', 'haricot', 'champignon', 'radis', 'navet', 'betterave', 'persil', 'basilic', 'coriandre', 'menthe', 'fruit', 'legume'] },
  { name: 'Boulangerie', words: ['pain', 'baguette', 'brioche', 'croissant', 'viennoiserie', 'biscotte'] },
  { name: 'Viandes et poissons', words: ['poulet', 'boeuf', 'porc', 'veau', 'agneau', 'dinde', 'steak', 'viande', 'jambon', 'saucisse', 'lardon', 'chorizo', 'saumon', 'thon', 'cabillaud', 'poisson', 'crevette', 'merguez'] },
  { name: 'Frais', words: ['lait', 'beurre', 'creme', 'yaourt', 'yogourt', 'fromage', 'emmental', 'gruyere', 'comte', 'mozzarella', 'parmesan', 'oeuf', 'compote', 'pate feuilletee', 'pate brisee', 'jus'] },
  { name: 'Épicerie', words: ['pates', 'spaghetti', 'riz', 'farine', 'sucre', 'sel', 'poivre', 'huile', 'vinaigre', 'moutarde', 'ketchup', 'mayonnaise', 'sauce', 'conserve', 'cafe', 'the', 'chocolat', 'cereale', 'confiture', 'miel', 'biscuit', 'gateau', 'chips', 'levure', 'epice', 'lentille', 'pois chiche', 'semoule', 'soupe', 'bonbon'] },
  { name: 'Boissons', words: ['eau', 'soda', 'coca', 'biere', 'vin', 'sirop', 'limonade'] },
  { name: 'Surgelés', words: ['surgele', 'glace', 'frite', 'pizza'] },
  { name: 'Hygiène et maison', words: ['savon', 'shampo', 'dentifrice', 'brosse', 'gel douche', 'deodorant', 'papier toilette', 'mouchoir', 'essuie', 'sopalin', 'lessive', 'liquide vaisselle', 'eponge', 'sac poubelle', 'couche', 'lingette', 'coton', 'rasoir', 'nettoyant', 'javel'] },
];
export const OTHER_AISLE = 'Autres';

function normalize(s: string) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/œ/g, 'oe');
}

/** Rayon probable d'un article (« 2 litres de lait » → Frais). */
export function guessAisle(text: string): string {
  const t = ' ' + normalize(text).replace(/[^a-z0-9]+/g, ' ') + ' ';
  // On cherche d'abord les expressions les plus longues (« pomme de terre » avant « pomme »).
  let best: { name: string; len: number } | null = null;
  for (const a of AISLES) {
    for (const w of a.words) {
      if (t.includes(' ' + w) && (!best || w.length > best.len)) best = { name: a.name, len: w.length };
    }
  }
  return best?.name ?? OTHER_AISLE;
}

/** Regroupe des articles par rayon, dans l'ordre du magasin. */
export function groupByAisle<T extends { text: string }>(items: T[]): { aisle: string; items: T[] }[] {
  const order = [...AISLES.map((a) => a.name), OTHER_AISLE];
  const groups = new Map<string, T[]>();
  for (const i of items) {
    const a = guessAisle(i.text);
    groups.set(a, [...(groups.get(a) ?? []), i]);
  }
  return order.filter((a) => groups.has(a)).map((aisle) => ({ aisle, items: groups.get(aisle)! }));
}
