/** Heures au format « HH:MM » (celui des champs type="time", conservé tel quel dans les données). */

export type HM = { h: number; m: number };

/** Lit « HH:MM » (ou « HH:MM:SS ») ; renvoie null si la valeur est vide ou illisible. */
export function parseTime(value: string | undefined | null): HM | null {
  const r = /^(\d{1,2}):(\d{2})/.exec(value ?? '');
  if (!r) return null;
  const h = Number(r[1]);
  const m = Number(r[2]);
  if (h > 23 || m > 59) return null;
  return { h, m };
}

export function formatTime({ h, m }: HM): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Ajoute (ou retire) des minutes, en restant dans la même heure (59 → 00, 00 → 59). */
export function stepMinutes(t: HM, delta: number): HM {
  return { h: t.h, m: (((t.m + delta) % 60) + 60) % 60 };
}
