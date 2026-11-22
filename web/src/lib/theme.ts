/**
 * Thèmes d'affichage : une préférence propre à chaque appareil (stockage local), jamais partagée
 * avec la famille ni envoyée au relais. Le thème se traduit par l'attribut `data-theme` de <html>,
 * que `styles.css` utilise pour changer les couleurs.
 */

export type ThemeId = 'auto' | 'jour' | 'nuit' | 'papier' | 'nocturne' | 'dev' | 'a11y';
export type TextSize = 'normal' | 'grand' | 'tres-grand';

export interface ThemeInfo {
  id: ThemeId;
  name: string;
  description: string;
  /** Aperçu dans le sélecteur : fond, carte, texte, accent (null = couleur de l'appli). */
  preview: { bg: string; surface: string; text: string; accent: string | null };
}

export const THEMES: ThemeInfo[] = [
  {
    id: 'auto',
    name: 'Automatique',
    description: "Jour ou nuit, comme le reste du téléphone.",
    preview: { bg: 'linear-gradient(135deg, #f6f6f8 50%, #121216 50%)', surface: '#ffffff', text: '#1d1d22', accent: null },
  },
  {
    id: 'jour',
    name: 'Jour',
    description: 'Clair et lumineux.',
    preview: { bg: '#f6f6f8', surface: '#ffffff', text: '#1d1d22', accent: null },
  },
  {
    id: 'nuit',
    name: 'Nuit',
    description: 'Sombre, doux pour les yeux le soir.',
    preview: { bg: '#121216', surface: '#1d1d23', text: '#f1f1f4', accent: null },
  },
  {
    id: 'papier',
    name: 'Papier',
    description: 'Tons chauds, moins de lumière bleue, pour lire.',
    preview: { bg: '#f3ead6', surface: '#fbf6e9', text: '#3b2f22', accent: null },
  },
  {
    id: 'nocturne',
    name: 'Vision nocturne',
    description: "Rouge sur noir : n'éblouit pas dans le noir.",
    preview: { bg: '#000000', surface: '#140000', text: '#c00000', accent: '#7a0000' },
  },
  {
    id: 'dev',
    name: 'Développeur',
    description: 'Terminal vert, police à chasse fixe.',
    preview: { bg: '#0b0f0c', surface: '#111813', text: '#c9f5d1', accent: '#3ddc84' },
  },
  {
    id: 'a11y',
    name: 'Accessibilité',
    description: 'Contraste élevé, texte plus grand, couleurs sûres pour les daltoniens.',
    preview: { bg: '#ffffff', surface: '#ffffff', text: '#000000', accent: '#0046b8' },
  },
];

export const TEXT_SIZES: { id: TextSize; name: string; scale: number }[] = [
  { id: 'normal', name: 'Normal', scale: 1 },
  { id: 'grand', name: 'Grand', scale: 1.15 },
  { id: 'tres-grand', name: 'Très grand', scale: 1.3 },
];

export const THEME_KEY = 'display.theme';
export const TEXT_SIZE_KEY = 'display.textSize';

export interface DisplayPrefs {
  theme: ThemeId;
  textSize: TextSize;
}

/** Lit une valeur stockée (format JSON de `useLocalState`) ; toute valeur inconnue donne la valeur par défaut. */
export function parsePrefs(rawTheme: string | null, rawSize: string | null): DisplayPrefs {
  const read = (raw: string | null): unknown => {
    try {
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  };
  const theme = read(rawTheme);
  const size = read(rawSize);
  return {
    theme: THEMES.some((t) => t.id === theme) ? (theme as ThemeId) : 'auto',
    textSize: TEXT_SIZES.some((s) => s.id === size) ? (size as TextSize) : 'normal',
  };
}

export function loadPrefs(): DisplayPrefs {
  try {
    return parsePrefs(localStorage.getItem(THEME_KEY), localStorage.getItem(TEXT_SIZE_KEY));
  } catch {
    return parsePrefs(null, null);
  }
}

export function textScale(size: TextSize): number {
  return TEXT_SIZES.find((s) => s.id === size)?.scale ?? 1;
}

/**
 * Filtre « vision nocturne » : chaque pixel devient un rouge de même luminosité. Il s'applique à
 * toute la page, y compris aux couleurs choisies par la famille (membres, listes, agendas).
 */
const NIGHT_FILTER_ID = 'night-vision-filter';
const SVG_NS = 'http://www.w3.org/2000/svg';

function ensureNightFilter(doc: Document) {
  if (doc.getElementById(NIGHT_FILTER_ID) || !doc.body) return;
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
  const filter = doc.createElementNS(SVG_NS, 'filter');
  filter.setAttribute('id', NIGHT_FILTER_ID);
  filter.setAttribute('color-interpolation-filters', 'sRGB');
  const matrix = doc.createElementNS(SVG_NS, 'feColorMatrix');
  matrix.setAttribute('type', 'matrix');
  // Rouge = luminosité (légèrement atténuée), vert et bleu éteints.
  matrix.setAttribute('values', '0.19 0.64 0.07 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0');
  filter.appendChild(matrix);
  svg.appendChild(filter);
  doc.body.appendChild(svg);
}

/** Applique le thème à la page et met à jour la couleur de la barre du navigateur. */
export function applyDisplayPrefs(prefs: DisplayPrefs, doc: Document = document) {
  const root = doc.documentElement;
  if (prefs.theme === 'nocturne') ensureNightFilter(doc);
  root.dataset.theme = prefs.theme;
  root.style.setProperty('--fs-user', String(textScale(prefs.textSize)));
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  const meta = doc.querySelector('meta[name="theme-color"]');
  if (meta && bg) meta.setAttribute('content', bg);
}

let watching = false;

/** Au démarrage : applique le thème enregistré et suit les changements jour/nuit du système. */
export function initDisplayPrefs() {
  applyDisplayPrefs(loadPrefs());
  if (watching || typeof matchMedia !== 'function') return;
  watching = true;
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => applyDisplayPrefs(loadPrefs()));
}
