import { useEffect, useState } from 'react';

/** Routeur minimal basé sur le hash (#/m/lists/123) : compatible avec tout hébergement. */
const parse = () =>
  window.location.hash
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent);

let depth = 0;

export function useRoute(): string[] {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(to: string) {
  depth++;
  window.location.hash = to;
}

/** Retour arrière : historique si on a navigué dans l'appli, sinon écran parent. */
export function goBack(fallback = '/') {
  if (depth > 0) {
    depth--;
    window.history.back();
  } else {
    window.location.replace(`#${fallback}`);
  }
}
