/**
 * Installation de l'appli (PWA) : bouton natif sur Android/ordinateur,
 * instructions sur iPhone (Safari ne propose pas de bouton programmable).
 */
import { useSyncExternalStore } from 'react';

type PromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

let deferred: PromptEvent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** À appeler au démarrage, avant que le navigateur ne propose l'installation. */
export function captureInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as PromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    emit();
  });
}

export const isStandaloneApp = () =>
  matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
export const isIOSDevice = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

export function useInstall() {
  const canPrompt = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => !!deferred,
  );
  return {
    installed: isStandaloneApp(),
    canPrompt,
    iosHint: isIOSDevice() && !isStandaloneApp(),
    async prompt() {
      if (!deferred) return;
      await deferred.prompt();
      await deferred.userChoice.catch(() => null);
      deferred = null;
      emit();
    },
  };
}
