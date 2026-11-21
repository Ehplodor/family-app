/**
 * Relais « aveugle » de Family App (Cloudflare Worker + Durable Objects).
 *
 * Il ne reçoit QUE des données chiffrées de bout en bout par les appareils du cercle :
 * il ne possède aucune clé et ne peut ni lire ni modifier le contenu.
 * Rôles :
 *  - boîte aux lettres : conserve le journal chiffré pour les appareils hors ligne ;
 *  - temps réel : diffuse chaque nouveau paquet chiffré aux appareils connectés ;
 *  - photos : stocke les fichiers chiffrés ;
 *  - rappels : envoie, à l'heure dite, des notifications Web Push dont le contenu est chiffré ;
 *  - invitations : boîte aux lettres éphémère (15 min) pour ajouter un appareil.
 */
import { Circle } from './circle';
import { Invite } from './invite';
import { Limiter } from './limiter';

export { Circle, Invite, Limiter };

export interface Env {
  CIRCLE: DurableObjectNamespace<Circle>;
  INVITE: DurableObjectNamespace<Invite>;
  LIMITER: DurableObjectNamespace<Limiter>;
  ALLOWED_ORIGINS: string;
  /** Garde-fous pour un relais ouvert au public (voir wrangler.toml). */
  NEW_CIRCLES_PER_IP_PER_DAY?: string;
  CIRCLE_QUOTA_MB?: string;
  INACTIVE_DAYS?: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_JWK: string;
  VAPID_SUBJECT: string;
}

const ID_RE = /^[0-9a-f]{32}$/;

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  const allow = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function originAllowed(request: Request, env: Env) {
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  return allowed.includes('*') || allowed.includes(request.headers.get('Origin') ?? '');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    const [kind, id] = url.pathname.split('/').filter(Boolean);
    let res: Response;

    if (!kind) {
      res = new Response('Family App relay: ok', { headers: { 'Content-Type': 'text/plain' } });
    } else if (kind === 'vapid' && request.method === 'GET') {
      res = Response.json({ publicKey: env.VAPID_PUBLIC_KEY ?? null });
    } else if (kind === 'limits' && request.method === 'GET') {
      // Affiché dans l'appli (page « À propos et confidentialité »).
      res = Response.json({
        quotaMb: Number(env.CIRCLE_QUOTA_MB || 250),
        inactiveDays: Number(env.INACTIVE_DAYS || 400),
        newCirclesPerDay: Number(env.NEW_CIRCLES_PER_IP_PER_DAY || 10),
      });
    } else if ((kind === 'c' || kind === 'i') && id && ID_RE.test(id)) {
      if (request.headers.get('Upgrade') === 'websocket' && !originAllowed(request, env)) {
        return new Response('Origine refusée', { status: 403 });
      }
      const ns = kind === 'c' ? env.CIRCLE : env.INVITE;
      res = await ns.get(ns.idFromName(id)).fetch(request);
      if (res.status === 101) return res; // WebSocket : on ne touche pas à la réponse
    } else {
      res = Response.json({ error: 'Introuvable' }, { status: 404 });
    }

    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    out.headers.set('X-Content-Type-Options', 'nosniff');
    out.headers.set('Cache-Control', 'no-store');
    return out;
  },
} satisfies ExportedHandler<Env>;
