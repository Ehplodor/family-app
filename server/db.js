import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Ouvre (et crée si besoin) la base SQLite.
 * Modèle volontairement simple :
 *  - families / members / sessions : qui a accès à quoi
 *  - docs : stockage générique de documents JSON par "collection"
 *    (listes, événements, anniversaires, messages, recettes…)
 *  - files : photos de la galerie (le contenu est sur disque)
 */
export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS families (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      invite_code TEXT NOT NULL UNIQUE,
      settings    TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS members (
      id         TEXT PRIMARY KEY,
      family_id  TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      color      TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS members_family ON members(family_id);

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS docs (
      id         TEXT PRIMARY KEY,
      family_id  TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      collection TEXT NOT NULL,
      data       TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS docs_family_collection ON docs(family_id, collection);

    CREATE TABLE IF NOT EXISTS files (
      id         TEXT PRIMARY KEY,
      family_id  TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      mime       TEXT NOT NULL,
      size       INTEGER NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}
