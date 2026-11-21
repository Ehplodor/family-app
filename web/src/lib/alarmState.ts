/**
 * État local (propre à l'appareil, jamais synchronisé) des réveils : dernière sonnerie arrêtée.
 * Partagé entre l'appli et le service worker via IndexedDB (magasin `kv`).
 */
import * as idb from './idb';

export const alarmDoneKey = (id: string) => `alarmDone:${id}`;

/** Marque la sonnerie `at` (et les précédentes) comme arrêtée : ses relances ne sonneront pas. */
export async function markAlarmDone(id: string, at: number) {
  const prev = (await idb.get<number>('kv', alarmDoneKey(id))) ?? 0;
  if (at > prev) await idb.put('kv', alarmDoneKey(id), at);
}

export async function alarmDoneAt(id: string): Promise<number> {
  return (await idb.get<number>('kv', alarmDoneKey(id))) ?? 0;
}
