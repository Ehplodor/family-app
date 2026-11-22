/**
 * Accès aux données pour les écrans : mêmes opérations qu'avant (lister, créer, modifier, supprimer), mais
 * tout passe par le coffre (cercles, signatures, droits). `groups` (facultatif) : cercles qui voient l'élément.
 */
import type { Engine } from './engine';
import type { Item } from './vault';

export class Data {
  constructor(private engine: Engine) {}
  private get vault() {
    return this.engine.vault;
  }

  subscribe(_name: string, l: () => void) {
    return this.vault.subscribe(l);
  }

  list<T>(name: string): Item<T>[] {
    return this.vault.list<T>(name);
  }

  get<T>(name: string, id: string): Item<T> | undefined {
    return this.vault.get<T>(name, id);
  }

  create<T extends object>(name: string, data: T & { groups?: string[] }, id?: string): Promise<Item<T>> {
    return this.vault.create<T>(name, data, { groups: data.groups, id });
  }

  update<T extends object>(name: string, id: string, patch: Partial<T> & { groups?: string[] }) {
    return this.vault.update<T>(name, id, patch, patch.groups);
  }

  upsert<T extends object>(name: string, id: string, patch: Partial<T> & { groups?: string[] }) {
    return this.vault.upsert<T>(name, id, patch, patch.groups);
  }

  /** Supprime pour tout le monde (propriétaire) ou seulement pour soi (les autres). */
  remove(name: string, id: string) {
    return this.vault.remove(name, id);
  }

  async removeMany(name: string, ids: string[]) {
    for (const id of ids) await this.vault.remove(name, id);
  }

  /** Peut-on modifier ces champs (ou supprimer pour tous) ? */
  canEdit(name: string, id: string, fields?: string[], remove = false) {
    return this.vault.canEdit(name, id, fields, remove);
  }
}
