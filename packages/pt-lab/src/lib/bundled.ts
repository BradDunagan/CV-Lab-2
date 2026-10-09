// Build-time enumeration of the bundled importable objects under
// src/assets/imports/. Vite's import.meta.glob statically discovers every .glb
// at any depth and emits it as a served asset URL, so dropping a new file (or a
// whole new subdirectory) into assets/imports/ automatically appears in the
// in-app browser — no manifest to maintain. The flat glob is assembled into a
// directory tree mirroring the folder layout.

export interface BundleFile {
	name: string; // file name without the .glb extension
	url: string; // served asset URL (fetchable)
}

export interface BundleDir {
	name: string;
	dirs: BundleDir[];
	files: BundleFile[];
}

const modules = import.meta.glob('../assets/imports/**/*.glb', {
	query: '?url',
	import: 'default',
	eager: true,
}) as Record<string, string>;

function insert(root: BundleDir, relPath: string, url: string) {
	const parts = relPath.split('/');
	const fileName = parts.pop()!;
	let dir = root;
	for (const part of parts) {
		let child = dir.dirs.find((d) => d.name === part);
		if (!child) {
			child = { name: part, dirs: [], files: [] };
			dir.dirs.push(child);
		}
		dir = child;
	}
	dir.files.push({ name: fileName.replace(/\.glb$/i, ''), url });
}

function sortDir(dir: BundleDir) {
	dir.dirs.sort((a, b) => a.name.localeCompare(b.name));
	dir.files.sort((a, b) => a.name.localeCompare(b.name));
	dir.dirs.forEach(sortDir);
}

function build(): BundleDir {
	const root: BundleDir = { name: 'imports', dirs: [], files: [] };
	const marker = 'assets/imports/';
	for (const [key, url] of Object.entries(modules)) {
		const idx = key.indexOf(marker);
		if (idx < 0) continue;
		insert(root, key.slice(idx + marker.length), url);
	}
	sortDir(root);
	return root;
}

export const bundledTree: BundleDir = build();
export const bundledIsEmpty = bundledTree.dirs.length === 0 && bundledTree.files.length === 0;
