import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// pt-lab lives in this repository now, under packages/pt-lab/: the library's source,
// and the assets its default URLs name. It used to be a sibling checkout.
const PT_LAB = path.join(HERE, 'packages', 'pt-lab', 'src', 'index.ts');
const PT_ASSETS = path.join(HERE, 'packages', 'pt-lab', 'assets');
const OUT = path.resolve(HERE, 'dist-generate');

/**
 * Copy pt-lab's assets into the bundle.
 *
 * pt-lab's default URLs are `./assets/…` — the glTF model, the HDR
 * environment, and the denoiser weights — relative to the PAGE, so they have
 * to sit beside it in `dist-generate/`. They live in packages/pt-lab/assets/, apart
 * from the library's source, because nothing imports them: the page fetches
 * them at run time. (In pt-lab's own repository they were its demo app's
 * public files, and before this copy existed the generator fetched them from
 * that checkout at render time -- a complete, correct build could fail on its
 * first frame because the checkout had moved.)
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
 * Deliberately NOT part of `npm run build:renderer`: pt-lab is three.js, a
 * GPU path tracer and an OIDN WASM blob, and the app's window has no use for
 * any of it. It runs in views of its own, loaded from dist-generate/.
 *
 * pt-lab is reached through an alias: it is source in this repository,
 * compiled here, never published. (It is a package too, @cv-lab/pt-lab, for
 * rr, which takes it from source; the alias is the same name.) Its dependencies (three,
 * three-gpu-pathtracer, three-mesh-bvh, oidn-web) are this repository's
 * devDependencies, like everything else Vite bundles, and resolve from
 * packages/pt-lab/src/ by ordinary upward node resolution.
 */
export default defineConfig({
  root: 'src/generate',
  base: './',
  plugins: [svelte(), copyPtLabAssets()],
  resolve: {
    alias: { '@cv-lab/pt-lab': PT_LAB },
  },
  build: {
    outDir: '../../dist-generate',
    emptyOutDir: true,
    modulePreload: false,
    target: 'chrome130',
    sourcemap: false,
    /*
     * Two pages from one build: the generator, and the scene editor. One
     * build rather than two so they share one copy of pt-lab -- Rollup puts it
     * in a chunk both entries import, instead of shipping it twice.
     *
     * The generator's entry keeps the name `generate.js`: checkPrerequisites
     * dates the build by it. Nothing may assume pt-lab's code is IN it, though
     * -- it is in the shared chunk -- which is why check-generate-bundle.js
     * reads every .js here rather than that one file.
     */
    rollupOptions: {
      input: {
        index: path.join(HERE, 'src', 'generate', 'index.html'),
        editor: path.join(HERE, 'src', 'generate', 'editor.html'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'index' ? 'generate.js' : '[name].js'),
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});
