import { describe, expect, it } from 'vitest';
import { groupByAisle, guessAisle, itemStatus, listKind, progress, statusPatch } from './lists';

describe('types de listes', () => {
  it('une liste existante (sans type) reste une liste à cocher', () => {
    expect(listKind({})).toBe('todo');
    expect(listKind({ kind: 'inconnu' })).toBe('todo');
    expect(listKind({ kind: 'kanban' })).toBe('kanban');
  });

  it('le champ done des anciennes versions a le dernier mot', () => {
    expect(itemStatus({ done: false })).toBe('todo');
    expect(itemStatus({ done: true })).toBe('done');
    expect(itemStatus({ done: false, status: 'doing' })).toBe('doing');
    // Décoché par une ancienne version : on revient à « à faire ».
    expect(itemStatus({ done: false, status: 'done' })).toBe('todo');
    expect(itemStatus({ done: true, status: 'doing' })).toBe('done');
    expect(statusPatch('done')).toEqual({ status: 'done', done: true });
    expect(statusPatch('doing')).toEqual({ status: 'doing', done: false });
  });

  it('calcule l’avancement', () => {
    expect(progress([])).toBe(0);
    expect(progress([{ done: true }, { done: false, status: 'doing' }])).toBe(0.75);
  });

  it('devine le rayon', () => {
    expect(guessAisle('2 litres de Lait')).toBe('Frais');
    expect(guessAisle('pommes de terre')).toBe('Fruits et légumes');
    expect(guessAisle('Œufs')).toBe('Frais');
    expect(guessAisle('pâtes')).toBe('Épicerie');
    expect(guessAisle('truc bizarre')).toBe('Autres');
    expect(groupByAisle([{ text: 'savon' }, { text: 'pain' }, { text: 'zzz' }]).map((g) => g.aisle)).toEqual([
      'Boulangerie',
      'Hygiène et maison',
      'Autres',
    ]);
  });
});
