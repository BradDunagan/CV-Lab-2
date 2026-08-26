import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

/*
 * The renderer's build.
 *
 * `.mjs` because package.json stays CommonJS: main.js, preload.js, native/
 * and src/lab/ are all `require()`-based and run under Node, not through this
 * bundler. Only src/renderer/ is built. Setting "type": "module" to please
 * Vite would break every other file in the project.
 *
 * There is deliberately NO dev server. electron-guide.md attaches one
 * condition to `sandbox: false` -- "this window must only ever load local,
 * first-party content" -- and a window that can point at http://localhost is
 * a window that can point at http://anything. `npm run dev` runs this build
 * in watch mode instead, so the app is always loading a file:// URL and the
 * security condition holds by construction rather than by discipline.
 */
export default defineConfig({
  root: 'src/renderer',
  base: './',            // file:// has no server root, so every href must be relative
  plugins: [svelte()],

  build: {
    outDir: '../../dist-renderer',
    emptyOutDir: true,
    // Module preload injects an inline <script> to polyfill link rel=modulepreload,
    // which the page's CSP (script-src 'self') refuses. Nothing here is big
    // enough for preloading to matter.
    modulePreload: false,
    // Chromium in Electron 43 is far newer than the default browser target,
    // and this bundle only ever runs there.
    target: 'chrome130',
    // Off by default: paneless lazy-loads Monaco, and Monaco's maps alone are
    // ~15 MB of a ~19 MB output. `CVLAB_SOURCEMAP=1 npm run build:renderer`
    // when you actually need to step through the bundle.
    sourcemap: process.env.CVLAB_SOURCEMAP === '1',
    rollupOptions: {
      output: {
        // Stable names, so index.html's references stay readable and a diff of
        // the built output means something.
        entryFileNames: 'renderer.js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});
