/**
 * Abonnement à un calendrier en ligne (.ics), à la demande d'un appareil du cercle.
 *
 * Les sites de calendriers (Google, Outlook, clubs…) n'autorisent pas un navigateur à lire leurs
 * fichiers depuis un autre site (CORS) : le relais les télécharge donc à la place de l'appli.
 * C'est la seule route où le relais voit des données en clair (l'adresse et le contenu du
 * calendrier public demandé) : rien n'est stocké ni journalisé, et l'appli prévient avant usage.
 * Garde-fous : réservé aux cercles enregistrés (jeton), quota par cercle et par jour,
 * https uniquement, taille et durée limitées, réponse acceptée seulement si c'est un calendrier.
 */

export const ICS_PER_DAY = 60; // téléchargements par cercle et par jour
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

export class IcsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function checkIcsUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length > 2048) throw new IcsError(400, 'Adresse invalide');
  let url: URL;
  try {
    url = new URL(raw.trim().replace(/^webcals?:\/\//i, 'https://'));
  } catch {
    throw new IcsError(400, 'Adresse invalide');
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new IcsError(400, 'Seules les adresses https:// sont acceptées');
  }
  // Pas d'adresse IP ni de nom local : uniquement des sites publics.
  if (/^[\d.]+$|^\[|^localhost$|\.local$|\.internal$/i.test(url.hostname) || !url.hostname.includes('.')) {
    throw new IcsError(400, 'Adresse non autorisée');
  }
  return url;
}

export async function fetchIcs(raw: unknown): Promise<Response> {
  const url = checkIcsUrl(raw);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { Accept: 'text/calendar, text/plain;q=0.5', 'User-Agent': 'FamilyApp-Relay (calendar subscription)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new IcsError(502, 'Calendrier injoignable');
  }
  if (!res.ok || !res.body) throw new IcsError(502, `Le site du calendrier a répondu ${res.status}`);
  if (Number(res.headers.get('Content-Length') ?? 0) > MAX_BYTES) throw new IcsError(413, 'Calendrier trop volumineux');

  // Lecture plafonnée (la taille annoncée peut mentir ou manquer).
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new IcsError(413, 'Calendrier trop volumineux');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  // Le relais ne doit pas servir de proxy vers n'importe quelle page : seulement des calendriers.
  if (!/^﻿?\s*BEGIN:VCALENDAR/i.test(text)) throw new IcsError(415, "Cette adresse ne renvoie pas un calendrier (.ics)");
  return new Response(text, { headers: { 'Content-Type': 'text/calendar; charset=utf-8' } });
}
