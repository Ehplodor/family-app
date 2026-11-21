import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const COOKIE = 'fa_session';
const ONE_YEAR_S = 365 * 24 * 3600;
const COLLECTION_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const RESERVED_KEYS = new Set(['id', 'createdBy', 'createdAt', 'updatedAt']);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const now = () => new Date().toISOString();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function makeInviteCode() {
  let code = '';
  for (let i = 0; i < 8; i++) code += INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)];
  return code;
}
const normalizeInvite = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function text(value, field, max = 80) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) throw new HttpError(400, `Le champ « ${field} » est requis`);
  if (v.length > max) throw new HttpError(400, `Le champ « ${field} » est trop long`);
  return v;
}
function color(value) {
  if (value === undefined) return '#7C5CE0';
  if (typeof value !== 'string' || !COLOR_RE.test(value)) throw new HttpError(400, 'Couleur invalide');
  return value;
}
function plainObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, `« ${field} » doit être un objet`);
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) if (!RESERVED_KEYS.has(k)) out[k] = v;
  if (JSON.stringify(out).length > 100_000) throw new HttpError(413, 'Document trop volumineux');
  return out;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Limiteur très simple (mémoire) pour éviter de deviner les codes d'invitation. */
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, _res, next) => {
    const key = req.ip;
    const t = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < t) hits.set(key, { count: 1, reset: t + windowMs });
    else if (++h.count > max) return next(new HttpError(429, 'Trop de tentatives, réessayez plus tard'));
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < t) hits.delete(k);
    next();
  };
}

export function createApp({ db, uploadDir, staticDir }) {
  fs.mkdirSync(uploadDir, { recursive: true });
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

  // ---------- Temps réel (Server-Sent Events) ----------
  const streams = new Map(); // familyId -> Set<res>
  function broadcast(familyId, event) {
    const set = streams.get(familyId);
    if (!set) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of set) res.write(payload);
  }

  // ---------- Requêtes SQL ----------
  const q = {
    insertFamily: db.prepare('INSERT INTO families (id, name, invite_code, settings, created_at) VALUES (?, ?, ?, ?, ?)'),
    familyById: db.prepare('SELECT * FROM families WHERE id = ?'),
    familyByInvite: db.prepare('SELECT * FROM families WHERE invite_code = ?'),
    updateFamily: db.prepare('UPDATE families SET name = ?, settings = ? WHERE id = ?'),
    updateInvite: db.prepare('UPDATE families SET invite_code = ? WHERE id = ?'),
    insertMember: db.prepare('INSERT INTO members (id, family_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)'),
    membersOf: db.prepare('SELECT id, name, color FROM members WHERE family_id = ? ORDER BY created_at'),
    memberById: db.prepare('SELECT * FROM members WHERE id = ?'),
    updateMember: db.prepare('UPDATE members SET name = ?, color = ? WHERE id = ?'),
    deleteMember: db.prepare('DELETE FROM members WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, member_id, created_at) VALUES (?, ?, ?)'),
    sessionMember: db.prepare(
      'SELECT m.* FROM sessions s JOIN members m ON m.id = s.member_id WHERE s.token_hash = ?',
    ),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    listDocs: db.prepare('SELECT * FROM docs WHERE family_id = ? AND collection = ? ORDER BY created_at'),
    getDoc: db.prepare('SELECT * FROM docs WHERE id = ? AND family_id = ? AND collection = ?'),
    insertDoc: db.prepare(
      'INSERT INTO docs (id, family_id, collection, data, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    updateDoc: db.prepare('UPDATE docs SET data = ?, updated_at = ? WHERE id = ?'),
    deleteDoc: db.prepare('DELETE FROM docs WHERE id = ?'),
    insertFile: db.prepare('INSERT INTO files (id, family_id, mime, size, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    getFile: db.prepare('SELECT * FROM files WHERE id = ? AND family_id = ?'),
    deleteFile: db.prepare('DELETE FROM files WHERE id = ?'),
  };

  const docOut = (row) => ({
    ...JSON.parse(row.data),
    id: row.id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  const familyOut = (f) => ({
    id: f.id,
    name: f.name,
    inviteCode: f.invite_code,
    settings: JSON.parse(f.settings),
  });

  function startSession(res, req, memberId) {
    const token = crypto.randomBytes(32).toString('base64url');
    q.insertSession.run(sha256(token), memberId, now());
    const secure = req.secure || process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ONE_YEAR_S}${secure}`,
    );
  }

  function mePayload(member) {
    const family = q.familyById.get(member.family_id);
    return {
      member: { id: member.id, name: member.name, color: member.color },
      family: familyOut(family),
      members: q.membersOf.all(family.id),
    };
  }

  function auth(req, _res, next) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const member = token && q.sessionMember.get(sha256(token));
    if (!member) return next(new HttpError(401, 'Non connecté'));
    req.member = member;
    req.familyId = member.family_id;
    next();
  }

  function collectionParam(req) {
    const c = req.params.collection;
    if (!COLLECTION_RE.test(c)) throw new HttpError(400, 'Collection invalide');
    return c;
  }

  function removeFileFromDisk(id) {
    fs.rm(path.join(uploadDir, id), { force: true }, () => {});
  }

  const api = express.Router();
  api.use(express.json({ limit: '1mb' }));

  // ---------- Création / rejoindre une famille ----------
  api.post('/families', (req, res) => {
    const familyName = text(req.body?.familyName, 'Nom de la famille');
    const memberName = text(req.body?.memberName, 'Votre prénom', 40);
    const memberColor = color(req.body?.color);
    const familyId = crypto.randomUUID();
    const memberId = crypto.randomUUID();
    let invite = makeInviteCode();
    while (q.familyByInvite.get(invite)) invite = makeInviteCode();
    q.insertFamily.run(familyId, familyName, invite, '{}', now());
    q.insertMember.run(memberId, familyId, memberName, memberColor, now());
    startSession(res, req, memberId);
    res.status(201).json(mePayload(q.memberById.get(memberId)));
  });

  const joinLimiter = rateLimit({ windowMs: 10 * 60_000, max: 30 });

  api.post('/join/lookup', joinLimiter, (req, res) => {
    const family = q.familyByInvite.get(normalizeInvite(req.body?.inviteCode));
    if (!family) throw new HttpError(404, "Code d'invitation inconnu");
    res.json({ familyName: family.name, members: q.membersOf.all(family.id) });
  });

  api.post('/join', joinLimiter, (req, res) => {
    const family = q.familyByInvite.get(normalizeInvite(req.body?.inviteCode));
    if (!family) throw new HttpError(404, "Code d'invitation inconnu");
    let memberId = req.body?.memberId;
    if (memberId) {
      const m = q.memberById.get(memberId);
      if (!m || m.family_id !== family.id) throw new HttpError(404, 'Membre introuvable');
    } else {
      memberId = crypto.randomUUID();
      q.insertMember.run(memberId, family.id, text(req.body?.memberName, 'Votre prénom', 40), color(req.body?.color), now());
      broadcast(family.id, { type: 'family' });
    }
    startSession(res, req, memberId);
    res.status(201).json(mePayload(q.memberById.get(memberId)));
  });

  // ---------- Session ----------
  api.get('/me', auth, (req, res) => res.json(mePayload(req.member)));

  api.post('/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) q.deleteSession.run(sha256(token));
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.status(204).end();
  });

  // ---------- Famille & membres ----------
  api.patch('/family', auth, (req, res) => {
    const f = q.familyById.get(req.familyId);
    const name = req.body?.name !== undefined ? text(req.body.name, 'Nom de la famille') : f.name;
    const settings = req.body?.settings !== undefined
      ? { ...JSON.parse(f.settings), ...plainObject(req.body.settings, 'settings') }
      : JSON.parse(f.settings);
    q.updateFamily.run(name, JSON.stringify(settings), f.id);
    broadcast(f.id, { type: 'family' });
    res.json(familyOut(q.familyById.get(f.id)));
  });

  api.post('/family/invite', auth, (req, res) => {
    let invite = makeInviteCode();
    while (q.familyByInvite.get(invite)) invite = makeInviteCode();
    q.updateInvite.run(invite, req.familyId);
    broadcast(req.familyId, { type: 'family' });
    res.json(familyOut(q.familyById.get(req.familyId)));
  });

  api.post('/members', auth, (req, res) => {
    const id = crypto.randomUUID();
    q.insertMember.run(id, req.familyId, text(req.body?.name, 'Prénom', 40), color(req.body?.color), now());
    broadcast(req.familyId, { type: 'family' });
    res.status(201).json(q.membersOf.all(req.familyId).find((m) => m.id === id));
  });

  function familyMember(req) {
    const m = q.memberById.get(req.params.id);
    if (!m || m.family_id !== req.familyId) throw new HttpError(404, 'Membre introuvable');
    return m;
  }

  api.patch('/members/:id', auth, (req, res) => {
    const m = familyMember(req);
    const name = req.body?.name !== undefined ? text(req.body.name, 'Prénom', 40) : m.name;
    const c = req.body?.color !== undefined ? color(req.body.color) : m.color;
    q.updateMember.run(name, c, m.id);
    broadcast(req.familyId, { type: 'family' });
    res.json({ id: m.id, name, color: c });
  });

  api.delete('/members/:id', auth, (req, res) => {
    const m = familyMember(req);
    if (m.id === req.member.id) throw new HttpError(400, 'Vous ne pouvez pas vous supprimer vous-même');
    q.deleteMember.run(m.id);
    broadcast(req.familyId, { type: 'family' });
    res.status(204).end();
  });

  // ---------- Temps réel ----------
  api.get('/stream', auth, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    let set = streams.get(req.familyId);
    if (!set) streams.set(req.familyId, (set = new Set()));
    set.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      set.delete(res);
      if (!set.size) streams.delete(req.familyId);
    });
  });

  // ---------- Documents génériques ----------
  api.get('/docs/:collection', auth, (req, res) => {
    res.json(q.listDocs.all(req.familyId, collectionParam(req)).map(docOut));
  });

  api.post('/docs/:collection', auth, (req, res) => {
    const collection = collectionParam(req);
    const data = plainObject(req.body?.data, 'data');
    const id = crypto.randomUUID();
    const t = now();
    q.insertDoc.run(id, req.familyId, collection, JSON.stringify(data), req.member.id, t, t);
    broadcast(req.familyId, { type: 'docs', collection });
    res.status(201).json(docOut(q.getDoc.get(id, req.familyId, collection)));
  });

  api.patch('/docs/:collection/:id', auth, (req, res) => {
    const collection = collectionParam(req);
    const row = q.getDoc.get(req.params.id, req.familyId, collection);
    if (!row) throw new HttpError(404, 'Introuvable');
    const merged = { ...JSON.parse(row.data), ...plainObject(req.body?.data, 'data') };
    q.updateDoc.run(JSON.stringify(merged), now(), row.id);
    broadcast(req.familyId, { type: 'docs', collection });
    res.json(docOut(q.getDoc.get(row.id, req.familyId, collection)));
  });

  api.delete('/docs/:collection/:id', auth, (req, res) => {
    const collection = collectionParam(req);
    const row = q.getDoc.get(req.params.id, req.familyId, collection);
    if (!row) throw new HttpError(404, 'Introuvable');
    q.deleteDoc.run(row.id);
    // Un document qui référence une photo (galerie) entraîne sa suppression.
    const { fileId } = JSON.parse(row.data);
    if (typeof fileId === 'string' && q.getFile.get(fileId, req.familyId)) {
      q.deleteFile.run(fileId);
      removeFileFromDisk(fileId);
    }
    broadcast(req.familyId, { type: 'docs', collection });
    res.status(204).end();
  });

  // ---------- Fichiers (photos) ----------
  api.post('/files', auth, express.raw({ type: 'image/*', limit: '15mb' }), (req, res) => {
    const mime = (req.headers['content-type'] || '').split(';')[0].trim();
    if (!IMAGE_TYPES.has(mime)) throw new HttpError(415, "Format d'image non pris en charge");
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Fichier vide');
    const id = crypto.randomUUID();
    fs.writeFileSync(path.join(uploadDir, id), req.body);
    q.insertFile.run(id, req.familyId, mime, req.body.length, req.member.id, now());
    res.status(201).json({ id, url: `/api/files/${id}` });
  });

  api.get('/files/:id', auth, (req, res) => {
    const f = q.getFile.get(req.params.id, req.familyId);
    if (!f) throw new HttpError(404, 'Introuvable');
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(path.join(uploadDir, f.id));
  });

  api.use((_req, _res, next) => next(new HttpError(404, 'Route inconnue')));

  app.use('/api', api);

  // ---------- Front-end (build Vite) ----------
  if (staticDir && fs.existsSync(staticDir)) {
    app.use('/assets', express.static(path.join(staticDir, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(staticDir));
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }

  // ---------- Erreurs ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Erreur serveur' : err.message });
  });

  return app;
}
