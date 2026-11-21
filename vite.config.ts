import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Politique de sécurité du contenu (CSP) : l'appli ne peut charger du code que depuis
 * sa propre origine et ne peut se connecter qu'au relais configuré.
 */
function csp(relay: string): Plugin {
  const relayWs = relay.replace(/^http/, 'ws');
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    `connect-src 'self'${relay ? ` ${relay} ${relayWs}` : ''}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return {
    name: 'csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`),
  };
}

/** Refuse une adresse de relais invalide (ex. l'exemple du README recopié tel quel). */
function checkRelay(relay: string) {
  if (!relay) return;
  let url: URL | null = null;
  try {
    url = new URL(relay);
  } catch {
    /* invalide */
  }
  const local = url && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  if (!url || /[<>\s]/.test(relay) || (url.protocol !== 'https:' && !local) || url.pathname.replace(/\/$/, '') !== '') {
    throw new Error(
      `VITE_RELAY_URL invalide : « ${relay} ». Mettez l'adresse exacte affichée par \`npx wrangler deploy\` ` +
        '(ex. https://family-app-relay.mon-compte.workers.dev), sans chemin ni barre finale.',
    );
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const relay = (env.VITE_RELAY_URL ?? '').trim().replace(/\/$/, '');
  checkRelay(relay);
  return {
    root: 'web',
    base: './', // chemins relatifs : fonctionne sur https://<compte>.github.io/<dépôt>/
    envDir: '..',
    plugins: [react(), csp(relay)],
    build: { outDir: '../dist', emptyOutDir: true },
    server: { host: true },
  };
});
