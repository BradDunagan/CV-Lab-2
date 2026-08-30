import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PT_ROOT = path.resolve(HERE, '..', 'pt-lab-workspace', 'packages');
const PT_LAB = path.join(PT_ROOT, 'pt-lab', 'src', 'index.ts');
const PT_ASSETS = path.join(PT_ROOT, 'demo', 'public', 'assets');
const OUT = path.resolve(HERE, 'dist-generate');

/**
 * Copy pt-lab's demo assets into the bundle.
 *
 * pt-lab's default URLs are `./assets/…` — the glTF model, the HDR
 * environment, and the denoiser weights — and those files live in the DEMO
 * package's public directory, not in the library. Without this the generator
 * fetched them out of the sibling checkout at render time, which meant a build
 * could be complete and correct and still fail on the first frame because the
 * checkout had moved.
 *
 * Copying them here makes `dist-generate/` self-contained: the BUILD needs the
 * sibling checkout, and running the generator does not. The same split the
 * source already had.
 *
 * The cost, stated because it used to be the other way round: pt-lab's assets
 * are now a BUILD INPUT. Swapping the helmet or the environment takes effect
 * on the next `npm run build:generate` rather than immediately, and
 * `checkPrerequisites` counts them when deciding a bundle is stale. For a
 * fixture generator that is the better default — it pins what was rendered to
 * what the bundle was built against.
 */
function copyPtLabAssets() {
  return {
    name: 'cv-lab-copy-pt-lab-assets',
    apply: 'build',
    closeBundle() {
      if (!fs.existsSync(PT_ASSETS)) {
        this.warn(
          `pt-lab's assets are not at ${PT_ASSETS}. The bundle will not be ` +
          `self-contained; the generator will look for them at run time instead.`
        );
        return;
      }
      const target = path.join(OUT, 'assets');
      fs.mkdirSync(target, { recursive: true });
      for (const name of fs.readdirSync(PT_ASSETS)) {
        const from = path.join(PT_ASSETS, name);
        const to = path.join(target, name);
        const src = fs.statSync(from);
        if (!src.isFile()) continue;
        // Skip what is already current: these are ~9 MB in total and --watch
        // reruns this on every rebuild.
        let dst = null;
        try { dst = fs.statSync(to); } catch { /* not there yet */ }
        if (dst && dst.mtimeMs >= src.mtimeMs && dst.size === src.size) continue;
        fs.copyFileSync(from, to);
      }
    },
  };
}

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
  plugins: [svelte(), copyPtLabAssets()],
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
