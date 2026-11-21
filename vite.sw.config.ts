import { defineConfig, loadEnv } from 'vite';

/** Construit le service worker en un seul fichier autonome (dist/sw.js). */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    define: { __RELAY_URL__: JSON.stringify(env.VITE_RELAY_URL ?? '') },
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      copyPublicDir: false,
      lib: { entry: 'web/src/sw.ts', formats: ['iife'], name: 'sw', fileName: () => 'sw.js' },
    },
  };
});
