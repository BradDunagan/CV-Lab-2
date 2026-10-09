// IndexedDB-backed store for imported objects. Each object's .glb bytes are
// kept as a binary ArrayBuffer (no base64 inflation) in IndexedDB, whose quota
// is far larger than localStorage's ~5 MB — so large/textured models fit. Kept
// separate from the scene store (scenes reference library objects by key).
//
// Migrated from a localStorage+base64 store; existing localStorage imports are
// imported into IndexedDB once, on first open.

const DB_NAME = 'pt-lab';
const DB_VERSION = 1;
const STORE = 'imports';
const LEGACY_KEY = 'pt-lab.library';
const MIGRATED_FLAG = 'pt-lab.library.migrated';

export interface StoredImport {
	key: string;
	name: string;
	/** Raw .glb bytes (stored directly — no base64). */
	glb: ArrayBuffer;
}

interface LegacyImport {
	key: string;
	name: string;
	glbBase64: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE)) {
				db.createObjectStore(STORE, { keyPath: 'key' });
			}
		};
		req.onsuccess = () => {
			const db = req.result;
			migrateFromLocalStorage(db)
				.catch((err) => console.warn('Library migration skipped:', err))
				.finally(() => resolve(db));
		};
		req.onerror = () => reject(req.error);
	});
	return dbPromise;
}

/** Run a single-store transaction and resolve with the request result. */
function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	return openDB().then(
		(db) =>
			new Promise<T>((resolve, reject) => {
				const t = db.transaction(STORE, mode);
				const req = run(t.objectStore(STORE));
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error);
			}),
	);
}

export function listImports(): Promise<StoredImport[]> {
	return tx('readonly', (s) => s.getAll() as IDBRequest<StoredImport[]>).then((r) => r ?? []);
}

/** One stored import by key, or null if this browser has none under it. */
export function getImport(key: string): Promise<StoredImport | null> {
	return tx('readonly', (s) => s.get(key) as IDBRequest<StoredImport | undefined>).then((r) => r ?? null);
}

/** Rejects (QuotaExceededError) if storage is exhausted — caller surfaces it. */
export async function saveImport(rec: StoredImport): Promise<void> {
	await tx('readwrite', (s) => s.put(rec));
}

export async function deleteImport(key: string): Promise<void> {
	await tx('readwrite', (s) => s.delete(key));
}

/** One-time import of the legacy localStorage+base64 store into IndexedDB. */
async function migrateFromLocalStorage(db: IDBDatabase): Promise<void> {
	if (typeof localStorage === 'undefined') return;
	if (localStorage.getItem(MIGRATED_FLAG)) return;
	const raw = localStorage.getItem(LEGACY_KEY);
	if (raw) {
		const old = JSON.parse(raw) as LegacyImport[];
		await new Promise<void>((resolve, reject) => {
			const t = db.transaction(STORE, 'readwrite');
			const store = t.objectStore(STORE);
			for (const r of old) {
				store.put({ key: r.key, name: r.name, glb: base64ToArrayBuffer(r.glbBase64) });
			}
			t.oncomplete = () => resolve();
			t.onerror = () => reject(t.error);
		});
		localStorage.removeItem(LEGACY_KEY);
	}
	localStorage.setItem(MIGRATED_FLAG, '1');
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}
