// localStorage-backed store for named editor scenes. Plain data only — the
// SceneData shape (room + per-object state + camera) is owned by pathtracer.ts.
import type { SceneData } from './pathtracer';
import { getImport } from './library-store';

const STORAGE_KEY = 'pt-lab.scenes';

function readAll(): Record<string, SceneData> {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? (JSON.parse(raw) as Record<string, SceneData>) : {};
	} catch {
		return {};
	}
}

function writeAll(all: Record<string, SceneData>) {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

export function listSceneNames(): string[] {
	return Object.keys(readAll()).sort((a, b) => a.localeCompare(b));
}

export function loadSceneData(name: string): SceneData | null {
	return readAll()[name] ?? null;
}

export function saveSceneData(name: string, data: SceneData) {
	const all = readAll();
	all[name] = data;
	writeAll(all);
}

export function deleteSceneData(name: string) {
	const all = readAll();
	delete all[name];
	writeAll(all);
}

/** Filename-safe slug of a scene name. */
function slug(name: string): string {
	return (
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'scene'
	);
}

/** Hand the browser a file to save. */
function download(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	a.click();
	// Revoked later rather than at once: a large model's download can still be
	// reading the blob when click() returns.
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Download a scene as pretty-printed JSON — the same `SceneData` that Save
 * puts in localStorage, so an export can be pasted back in or kept in a repo —
 * plus the .glb of every imported model the scene includes.
 *
 * Objects are referenced by library key, and an import's key names an
 * IndexedDB record in THIS browser, which nothing else can read. So each
 * included import is also written out under its `glb` file name, with its
 * `sha256` in the JSON, and a host elsewhere can find the file and confirm it
 * is the same model (see PathTracerLab.registerImport). Excluded imports keep
 * their fields but are not written: the scene does not need them.
 *
 * Rejects, before downloading anything, if an included import has no hash —
 * which happens only where Web Crypto is unavailable (a plain-http page) — or
 * no bytes in this browser. A scene that silently arrived without its model
 * would render without it.
 *
 * The browser may ask once whether this site can download several files.
 */
export async function exportSceneData(name: string, data: SceneData): Promise<void> {
	const models = new Map<string, ArrayBuffer>();
	for (const o of data.objects) {
		if (!o.included) continue;
		const rec = await getImport(o.key);
		if (!o.glb || !o.sha256) {
			if (rec) {
				throw new Error(
					`"${rec.name}" has no content hash — this page is not a secure context, so Web Crypto is unavailable`,
				);
			}
			continue; // a built-in
		}
		if (!rec) throw new Error(`"${o.glb}" is not stored in this browser, so it cannot be exported`);
		models.set(o.glb, rec.glb);
	}

	download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${slug(name)}.pt-scene.json`);
	for (const [filename, bytes] of models) {
		download(new Blob([bytes], { type: 'model/gltf-binary' }), filename);
	}
}

/** A fresh scene: an area-light room with the light but no objects included. */
export function newSceneData(): SceneData {
	return { version: 1, room: 'room-arealight', objects: [], camera: null };
}
