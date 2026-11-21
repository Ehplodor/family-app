import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';

/**
 * Boîte aux lettres éphémère pour ajouter un appareil au cercle.
 * L'identifiant est dérivé d'un secret d'invitation que le relais ne connaît pas,
 * et les messages sont chiffrés avec ce secret : le relais ne voit que des octets opaques.
 * Tout est effacé 15 minutes après la première utilisation, ou dès la fin de l'échange.
 */
const TTL = 15 * 60 * 1000;
const MAX = 16 * 1024;

export class Invite extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const box = url.pathname.split('/').filter(Boolean)[2];
    if (box !== 'request' && box !== 'response' && box !== 'done') {
      return Response.json({ error: 'Introuvable' }, { status: 404 });
    }
    const storage = this.ctx.storage;
    let expires = await storage.get<number>('expires');
    if (!expires) {
      expires = Date.now() + TTL;
      await storage.put('expires', expires);
      await storage.setAlarm(expires);
    }
    if (Date.now() > expires) return Response.json({ error: 'Invitation expirée' }, { status: 410 });

    if (box === 'done' && request.method === 'POST') {
      await storage.deleteAll();
      await storage.put('expires', 1); // invitation consommée
      await storage.setAlarm(Date.now() + 60_000);
      return Response.json({ ok: true });
    }
    if (request.method === 'GET') {
      const data = await storage.get<string>(box);
      return data ? Response.json({ data }) : new Response(null, { status: 204 });
    }
    if (request.method === 'POST') {
      const { data } = (await request.json()) as { data?: string };
      if (typeof data !== 'string' || data.length > MAX) return Response.json({ error: 'Invalide' }, { status: 400 });
      // Une seule réponse possible : l'invitation ne peut pas être réutilisée.
      if (box === 'response' && (await storage.get('response'))) {
        return Response.json({ error: 'Déjà utilisée' }, { status: 409 });
      }
      await storage.put(box, data);
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'Méthode non autorisée' }, { status: 405 });
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
