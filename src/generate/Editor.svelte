<script>
  /**
   * The scene editor: pt-lab's editor, with scenes that are files.
   *
   * Ported from pt-lab's demo App.svelte, which is one consumer of pt-lab's
   * editor API; this is another. What it keeps is the composing -- room,
   * objects, materials, transforms, lights, camera -- and pt-lab's own panels
   * for all of it. What it leaves out is everything that PRODUCES images:
   * Save PNG, the depth-pass and rotation-series exports, the demo scenes.
   * Images come from the Generate frame, as a sweep with provenance, and a
   * second way to make one here would be a way to make one without it.
   *
   * What it changes is where a scene lives. pt-lab saves to localStorage,
   * per origin, where nothing else can read it; this saves to scenes/ through
   * window.cvlab (editor-preload.js), as the file the Generate pane renders.
   * So there is no Export step and no copying: Save, and the scene is
   * offered in Generate.
   */
  import { onMount } from 'svelte';
  import {
    PathTracerViewer,
    TransformPanel,
    MaterialPanel,
    LightPanel,
    BundleTree,
    bundledTree,
    bundledIsEmpty,
    getImport,
    newSceneData,
  } from 'pt-lab';
  import CameraControls from './CameraControls.svelte';

  const host = window.cvlab;

  let lab = $state(null);
  let status = $state({
    mode: 'loading', samples: 0, elapsedMs: 0, denoise: 'off', denoisedAt: 0, denoiseAux: true,
  });
  const ready = $derived(!!lab && status.mode !== 'loading' && status.mode !== 'building-bvh');

  /* --- which scene, and whether it has changed -------------------------- */

  /** The scenes in scenes/, by name. */
  let scenes = $state([]);
  /** The scene open now: { name, file, local } -- or null for an unsaved one. */
  let current = $state(null);
  /** For a new scene, or Save As: the name to save under, and whether private. */
  let saveName = $state('');
  let saveLocal = $state(false);
  let saving = $state(false);
  let message = $state('');
  let error = $state('');

  /**
   * The scene as last opened or saved, to tell whether it has changed since.
   *
   * Compared as serialised data rather than tracked edit by edit: pt-lab has
   * no single change event, and a comparison cannot miss an edit that a list
   * of events forgot. Rounded, so a camera that merely settled does not count.
   */
  let baseline = null;
  let dirty = $state(false);

  function snapshot() {
    return JSON.stringify(lab.serializeScene(), (_k, v) =>
      typeof v === 'number' ? Math.round(v * 1e5) / 1e5 : v);
  }

  function markClean() {
    baseline = snapshot();
    dirty = false;
  }

  /** Nothing to lose, or the person said to lose it. */
  function mayDiscard(what) {
    if (!dirty) return true;
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
    try {
      scenes = await host.scenes();
    } catch (err) {
      error = reason(err);
    }
  }

  /* --- opening ----------------------------------------------------------- */

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
    error = '';
    message = '';
    try {
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
      roomKind = scene.data.room;
      selectedId = null;
      selectedLightId = null;
      current = { name: scene.name, file: scene.file, local: scene.local };
      saveName = scene.name;
      markClean();
      if (scene.shared) {
        message = `${scene.file} holds several scenes, so this one cannot be saved back ` +
          `into it. Save it under a new name.`;
      }
    } catch (err) {
      error = reason(err);
    }
  }

  function newScene() {
    if (!lab || !mayDiscard('start a new one')) return;
    const data = newSceneData();
    lab.applyScene(data);
    roomKind = data.room;
    selectedId = null;
    selectedLightId = null;
    current = null;
    saveName = '';
    saveLocal = false;
    error = '';
    message = '';
    markClean();
  }

  /* --- saving ------------------------------------------------------------ */

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
   * Save. Back to the file the scene came from when `asNew` is false and
   * there is one; otherwise under `saveName`, which must not already exist.
   */
  async function save(asNew) {
    if (!lab || saving) return;
    const name = asNew || !current ? saveName.trim() : current.name;
    if (!name) {
      error = 'Give the scene a name to save it under.';
      return;
    }
    saving = true;
    error = '';
    message = '';
    try {
      const data = lab.serializeScene();
      const replace = !asNew && !!current && current.name === name;
      const saved = await host.save({
        name, data, local: saveLocal, replace, models: await heldModels(data),
      });
      const file = saved.file.split(/[\\/]/).pop();
      current = { name, file, local: /\.local\.json$/.test(file) };
      saveName = name;
      markClean();
      await refreshScenes();
      message = `Saved ${file}` +
        (saved.models.length ? ` and ${saved.models.length} model(s)` : '') +
        `. It is offered in Generate as "${name}".`;
    } catch (err) {
      error = reason(err);
    } finally {
      saving = false;
    }
  }

  /* --- the editor proper, as pt-lab's demo has it ----------------------- */

  let editMode = $state(true);
  let objects = $state([]);
  let selectedId = $state(null);
  let lights = $state([]);
  let selectedLightId = $state(null);
  let importError = $state('');
  let fileInput = $state();

  const ROOM_OPTIONS = [
    { value: 'room', label: 'Baked HDR env' },
    { value: 'room-emissive', label: 'Emissive mesh' },
    { value: 'room-arealight', label: 'Rect area light' },
  ];
  /*
   * Set by the select's change handler, not pushed by an effect as the demo
   * does: an effect also fires when a scene is opened and when the lab first
   * becomes ready, and setRoom on pt-lab's startup scene would build a room
   * around the helmet a moment before the real scene replaced it.
   */
  let roomKind = $state('room-arealight');

  function selectObject(id) {
    selectedId = id;
    selectedLightId = null;
  }
  function selectLight(id) {
    selectedLightId = id;
    selectedId = null;
  }
  function removeObject(id) {
    if (selectedId === id) selectedId = null;
    lab?.removeLibraryObject(id);
  }
  function addLight() {
    if (lab) selectLight(lab.addLight());
  }
  function removeLight(id) {
    if (selectedLightId === id) selectedLightId = null;
    lab?.removeLight(id);
  }

  async function onImportFile(e) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file || !lab) return;
    importError = '';
    try {
      await lab.importGLB(await file.arrayBuffer(), file.name);
    } catch (err) {
      importError = err?.name === 'QuotaExceededError'
        ? 'Storage full -- remove some imported objects.'
        : 'Import failed -- is it a valid .glb?';
    }
    input.value = '';
  }

  const importedNames = $derived(new Set(objects.map((o) => o.name)));

  async function importBundled(file) {
    if (!lab || importedNames.has(file.name)) return;
    importError = '';
    try {
      const res = await fetch(file.url);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      await lab.importGLB(await res.arrayBuffer(), file.name);
    } catch {
      importError = `Couldn't import ${file.name}.`;
    }
  }

  $effect(() => {
    if (!lab) return;
    lab.setOnObjectsChanged((list) => (objects = list));
    objects = lab.listObjects();
    lab.setOnLightsChanged((list) => (lights = list));
    lights = lab.listLights();
  });

  $effect(() => {
    lab?.setEditMode(editMode);
  });

  // Recomputed when the selection changes or edit mode is re-entered, which is
  // when the keyed panels remount and re-seed -- see pt-lab's demo for why
  // reading editMode here matters.
  const selectedName = $derived(objects.find((o) => o.id === selectedId)?.name ?? '');
  const selectedTransform = $derived.by(() => {
    void editMode;
    return selectedId && lab ? lab.getObjectTransform(selectedId) : null;
  });
  const selectedMaterial = $derived.by(() => {
    void editMode;
    return selectedId && lab ? lab.getObjectMaterial(selectedId) : null;
  });
  const selectedLight = $derived(lights.find((l) => l.id === selectedLightId) ?? null);

  const cameraState = $derived.by(() => {
    void status;
    return lab
      ? { position: lab.getCameraPosition(), target: lab.getCameraTarget() }
      : null;
  });

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
    refreshScenes().then(() => (scenes.length > 0 ? openScene(scenes[0]) : newScene()));
  });

  onMount(() => {
    const timer = setInterval(() => {
      if (ready && baseline !== null) dirty = snapshot() !== baseline;
    }, 1000);
    // For the main process, which asks before the frame closes.
    window.__editor = { dirty: () => (ready && baseline !== null ? snapshot() !== baseline : false) };
    return () => clearInterval(timer);
  });

  const title = $derived(current ? current.name : 'New scene');
</script>

<main>
  <PathTracerViewer bind:lab bind:status />

  <aside>
    <div class="scene-bar">
      <select
        value={current?.name ?? ''}
        disabled={!ready}
        onchange={(e) => {
          const name = e.currentTarget.value;
          e.currentTarget.value = current?.name ?? '';
          if (name) openScene(name);
        }}
      >
        {#if !current}<option value="">New scene</option>{/if}
        {#each scenes as name (name)}
          <option value={name}>{name}</option>
        {/each}
      </select>
      <button onclick={newScene} disabled={!ready} title="Start an empty room">New</button>
    </div>

    <div class="scene-name">
      {title}{#if dirty}<span class="dirty" title="Unsaved changes"> ●</span>{/if}
      {#if current}<div class="file">{current.file}</div>{/if}
    </div>

    <div class="save">
      {#if current}
        <button class="primary" onclick={() => save(false)} disabled={!ready || saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      {/if}
      <div class="save-as">
        <input
          type="text"
          placeholder="name"
          bind:value={saveName}
          disabled={!ready || saving}
          onkeydown={(e) => { if (e.key === 'Enter') save(true); }}
        />
        <button onclick={() => save(true)} disabled={!ready || saving || !saveName.trim()}>
          {current ? 'Save As' : 'Save'}
        </button>
      </div>
      <label class="toggle">
        <input type="checkbox" bind:checked={saveLocal} disabled={!ready || saving} />
        <span>private: <code>.local.json</code>, not committed</span>
      </label>
      {#if message}<p class="hint">{message}</p>{/if}
      {#if error}<pre class="hint error">{error}</pre>{/if}
    </div>

    <button class="mode-toggle" onclick={() => (editMode = !editMode)} disabled={!ready}>
      {editMode ? 'Preview path-traced →' : '← Back to editing'}
    </button>

    {#if editMode}
      <label>
        Room
        <select
          value={roomKind}
          onchange={(e) => { roomKind = e.currentTarget.value; lab?.setRoom(roomKind); }}
        >
          {#each ROOM_OPTIONS as r (r.value)}
            <option value={r.value}>{r.label}</option>
          {/each}
        </select>
      </label>

      {#if cameraState}
        <details class="group">
          <summary>Camera</summary>
          <CameraControls {lab} position={cameraState.position} target={cameraState.target} />
        </details>
      {/if}

      <details class="group" open>
        <summary>Objects</summary>
        {#if objects.length}
          <ul class="object-list">
            {#each objects as obj (obj.id)}
              <li class="obj-row" class:selected={obj.id === selectedId}>
                <input
                  type="checkbox"
                  checked={obj.included}
                  onchange={(e) => lab?.setObjectIncluded(obj.id, e.currentTarget.checked)}
                />
                <button class="obj-name" onclick={() => selectObject(obj.id)}>{obj.name}</button>
                {#if obj.removable}
                  <button class="obj-remove" title="Remove from library" onclick={() => removeObject(obj.id)}>×</button>
                {/if}
              </li>
            {/each}
          </ul>
        {:else}
          <p class="hint pad">No objects yet -- import one below.</p>
        {/if}
        <div class="obj-import">
          <button onclick={() => fileInput?.click()}>Import .glb…</button>
          {#if importError}<p class="hint error">{importError}</p>{/if}
        </div>
      </details>
      <input type="file" accept=".glb" bind:this={fileInput} onchange={onImportFile} hidden />

      <details class="group" open>
        <summary>Lights</summary>
        {#if lights.length}
          <ul class="object-list">
            {#each lights as light (light.id)}
              <li class="obj-row" class:selected={light.id === selectedLightId}>
                <span class="light-swatch" style:background={light.color}></span>
                <button class="obj-name" onclick={() => selectLight(light.id)}>{light.name}</button>
                <span class="light-type">{light.type}</span>
                <button class="obj-remove" title="Remove light" onclick={() => removeLight(light.id)}>×</button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="hint pad">No lights added -- the room's own lighting still applies.</p>
        {/if}
        <div class="obj-import">
          <button onclick={addLight}>Add light</button>
        </div>
      </details>

      {#if !bundledIsEmpty}
        <details class="group">
          <summary>Bundled objects</summary>
          <div class="bundle-tree">
            <BundleTree node={bundledTree} {importedNames} onimport={importBundled} />
          </div>
        </details>
      {/if}

      {#if selectedId && selectedMaterial}
        <details class="group" open>
          <summary>Material — {selectedName}</summary>
          {#key selectedId}
            <MaterialPanel
              material={selectedMaterial}
              onchange={(m) => selectedId && lab?.setObjectMaterial(selectedId, m)}
            />
          {/key}
        </details>
      {/if}

      {#if selectedId && selectedTransform}
        <details class="group" open>
          <summary>Transform — {selectedName}</summary>
          {#key selectedId}
            <TransformPanel
              transform={selectedTransform}
              onchange={(t) => selectedId && lab?.setObjectTransform(selectedId, t)}
            />
          {/key}
        </details>
      {/if}

      {#if selectedLightId && selectedLight}
        <details class="group" open>
          <summary>Light — {selectedLight.name}</summary>
          {#key selectedLightId}
            <LightPanel
              light={selectedLight}
              onchange={(l) => selectedLightId && lab?.setLight(selectedLightId, l)}
            />
          {/key}
        </details>
      {/if}

      <p class="hint">
        Raster preview. Drag to orbit; the camera is saved with the scene and is
        where Generate's sweep starts. Lights show as small spheres here only.
      </p>
    {:else}
      <div class="status">
        <div><span class="key">Mode</span><span>{status.mode}</span></div>
        <div><span class="key">Samples</span><span>{status.samples}</span></div>
      </div>
      <p class="hint">
        What Generate will render, before any lighting multiplier. Nothing here
        is saved as an image -- use Generate for that.
      </p>
    {/if}
  </aside>
</main>

<style>
  main { display: flex; width: 100vw; height: 100vh; }

  aside {
    flex: 0 0 270px;
    padding: 0.8rem;
    display: flex; flex-direction: column; gap: 0.75rem;
    background: #16161c;
    border-left: 1px solid #2a2a33;
    overflow-y: auto;
  }

  label { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.85rem; color: #bbb; }
  .toggle { flex-direction: row; align-items: center; gap: 0.4rem; font-size: 0.75rem; color: #999; }
  code { font-size: 0.72rem; }

  select, input[type='text'] {
    padding: 0.35rem;
    border: 1px solid #3a3a45; border-radius: 6px;
    background: #22222b; color: #eee; font-size: 0.85rem;
    min-width: 0;
  }
  input[type='checkbox'] { accent-color: #7c6cf4; }

  button {
    padding: 0.4rem 0.5rem;
    border: 1px solid #3a3a45; border-radius: 6px;
    background: #22222b; color: #eee; cursor: pointer; font-size: 0.85rem;
  }
  button:hover:not(:disabled) { background: #2c2c37; }
  button:disabled { opacity: 0.4; cursor: default; }
  button.primary { background: #2a2440; border-color: #4a3f7a; color: #d9d2ff; font-weight: 600; }

  .scene-bar { display: flex; gap: 0.4rem; }
  .scene-bar select { flex: 1; }

  .scene-name {
    padding: 0.45rem 0.7rem; border-radius: 6px;
    background: #101016; color: #f0f0f4; font-weight: 600; font-size: 0.9rem;
  }
  .scene-name .file { font-weight: 400; font-size: 0.72rem; color: #888; margin-top: 0.15rem; }
  .dirty { color: #e0a060; }

  .save { display: flex; flex-direction: column; gap: 0.4rem; }
  .save-as { display: flex; gap: 0.4rem; }
  .save-as input { flex: 1; }

  .mode-toggle { background: #2a2440; border-color: #4a3f7a; font-weight: 600; color: #d9d2ff; }

  .group { border: 1px solid #2a2a33; border-radius: 6px; background: #101016; }
  .group > summary {
    padding: 0.45rem 0.7rem; cursor: pointer;
    font-size: 0.72rem; font-weight: 600; color: #aaa;
    text-transform: uppercase; letter-spacing: 0.05em; user-select: none;
  }
  .group[open] > summary { border-bottom: 1px solid #2a2a33; }

  .object-list { list-style: none; margin: 0; padding: 0.5rem; display: flex; flex-direction: column; gap: 0.15rem; }
  .obj-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.2rem 0.35rem; border-radius: 4px; }
  .obj-row.selected { background: #2a2440; }
  .obj-name {
    flex: 1; text-align: left; padding: 0.1rem 0.2rem;
    border: none; background: none; color: #ddd; font-size: 0.85rem;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .obj-row.selected .obj-name { color: #f0f0f4; font-weight: 600; }
  .obj-name:hover { color: #fff; background: none; }
  .obj-remove { padding: 0 0.3rem; border: none; background: none; color: #888; font-size: 1.1rem; line-height: 1; }
  .obj-remove:hover { color: #e77; background: none; }
  .obj-import { padding: 0.5rem 0.7rem; border-top: 1px solid #2a2a33; }
  .obj-import button { width: 100%; }
  .light-swatch { flex: 0 0 auto; width: 0.8rem; height: 0.8rem; border: 1px solid #3a3a45; border-radius: 50%; }
  .light-type { font-size: 0.7rem; color: #777; }
  .bundle-tree { padding: 0.4rem 0.6rem 0.6rem; max-height: 40vh; overflow-y: auto; }

  .status {
    display: flex; flex-direction: column; gap: 0.25rem;
    padding: 0.6rem; border-radius: 6px; background: #101016;
    font-size: 0.85rem; color: #eee; font-variant-numeric: tabular-nums;
  }
  .status div { display: flex; justify-content: space-between; }
  .status .key { color: #888; }

  .hint { margin: 0; font-size: 0.75rem; color: #777; line-height: 1.45; }
  .hint.pad { padding: 0.6rem 0.7rem; }
  .hint.error { color: #e88; white-space: pre-wrap; font-family: inherit; }
</style>
