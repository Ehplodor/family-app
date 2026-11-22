import { describe, expect, it } from 'vitest';
import { parsePrefs, textScale, THEMES } from './theme';

describe('préférences d’affichage', () => {
  it('par défaut : thème automatique, texte normal', () => {
    expect(parsePrefs(null, null)).toEqual({ theme: 'auto', textSize: 'normal' });
  });

  it('relit les valeurs enregistrées (format JSON de useLocalState)', () => {
    expect(parsePrefs('"nocturne"', '"grand"')).toEqual({ theme: 'nocturne', textSize: 'grand' });
  });

  it('ignore une valeur inconnue ou abîmée sans planter', () => {
    expect(parsePrefs('"arc-en-ciel"', '{oops')).toEqual({ theme: 'auto', textSize: 'normal' });
    expect(parsePrefs('42', 'null')).toEqual({ theme: 'auto', textSize: 'normal' });
  });

  it('propose les thèmes demandés', () => {
    expect(THEMES.map((t) => t.id)).toEqual(['auto', 'jour', 'nuit', 'papier', 'nocturne', 'dev', 'a11y']);
  });

  it('agrandit le texte', () => {
    expect(textScale('normal')).toBe(1);
    expect(textScale('tres-grand')).toBeGreaterThan(textScale('grand'));
  });
});
