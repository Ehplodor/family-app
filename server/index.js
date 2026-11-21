import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createApp } from './app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const port = Number(process.env.PORT || 3000);

const db = openDb(path.join(dataDir, 'family.db'));
const app = createApp({
  db,
  uploadDir: path.join(dataDir, 'uploads'),
  staticDir: path.join(root, 'dist'),
});

app.listen(port, () => {
  console.log(`Family App prête sur http://localhost:${port} (données : ${dataDir})`);
});
