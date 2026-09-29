<script>
  /**
   * The scene editor's page: pt-lab's view, and the scene model behind it.
   *
   * It draws nothing but the render. The controls are a paneless column in
   * the app window, beside this view -- src/renderer/panes/editor-controls --
   * the same arrangement the Generate frame has. This page is the other half:
   * it owns everything that needs pt-lab or this origin's storage, and the
   * column reaches it through `window.__editor`, which the main process calls
   * on the column's behalf.
   *
   * Two directions, deliberately asymmetric:
   *
   *   - commands come IN as `__editor.<method>(...)`, relayed by the main
   *     process against a list of names it allows;
   *   - state goes OUT as one snapshot of everything the column shows,
   *     published through window.cvlab whenever it changes.
   *
   * The selection lives here, not in the column, so a snapshot describes the
   * whole UI and the column holds no state of its own to disagree with it.
   *
   * What the page leaves out is everything that PRODUCES images: pt-lab's
   * Save PNG, the depth-pass and rotation-series exports, the demo scenes.
   * Images come from the Generate frame, as a sweep with provenance.
   *
   * Where a scene lives: pt-lab saves to localStorage, per origin, where
   * nothing else can read it; this saves to scenes/ through window.cvlab
   * (editor-preload.js), as the file the Generate pane renders.
   */
  import { onMount } from 'svelte';
  import {
    PathTracerViewer,
    bundledTree,
    getImport,
    newSceneData,
    LIGHT_TYPES,
    lightTypeInfo,
  } from 'pt-lab';

  const host = window.cvlab;

  let lab = $state(null);
  let status = $state({
    mode: 'loading', samples: 0, elapsedMs: 0, denoise: 'off', denoisedAt: 0, denoiseAux: true,
  });
  const ready = $derived(!!lab && status.mode !== 'loading' && status.mode !== 'building-bvh');

  /* --- the model --------------------------------------------------------- */

  /** The scenes in scenes/, by name. */
  let scenes = [];
  /** The scene open now: { name, file, local, shared } -- or null for an unsaved one. */
  let current = null;
  let saving = false;
  let message = '';
  let error = '';
  let editMode = true;
  /**
   * OIDN over the path-traced preview. Off, as in pt-lab and in Generate.
   * A viewing choice, not part of the scene: a SceneData has no field for
   * it, and Generate's own denoise checkbox decides what a render gets.
   */
  let denoise = false;
  /** { kind: 'object' | 'light', id } or null. */
  let selected = null;

  /**
   * The bundled importable objects, flattened. pt-lab enumerates them as a
   * tree at build time; the column offers them as one list, by path.
   */
  const bundled = (() => {
    const out = [];
    const walk = (dir, prefix) => {
      for (const d of dir.dirs) walk(d, `${prefix}${d.name}/`);
      for (const f of dir.files) out.push({ name: f.name, path: `${prefix}${f.name}`, url: f.url });
    };
    walk(bundledTree, '');
    return out;
  })();

  /**
   * The scene as last opened or saved, to tell whether it has changed since.
   *
   * Compared as serialised data rather than tracked edit by edit: pt-lab has
   * no single change event, and a comparison cannot miss an edit that a list
   * of events forgot. Rounded, so a camera that merely settled does not count.
   */
  let baseline = null;

  function serialized() {
    return JSON.stringify(lab.serializeScene(), (_k, v) =>
      typeof v === 'number' ? Math.round(v * 1e5) / 1e5 : v);
  }

  function isDirty() {
    return ready && baseline !== null && serialized() !== baseline;
  }

  function markClean() {
    baseline = serialized();
  }

  /** Nothing to lose, or the person said to lose it. */
  function mayDiscard(what) {
    if (!isDirty()) return true;
    return confirm(`${current ? `"${current.name}"` : 'This new scene'} has unsaved changes. ` +
      `Discard them and ${what}?`);
  }

  /**
   * ipcRenderer.invoke wraps the main process's message in "Error invoking
   * remote method '…': Error: " -- true, and not what anyone needs to read.
   */
  function reason(err) {
    return String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
  }

  async function refreshScenes() {
    scenes = await host.scenes();
  }

  /* --- publishing -------------------------------------------------------- */

  /**
   * Everything the column shows, as plain data.
   *
   * Built fresh each time from pt-lab rather than mirrored field by field, so
   * there is one source for each value and nothing here can go stale.
   */
  function snapshot() {
    if (!lab) return { ready: false, mode: status.mode };
    const objects = lab.listObjects();
    const lights = lab.listLights();
    // A selection whose object or light has gone -- removed, or replaced by
    // opening a scene -- is no selection.
    if (selected?.kind === 'object' && !objects.some((o) => o.id === selected.id)) selected = null;
    if (selected?.kind === 'light' && !lights.some((l) => l.id === selected.id)) selected = null;
    const obj = selected?.kind === 'object' ? selected.id : null;
    return {
      ready,
      mode: status.mode,
      samples: status.samples,
      scenes,
      current,
      dirty: isDirty(),
      saving,
      message,
      error,
      editMode,
      denoise,
      // pt-lab's own account of the denoiser: off, unsupported (no WebGPU),
      // loading, ready, denoising, denoised, or error.
      denoiseState: status.denoise,
      denoisedAt: status.denoisedAt,
      room: lab.getRoom(),
      camera: { position: lab.getCameraPosition(), target: lab.getCameraTarget() },
      objects,
      lights,
      selected,
      material: obj ? lab.getObjectMaterial(obj) : null,
      transform: obj ? lab.getObjectTransform(obj) : null,
      bundled: bundled.map(({ name, path }) => ({ name, path })),
      lightTypes: LIGHT_TYPES,
    };
  }

  /*
   * Coalesced, and only when something differs. The status callback fires
   * every frame while the tracer accumulates, and a snapshot per frame would
   * be sixty IPC messages a second for a sample count.
   */
  let lastSent = '';
  let pending = null;
  function publish() {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      const s = JSON.stringify(snapshot());
      if (s === lastSent) return;
      lastSent = s;
      host.state(JSON.parse(s));
    }, 120);
  }

  $effect(() => {
    void status;
    publish();
  });

  /** Run a command, then say what it changed -- or why it failed. */
  async function command(fn) {
    try {
      error = '';
      return await fn();
    } catch (err) {
      error = reason(err);
      return undefined;
    } finally {
      publish();
    }
  }

  /* --- opening and saving ------------------------------------------------ */

  /**
   * Open a scene from scenes/.
   *
   * Its imported models come from scenes/models/, already found and hashed by
   * the main process -- the same check a render makes, so the editor refuses
   * exactly the scenes the generator would. They are registered with pt-lab
   * in memory under the scene's own keys, as the generator does, rather than
   * imported: an import would mint a new key the scene does not use.
   */
  async function openScene(name) {
    if (!lab || !mayDiscard(`open "${name}"`)) return;
    message = '';
    const scene = await host.open(name);
    for (const m of scene.models) {
      const res = await fetch(m.url);
      if (!res.ok) throw new Error(`${m.glb}: ${res.status} ${res.statusText}`);
      try {
        const sha256 = await lab.registerImport(m.key, m.name, await res.arrayBuffer());
        if (sha256 !== m.sha256) throw new Error(`${m.glb} arrived with a different hash`);
      } catch (err) {
        // Already in the library: imported here earlier, or opened before
        // in this session. Same key, and the key is what applyScene reads.
        if (!/already in the library/.test(err.message)) throw err;
      }
    }
    lab.applyScene(scene.data);
    selected = null;
    current = { name: scene.name, file: scene.file, local: scene.local, shared: scene.shared };
    markClean();
    if (scene.shared) {
      message = `${scene.file} holds several scenes, so this one cannot be saved back ` +
        `into it. Save it under a new name.`;
    }
  }

  function newScene() {
    if (!lab || !mayDiscard('start a new one')) return;
    lab.applyScene(newSceneData());
    selected = null;
    current = null;
    message = '';
    markClean();
  }

  /**
   * The bytes of every included import this page holds itself.
   *
   * Models imported here live in this origin's IndexedDB and exist nowhere
   * else yet, so they travel with the save. Models that were opened FROM
   * scenes/models/ are not in IndexedDB and are not sent: the file they came
   * from is already there, and the main process checks it rather than
   * rewriting it.
   */
  async function heldModels(data) {
    const models = {};
    for (const o of data.objects) {
      if (!o.included || !o.glb) continue;
      const rec = await getImport(o.key);
      if (rec) models[o.glb] = rec.glb;
    }
    return models;
  }

  /**
   * Save. With no `name`, back to the file the scene came from; with one, as
   * a new scene, which must not already exist.
   */
  async function save({ name, local = false } = {}) {
    if (!lab || saving) return;
    const asNew = !!name;
    const target = asNew ? String(name).trim() : current?.name;
    if (!target) throw new Error('Give the scene a name to save it under.');
    saving = true;
    message = '';
    publish();
    try {
      const data = lab.serializeScene();
      const saved = await host.save({
        name: target, data, local, replace: !asNew, models: await heldModels(data),
      });
      const file = saved.file.split(/[\\/]/).pop();
      current = { name: target, file, local: /\.local\.json$/.test(file), shared: false };
      markClean();
      await refreshScenes();
      message = `Saved ${file}` +
        (saved.models.length ? ` and ${saved.models.length} model(s)` : '') +
        `. It is offered in Generate as "${target}".`;
    } finally {
      saving = false;
    }
  }

  /* --- the API the column drives ---------------------------------------- */

  /**
   * Every method here is one the main process may call, and main.js lists
   * the same names -- a name missing there is refused, a name missing here
   * is an error, and test/renderer.js holds the two lists together.
   */
  const api = {
    refresh: () => command(async () => { lastSent = ''; await refreshScenes(); }),
    dirty: () => isDirty(),

    open: (name) => command(() => openScene(String(name))),
    newScene: () => command(() => newScene()),
    save: (request) => command(() => save(request ?? {})),

    select: (kind, id) => command(() => {
      selected = kind && id ? { kind, id } : null;
    }),
    setPreview: (on) => command(() => {
      editMode = !on;
      lab.setEditMode(editMode);
    }),
    setDenoise: (on) => command(async () => {
      denoise = !!on;
      await lab.setDenoiseEnabled(denoise);
    }),
    setRoom: (kind) => command(() => lab.setRoom(kind)),
    setCamera: ({ position, target } = {}) => command(() => {
      if (position) lab.setCameraPosition(...position);
      if (target) lab.setCameraTarget(...target);
    }),

    setIncluded: (id, included) => command(() => lab.setObjectIncluded(id, !!included)),
    removeObject: (id) => command(() => {
      if (selected?.id === id) selected = null;
      lab.removeLibraryObject(id);
    }),
    /** Partial: whatever fields are given replace those of the current transform. */
    setTransform: (id, t) => command(() => {
      lab.setObjectTransform(id, { ...lab.getObjectTransform(id), ...t });
    }),
    /** Partial, so a texture the column cannot show is kept rather than dropped. */
    setMaterial: (id, m) => command(() => {
      lab.setObjectMaterial(id, { ...lab.getObjectMaterial(id), ...m });
    }),
    /** A .glb the main process has made fetchable -- picked from disk, or bundled. */
    importFromURL: (url, name) => command(async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${name}: ${res.status} ${res.statusText}`);
      try {
        await lab.importGLB(await res.arrayBuffer(), name);
      } catch (err) {
        throw new Error(err?.name === 'QuotaExceededError'
          ? 'Storage full -- remove some imported objects.'
          : `Import failed -- is ${name} a valid .glb?`);
      }
    }),
    importBundled: (path) => command(async () => {
      const b = bundled.find((x) => x.path === path);
      if (!b) throw new Error(`no bundled object "${path}"`);
      if (lab.listObjects().some((o) => o.name === b.name)) {
        throw new Error(`${b.name} is already in the library.`);
      }
      const res = await fetch(b.url);
      if (!res.ok) throw new Error(`${b.name}: ${res.status}`);
      await lab.importGLB(await res.arrayBuffer(), b.name);
    }),

    addLight: () => command(() => {
      selected = { kind: 'light', id: lab.addLight() };
    }),
    removeLight: (id) => command(() => {
      if (selected?.id === id) selected = null;
      lab.removeLight(id);
    }),
    /**
     * Partial. Changing the type resets the intensity to that type's default,
     * as pt-lab's own light panel does: candela and nits are different units,
     * and a spot at 80 cd is not an area light at 80 nt.
     */
    setLight: (id, l) => command(() => {
      const was = lab.getLight(id);
      if (!was) throw new Error(`no light "${id}"`);
      const next = { ...was, ...l };
      if (l.type && l.type !== was.type && l.intensity === undefined) {
        next.intensity = lightTypeInfo(l.type).defaultIntensity;
      }
      lab.setLight(id, next);
    }),
  };

  /* --- startup ----------------------------------------------------------- */

  /*
   * Open something as soon as pt-lab can take it. Not before: applyScene
   * returns without a word while the tracer is still loading, so opening on
   * mount would leave pt-lab's startup helmet on screen under a scene name
   * that says otherwise.
   */
  let started = false;
  $effect(() => {
    if (!ready || started) return;
    started = true;
    // pt-lab starts path tracing; the editor starts editing. Said once, here,
    // rather than left to whichever control happens to be touched first --
    // the column's preview checkbox reads this state, it does not set it.
    lab.setEditMode(editMode);
    command(async () => {
      await refreshScenes();
      if (scenes.length > 0) await openScene(scenes[0]);
      else newScene();
    });
  });

  $effect(() => {
    if (!lab) return;
    lab.setOnObjectsChanged(() => publish());
    lab.setOnLightsChanged(() => publish());
  });

  onMount(() => {
    window.__editor = api;
    // Dirtiness has no event of its own; a slow poll is what notices a
    // camera dragged or a panel edit the column did not make.
    const timer = setInterval(publish, 1000);
    return () => clearInterval(timer);
  });
</script>

<main>
  <PathTracerViewer bind:lab bind:status />
</main>

<style>
  main { display: flex; width: 100vw; height: 100vh; }
</style>
