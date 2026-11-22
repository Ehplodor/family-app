import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { captureInstallPrompt } from './lib/install';
import { initDisplayPrefs } from './lib/theme';

captureInstallPrompt();
// Thème de l'appareil appliqué avant le premier affichage (pas de « flash » de la mauvaise couleur).
initDisplayPrefs();

// Anti-« clickjacking » : l'appli refuse de s'afficher à l'intérieur d'un autre site (cadre invisible
// pour faire cliquer « Approuver » à l'insu de l'utilisateur). GitHub Pages ne permet pas d'envoyer
// l'en-tête qui l'interdit (frame-ancestors), d'où ce contrôle.
const framed = (() => {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
})();

if (framed) {
  document.getElementById('root')!.textContent = 'Ouvrez Family App directement dans le navigateur.';
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// Application installable (PWA) : le service worker n'est actif qu'en production.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {}));
}
