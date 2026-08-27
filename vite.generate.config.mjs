import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PT_LAB = path.resolve(HERE, '..', 'pt-lab-workspace', 'packages', 'pt-lab', 'src', 'index.ts');

/*
 * The image generator, built separately from the app.
 *
 * Deliberately NOT part of `npm run build:renderer`, and deliberately not a
 * dependency in package.json. Three reasons, all pointing the same way:
 *
 *   - pt-lab is a GPU path tracer. CI runners have software GL only, so this
 *     could never run there usefully, and building it there would cost minutes
 *     for an artifact nobody uses.
 *   - it would drag three.js and an OIDN WASM blob into the app's bundle for a
 *     feature the app does not have.
 *   - a `file:` dependency has to resolve at INSTALL time even if nothing
 *     imports it, so adding pt-lab to package.json would make `npm ci` fail
 *     anywhere the sibling checkout is absent -- including CI, which has no
 *     use for it.
 *
 * An alias instead: only this config knows pt-lab exists, and it is only read
 * by `npm run build:generate`. pt-lab's own dependencies (three,
 * three-gpu-pathtracer, oidn-web) resolve by ordinary node resolution from its
 * source, out of the sibling workspace's node_modules.
 */
export default defineConfig({
  root: 'src/generate',
  base: './',
  plugins: [svelte()],
  resolve: {
    alias: { 'pt-lab': PT_LAB },
  },
  build: {
    outDir: '../../dist-generate',
    emptyOutDir: true,
    modulePreload: false,
    target: 'chrome130',
    sourcemap: false,
    rollupOptions: {
      output: { entryFileNames: 'generate.js', chunkFileNames: '[name].js', assetFileNames: '[name][extname]' },
    },
  },
});
