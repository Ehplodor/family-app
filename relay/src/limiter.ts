import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';

/**
 * Compteur à fenêtre fixe (un objet par empreinte « adresse IP + jour »).
 * Il ne stocke qu'un nombre : ni adresse IP, ni identifiant de cercle. Effacé au bout de 2 jours.
 */
export class Limiter extends DurableObject<Env> {
  async hit(max: number): Promise<boolean> {
    const count = ((await this.ctx.storage.get<number>('n')) ?? 0) + 1;
    if (count === 1) await this.ctx.storage.setAlarm(Date.now() + 2 * 86_400_000);
    await this.ctx.storage.put('n', count);
    return count <= max;
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
