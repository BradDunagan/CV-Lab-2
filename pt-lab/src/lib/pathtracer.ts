import {
	ACESFilmicToneMapping,
	AmbientLight,
	Box3,
	BoxGeometry,
	CanvasTexture,
	CircleGeometry,
	Color,
	DataTexture,
	EquirectangularReflectionMapping,
	FloatType,
	Group,
	LinearFilter,
	LinearSRGBColorSpace,
	Mesh,
	MeshBasicMaterial,
	MeshNormalMaterial,
	MeshPhysicalMaterial,
	MeshStandardMaterial,
	NoToneMapping,
	PCFSoftShadowMap,
	PerspectiveCamera,
	PlaneGeometry,
	PointLight,
	RepeatWrapping,
	RGBAFormat,
	Scene,
	ShaderMaterial,
	SphereGeometry,
	SpotLight,
	SRGBColorSpace,
	TorusKnotGeometry,
	Vector2,
	Vector3,
	WebGLRenderer,
	WebGLRenderTarget,
	type Light,
	type Material,
	type Object3D,
	type Texture,
} from 'three';
import { RectAreaLight } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import type { UNet } from 'oidn-web';
import { listImports, saveImport, deleteImport } from './library-store';

export type RenderMode = 'loading' | 'building-bvh' | 'raster' | 'pathtracing' | 'editing';

export type DenoiseState =
	| 'off'
	| 'unsupported'
	| 'loading'
	| 'ready'
	| 'denoising'
	| 'denoised'
	| 'error';

export interface LabStatus {
	mode: RenderMode;
	samples: number;
	elapsedMs: number;
	denoise: DenoiseState;
	/** Sample count the visible denoised image was computed from (0 = none). */
	denoisedAt: number;
	/** Whether denoising currently uses albedo/normal auxiliary buffers. */
	denoiseAux: boolean;
}

export interface LabOptions {
	onStatus?: (status: LabStatus) => void;
	/** Overlay canvas the denoised image is drawn onto (shown via opacity). */
	denoiseCanvas?: HTMLCanvasElement;
	/**
	 * Asset URLs. Default to `${BASE_URL}assets/…` so a host that serves those
	 * files in its public dir works out of the box; consumers of the package
	 * can point these at their own assets.
	 */
	modelUrl?: string;
	envUrl?: string;
	denoiserWeights?: {
		/** Color-only LDR weights. */
		ldr?: string;
		/** LDR + albedo/normal aux weights. */
		ldrAux?: string;
	};
}

/** An editor-addressable object in the scene (plain data — no three.js types). */
export interface LabObject {
	id: string;
	name: string;
	/** Whether the object is part of the scene (unchecked = hidden). */
	included: boolean;
	/** Imported objects can be removed from the library; built-ins cannot. */
	removable: boolean;
}

/** An entry in the object library (a built-in primitive or an imported model). */
interface LibraryItem {
	key: string;
	name: string;
	kind: 'builtin' | 'imported';
	/** SHA-256 of an import's .glb bytes (lowercase hex); absent for built-ins. */
	sha256?: string;
}

const BUILTIN_LIBRARY: LibraryItem[] = [
	{ key: 'Table', name: 'Table', kind: 'builtin' },
	{ key: 'Cube', name: 'Cube', kind: 'builtin' },
	{ key: 'Ball', name: 'Ball', kind: 'builtin' },
];

/** An object's transform, in editor-friendly units (meters, degrees, factor). */
export interface LabTransform {
	position: [number, number, number];
	rotation: [number, number, number];
	scale: [number, number, number];
}

/**
 * An object's appearance in editor-friendly terms. These map onto PBR
 * material properties: shininess = 1 - roughness, reflectivity = metalness.
 */
/** Procedural texture options (generated in-app; no asset downloads). */
export type LabTexture = 'none' | 'cloth';

export interface LabMaterial {
	color: string; // '#rrggbb' (sRGB) — tints the texture when one is set
	shininess: number; // 0 (matte) .. 1 (mirror-sharp)
	reflectivity: number; // 0 (dielectric) .. 1 (metal)
	texture?: LabTexture; // absent = 'none'
}

/** One object's persisted state within a scene. */
export interface SceneObjectState {
	key: string; // stable library key (the object's name for built-ins)
	included: boolean;
	/**
	 * Imported objects only: the file name Export writes the model's .glb under
	 * (see modelFileName), and the SHA-256 of those bytes. The key alone names
	 * an IndexedDB record in whichever browser imported the model, which no
	 * other host can resolve; these let a host outside that browser find the
	 * file and confirm it is the same model. Absent for built-ins, and in
	 * scenes saved before they existed.
	 */
	glb?: string;
	sha256?: string;
	// Absent means "use the object's factory default" (how demos include
	// built-ins without duplicating their default look/placement).
	material?: LabMaterial;
	transform?: LabTransform;
}

/**
 * Editor light kinds. Spot and area lights aim at the room center (the floor
 * origin). No directional light: in the geometric rooms the walls and ceiling
 * occlude its infinitely distant source, so it would light the raster preview
 * but not the path-traced render.
 */
export type LabLightType = 'point' | 'spot' | 'area';

/** A light's editable state (plain data — no three.js types). */
export interface LabLight {
	name: string;
	type: LabLightType;
	color: string; // '#rrggbb' (sRGB)
	/** three.js physical units: candela for point/spot, nits for area. */
	intensity: number;
	position: [number, number, number]; // meters
}

/** A light in the scene, addressable by a stable per-session id. */
export interface LabLightEntry extends LabLight {
	id: string;
}

/** Per-type metadata for building light controls. */
export interface LabLightTypeInfo {
	type: LabLightType;
	label: string;
	unit: string;
	defaultIntensity: number;
	maxIntensity: number;
}

// Defaults give roughly the room lamp's irradiance straight below the light
// (the lamp is 40 nits over 0.5 m², ~20/d²): a point or spot of I candela
// gives I/d², an area light of L nits over 0.25 m² gives L/4/d².
export const LIGHT_TYPES: LabLightTypeInfo[] = [
	{ type: 'point', label: 'Point', unit: 'cd', defaultIntensity: 20, maxIntensity: 200 },
	{ type: 'spot', label: 'Spot', unit: 'cd', defaultIntensity: 20, maxIntensity: 200 },
	{ type: 'area', label: 'Area (0.5 × 0.5 m)', unit: 'nt', defaultIntensity: 80, maxIntensity: 800 },
];

export function lightTypeInfo(type: LabLightType): LabLightTypeInfo {
	return LIGHT_TYPES.find((t) => t.type === type) ?? LIGHT_TYPES[0];
}

/** A saved editor scene: room + per-object state + lights + camera. */
export interface SceneData {
	version: 1;
	room: RoomKind;
	objects: SceneObjectState[];
	/** Absent in scenes saved before editor lights existed (= no lights). */
	lights?: LabLight[];
	camera: { position: [number, number, number]; target: [number, number, number] } | null;
}

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

const ASSET_BASE = `${import.meta.env.BASE_URL}assets/`;
const DEFAULT_MODEL_URL = `${ASSET_BASE}damaged-helmet.glb`;
const DEFAULT_ENV_URL = `${ASSET_BASE}royal_esplanade_1k.hdr`;
const DEFAULT_LDR_WEIGHTS = `${ASSET_BASE}rt_ldr.tza`;
const DEFAULT_LDR_AUX_WEIGHTS = `${ASSET_BASE}rt_ldr_alb_nrm.tza`;

// Samples a fixed-size PNG export converges to before it's written. Small
// export sizes reach this quickly; 1024² takes a few seconds (progress shown).
const EXPORT_SAMPLES = 300;
// The OIDN denoiser pads inputs smaller than its tile size and the padding
// (garbage) bleeds into the image via the UNet's receptive field, wrecking
// small denoised exports. So denoise at >= this size, then downscale.
const DENOISE_MIN_SIZE = 256;

// canvas.toBlob() writes an untagged PNG (IHDR/IDAT/IEND only — no color
// chunks at all), leaving the transfer function and gamut to whatever the
// reader assumes. The beauty export IS sRGB (the renderer's default output
// color space plus ACES tone mapping), so it says so explicitly: an sRGB
// chunk, plus the gAMA/cHRM pair the spec tells you to write alongside it for
// decoders that predate sRGB awareness. Together they pin both the transfer
// curve and the primaries, so no reader has to guess. The depth and
// object-space-position passes stay untagged on purpose: they carry raw
// linear code values, not color, and any tag would invite a conversion.
const GAMA_SRGB = 45455; // file gamma 1/2.2 * 100000, per the PNG spec
// sRGB primaries and the D65 white point, in the spec's 100000ths:
// white x,y | red x,y | green x,y | blue x,y
const CHRM_SRGB = [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000];
const SRGB_INTENT_PERCEPTUAL = 0; // the intent for a displayed rendering

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
	if (!crcTable) {
		crcTable = new Uint32Array(256);
		for (let n = 0; n < 256; n++) {
			let c = n;
			for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
			crcTable[n] = c >>> 0;
		}
	}
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

/** Assemble one PNG chunk: length(4) + type(4) + data + crc(4) over type+data. */
function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
	const chunk = new Uint8Array(12 + data.length);
	const view = new DataView(chunk.buffer);
	view.setUint32(0, data.length);
	for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
	chunk.set(data, 8);
	view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
	return chunk;
}

function u32be(values: number[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(values.length * 4);
	const view = new DataView(out.buffer);
	values.forEach((v, i) => view.setUint32(i * 4, Math.round(v)));
	return out;
}

/**
 * Return a copy of `png` declaring its pixels as sRGB — sRGB + gAMA + cHRM,
 * spliced in after IHDR (all three must precede PLTE and IDAT). Chunks the
 * encoder already wrote are left alone rather than duplicated, so this is
 * idempotent; iCCP is honored too, since the spec forbids pairing it with
 * sRGB. Returns the input untouched if it isn't a PNG we can parse.
 */
async function tagSRGB(png: Blob): Promise<Blob> {
	const bytes = new Uint8Array(await png.arrayBuffer());
	const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	if (bytes.length < 8 + 12 || SIG.some((b, i) => bytes[i] !== b)) return png;

	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const typeAt = (off: number) =>
		String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
	if (typeAt(8) !== 'IHDR') return png;
	const insertAt = 8 + 12 + view.getUint32(8); // past signature + the whole IHDR chunk
	if (insertAt + 12 > bytes.length) return png;

	// Walk the chunks ahead of the pixel data to see what's already declared.
	const present = new Set<string>();
	for (let off = insertAt; off + 12 <= bytes.length; ) {
		const type = typeAt(off);
		if (type === 'IDAT' || type === 'PLTE' || type === 'IEND') break;
		present.add(type);
		off += 12 + view.getUint32(off);
	}
	const managed = present.has('iCCP') || present.has('cICP');

	const additions: BlobPart[] = [];
	if (!present.has('cHRM') && !managed) additions.push(pngChunk('cHRM', u32be(CHRM_SRGB)));
	if (!present.has('gAMA') && !managed) additions.push(pngChunk('gAMA', u32be([GAMA_SRGB])));
	if (!present.has('sRGB') && !managed)
		additions.push(pngChunk('sRGB', new Uint8Array([SRGB_INTENT_PERCEPTUAL])));
	if (!additions.length) return png;

	const parts: BlobPart[] = [bytes.subarray(0, insertAt), ...additions, bytes.subarray(insertAt)];
	return new Blob(parts, { type: 'image/png' });
}

/** ?scene=procedural | room | room-emissive | room-arealight forces an alternate scene instead of the helmet. */
function sceneParam(): string | null {
	return new URLSearchParams(location.search).get('scene');
}

/** Dispose every geometry and material under an object before discarding it. */
function disposeObject(obj: Object3D) {
	obj.traverse((child) => {
		const mesh = child as Mesh;
		if (!mesh.isMesh) return;
		mesh.geometry?.dispose();
		const mat = mesh.material;
		if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
		else mat?.dispose();
	});
}

/** Meshes under `obj` take part in the edit-mode shadow maps. */
function setShadowFlags(obj: Object3D, cast: boolean, receive: boolean) {
	obj.traverse((child) => {
		const mesh = child as Mesh;
		if (!mesh.isMesh) return;
		mesh.castShadow = cast;
		mesh.receiveShadow = receive;
	});
}

/** A SpotLight standing in for a lamp that cannot cast a shadow map itself. */
function makeProxyLight(): SpotLight {
	const proxy = new SpotLight(0xffffff, 0, 0, PROXY_ANGLE, PROXY_PENUMBRA);
	proxy.castShadow = true;
	proxy.visible = false;
	// The wide cone spreads the map over a large frustum — 2k keeps it crisp.
	proxy.shadow.mapSize.set(2048, 2048);
	proxy.shadow.camera.near = 0.1;
	proxy.shadow.camera.far = 2 * ROOM_CEIL;
	proxy.shadow.bias = -0.0005;
	proxy.shadow.normalBias = 0.02;
	return proxy;
}

/**
 * SHA-256 of some bytes as lowercase hex, or undefined where Web Crypto is not
 * available (crypto.subtle exists only in secure contexts: https, localhost,
 * or a scheme registered as secure). Undefined rather than a throw, so a plain
 * http page can still import models; Export is what refuses without a hash.
 */
async function sha256Hex(bytes: ArrayBuffer): Promise<string | undefined> {
	if (!globalThis.crypto?.subtle) return undefined;
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The file name an imported model is exported under: its library name, made
 * safe for a file system, plus the first 12 hex digits of its SHA-256. The
 * hash is in the name so two different models that share a name — two
 * `bracket.glb`s — cannot overwrite each other in one directory, and the same
 * model exported from several scenes lands on one file.
 */
export function modelFileName(name: string, sha256: string): string {
	const safe = name.replace(/[\\/:*?"<>| -]+/g, '_').trim() || 'model';
	return `${safe}-${sha256.slice(0, 12)}.glb`;
}

/** Copy light data so callers never share the lab's position tuple. */
function copyLight(l: LabLight): LabLight {
	return { name: l.name, type: l.type, color: l.color, intensity: l.intensity, position: [...l.position] };
}


/* ------------------------------------------------------------------ */
/* Ground truth                                                        */
/*                                                                     */
/* Everything below answers one question for a consumer that measures  */
/* geometry in the rendered image: WHERE ARE THE EDGES REALLY. The     */
/* renderer knows, because it has the meshes and the camera; a feature */
/* detector can only guess. So the scene's own geometry is projected   */
/* into image space and handed back as plain data.                     */
/* ------------------------------------------------------------------ */

/** Why a mesh edge shows up in the image at all. */
export type EdgeCause =
	/** One adjacent face points at the camera and the other away: this is where
	 *  the object ends against whatever is behind it. VIEW-DEPENDENT — a smooth
	 *  sphere has no hard edges and still has a silhouette. */
	| 'silhouette'
	/** Two faces meet at an angle sharper than `creaseAngle`. A property of the
	 *  mesh, not of the view — a cube's twelve edges are always creases. */
	| 'crease'
	/** Only one face uses this edge: the mesh is open here (a ground plane's
	 *  border, a cut-away). */
	| 'boundary';

/** One ground-truth edge, projected into image space. */
export interface GroundTruthEdge {
	id: number;
	cause: EdgeCause;
	/** The meshes this edge belongs to, by display name. Usually one; a floor
	 *  meeting a wall is the case where it is two. */
	objects: string[];
	/** Image-space endpoints in pixels, clipped to the frame. */
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	/** Camera-space forward depth at each endpoint, in metres. */
	z0: number;
	z1: number;
	/** 2-D length after clipping, in pixels. */
	length: number;
	/**
	 * From +x, anticlockwise, in IMAGE coordinates where y increases DOWNWARD,
	 * folded to [0, 180). Chosen to match what a detector measuring the same
	 * edge in the same image would report, so the two are directly comparable.
	 */
	angle: number;
	/** Angle between the two adjacent face normals, degrees. 180 for a boundary. */
	dihedral: number;
	/** Fraction of the edge that is neither occluded nor off-frame, 0..1. */
	visible: number;
	/** True if the frame cut it: the endpoints are no longer the real ones. */
	clipped: boolean;
	/** The vertices it runs between. */
	v0: number;
	v1: number;
}

/** A point where two or more ground-truth edges meet. */
export interface GroundTruthVertex {
	id: number;
	/** Image-space position in pixels. Outside the frame is possible and kept. */
	x: number;
	y: number;
	/** Camera-space forward depth, in metres. */
	z: number;
	/** How many ground-truth edges meet here. */
	degree: number;
	/** How many of those are at least partly visible. */
	visibleDegree: number;
	/** Whether the point lands inside the image at all. A clipped edge keeps
	 *  its real endpoints, and those are frequently outside. */
	onFrame: boolean;
	/** Whether the point survives the depth test. False when off-frame. */
	visible: boolean;
	/**
	 * The widest angle between any two incident edges, as LINES, in [0, 90].
	 *
	 * This is what separates a corner from a bend. A silhouette is delivered as
	 * a polyline, so its interior points are vertices of degree 2 whose edges
	 * run almost straight through — near 0 here. A cube's vertex is 60-90. Left
	 * as a number rather than a verdict, because where to cut is the consumer's
	 * question, not the renderer's.
	 */
	angle: number;
	objects: string[];
}

/** Ground-truth geometry for one view. */
export interface GroundTruthView {
	size: number;
	camera: {
		position: [number, number, number];
		target: [number, number, number];
		fov: number;
		aspect: number;
	};
	/** What `creaseAngle` the edges were extracted with, in degrees. */
	creaseAngle: number;
	/** Depth-pass normalisation, in metres — what a packed depth PNG decodes with. */
	maxDepth: number;
	edges: GroundTruthEdge[];
	vertices: GroundTruthVertex[];
	/** Meshes whose geometry could not be read, by name. Empty is the good case. */
	skipped: string[];
}

export type RoomKind = 'room' | 'room-emissive' | 'room-arealight';
const ROOM_KINDS = ['room', 'room-emissive', 'room-arealight'];

/** A built-in room demo expressed as editor-scene data (room + the 3 built-ins). */
function demoRoomData(room: RoomKind): SceneData {
	return {
		version: 1,
		room,
		objects: [
			{ key: 'Table', included: true },
			{ key: 'Cube', included: true },
			{ key: 'Ball', included: true },
		],
		camera: { position: [2.2, 1.3, 2.6], target: [0, 0.7, 0] },
	};
}

// Room scene: a 6 x 6 m room with a 3 m ceiling, lit by a bright ceiling
// patch. Three variants: 'room' bakes the room into a generated HDR
// environment map (walls/floor/ceiling are flat "painted" radiances);
// 'room-emissive' models the room as real geometry with an emissive mesh as
// the light (physically correct, but the path tracer only finds emissive
// meshes by chance — noisy); 'room-arealight' uses a RectAreaLight instead,
// which the path tracer importance-samples — correct and fast.
const ROOM_HALF = 3;
const ROOM_CEIL = 3;
const ROOM_EYE = new Vector3(0, 1.5, 0);
const PATCH_HALF_X = 0.25; // 0.5 m wide
const PATCH_HALF_Z = 0.5; // 1 m long
const PATCH_RADIANCE = 40;
// In the arealight room, the lamp's output is split: this fraction is emitted
// by a visible emissive quad (the "fixture"), the rest by a RectAreaLight.
// The pathtracer never intersects lights with rays (LIGHT_HIT is defined but
// unused in its shader), so without the quad the lamp would be invisible; a
// small fraction keeps the fixture bright to the eye while nearly all the
// light transport stays on the importance-sampled path.
const FIXTURE_FRACTION = 0.1;

// Editor lights: side of the square area light, where new lights appear (above
// the table), and the raster-only marker that shows each light in Edit mode.
const AREA_LIGHT_SIZE = 0.5;
const NEW_LIGHT_POSITION: [number, number, number] = [0, 2.2, 0];
const LIGHT_MARKER_RADIUS = 0.04;

// Edit-mode shadows. three.js shadow maps need a light that supports them,
// and a RectAreaLight does not ("There is no shadow support"), nor does the
// emissive room's lamp, which is a mesh. So every area-ish lamp gets a
// SpotLight proxy that stands in for it in the raster preview: it carries the
// lamp's output as candela (radiance × area) and casts the shadow, while the
// lamp itself is hidden. Swapped back on return to Render, where the path
// tracer does the real thing. Wide cone + penumbra to approximate an area
// light's soft edge.
// A wide cone so the proxy also reaches the walls the lamp used to light —
// nearly a point light, but a spot, because only spot/point/directional cast
// shadow maps and a spot needs one shadow pass where a point needs six.
const PROXY_ANGLE = (70 * Math.PI) / 180;
const PROXY_PENUMBRA = 0.5;
// How much of an area lamp's output moves to its proxy while editing. The
// remainder stays on the area light, which lights the walls the narrow proxy
// cone misses and fills its shadows — raster has no bounce light, so a lamp
// entirely on the proxy would leave pitch-black shadows and dark walls.
const PROXY_SHARE = 0.6;
// Raster has no bounce light, so shadow-map shadows go pure black where the
// path tracer would fill them with several bounces off the walls. A dim
// ambient stands in for that, scaled to the lamp. Edit mode only, and the
// tracer never sees it: it collects rect/spot/point/directional lights only.
const AMBIENT_FILL = 0.35;
const PATCH_AREA = PATCH_HALF_X * 2 * PATCH_HALF_Z * 2;
const AREA_LIGHT_AREA = AREA_LIGHT_SIZE * AREA_LIGHT_SIZE;

/**
 * Framework-agnostic wrapper around WebGLPathTracer. This class is the piece
 * intended to port into a larger app: the host UI only talks to its public
 * methods and the onStatus callback, never to three.js internals.
 */
/* ------------------------------------------------------------------ */
/* Ground-truth helpers                                                */
/*                                                                     */
/* Module scope on purpose: none of this touches renderer state, so it  */
/* stays testable and readable apart from the class.                    */
/* ------------------------------------------------------------------ */

/**
 * Quantum for merging coincident mesh vertices, in metres.
 *
 * BoxGeometry is indexed and splits its eight geometric corners into
 * twenty-four entries so each face can carry its own normal and UVs — the
 * POSITIONS of those entries are bit-identical, so any quantum merges them.
 * The value only matters for meshes whose shared corners were authored
 * separately and drifted; 10 micrometres is far below anything that reaches
 * a pixel on a metre-scale scene.
 */
const GT_QUANTUM = 1e5;

function gtKey(v: Vector3): string {
	return `${Math.round(v.x * GT_QUANTUM)},${Math.round(v.y * GT_QUANTUM)},${Math.round(v.z * GT_QUANTUM)}`;
}

interface GtFace {
	normal: Vector3;
	centroid: Vector3;
}

interface GtRawEdge {
	a: Vector3;
	b: Vector3;
	faces: GtFace[];
	/**
	 * Every mesh using this edge — usually one, and deliberately not always.
	 *
	 * The map is keyed by POSITION across the whole scene, so a floor and the
	 * wall standing on it share the entry their common edge sits at, and the
	 * dihedral between them comes out as the 90 degrees it really is. That
	 * junction is one edge in the image and it belongs to neither mesh alone.
	 */
	objects: Set<string>;
}

/**
 * Every undirected edge of one mesh, in world space, with the faces using it.
 *
 * Keyed by the pair of quantised endpoints, so the two triangles either side
 * of an edge find each other. An edge with one face is a mesh boundary; with
 * two, the pair is what decides crease and silhouette.
 */
function collectMeshEdges(mesh: Mesh, name: string, into: Map<string, GtRawEdge>): boolean {
	const geometry = mesh.geometry;
	const position = geometry?.getAttribute?.('position');
	if (!position) return false;

	mesh.updateWorldMatrix(true, false);
	const matrix = mesh.matrixWorld;
	const index = geometry.getIndex();
	const triangles = index ? index.count / 3 : position.count / 3;
	if (!Number.isInteger(triangles)) return false;

	const p = [new Vector3(), new Vector3(), new Vector3()];
	for (let t = 0; t < triangles; t++) {
		for (let k = 0; k < 3; k++) {
			const i = index ? index.getX(t * 3 + k) : t * 3 + k;
			p[k].fromBufferAttribute(position, i).applyMatrix4(matrix);
		}
		const normal = new Vector3()
			.subVectors(p[1], p[0])
			.cross(new Vector3().subVectors(p[2], p[0]));
		// A degenerate triangle has no normal and no edges worth reporting.
		if (normal.lengthSq() < 1e-24) continue;
		normal.normalize();
		const centroid = new Vector3().add(p[0]).add(p[1]).add(p[2]).multiplyScalar(1 / 3);

		for (let k = 0; k < 3; k++) {
			const a = p[k];
			const b = p[(k + 1) % 3];
			const ka = gtKey(a);
			const kb = gtKey(b);
			const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
			let edge = into.get(key);
			if (!edge) {
				edge = { a: a.clone(), b: b.clone(), faces: [], objects: new Set() };
				into.set(key, edge);
			}
			edge.faces.push({ normal, centroid });
			edge.objects.add(name);
		}
	}
	return true;
}

/** Decode one pixel of a packed 24-bit depth pass into metres. */
function gtDepthAt(data: Uint8ClampedArray, offset: number, maxDepth: number): number {
	return ((data[offset] + data[offset + 1] / 255 + data[offset + 2] / 65025) / 255) * maxDepth;
}

/**
 * Is a point at forward depth `z` unoccluded at this pixel?
 *
 * Rasterised visibility, so it is exact to about a pixel and no better. Three
 * details carry what accuracy there is:
 *
 *   - An UNCOVERED pixel counts as visible. The point is geometry and the
 *     depth pass rasterised nothing there, which happens along a silhouette
 *     where the edge lies within half a pixel of the boundary. Calling that
 *     occluded would delete exactly the edges this is built to find.
 *   - The comparison is against the NEAREST depth in the 3x3, not the centre
 *     pixel's. At a silhouette the centre pixel may hold either surface
 *     depending on where the rasteriser landed, and taking the nearer one
 *     decides the ambiguity conservatively: a hidden edge running close
 *     behind a silhouette stays hidden.
	 *   - The tolerance follows the LOCAL SLOPE, taken as the LARGEST step to a
	 *     neighbour. A surface seen at a grazing angle changes depth enormously
	 *     between neighbouring pixels, and a fixed tolerance reports every
	 *     grazing surface as self-occluding. The cost is that within a pixel of
	 *     a silhouette the tolerance admits almost anything.
	 *
	 * That last one looked like a defect and is not. A first run showed 22% of a
	 * cube's hidden back edge reading as visible, so the slope was replaced with
	 * a low quantile - robust at a step, and, measured against a view whose
	 * answer is known, strictly WORSE: two genuinely visible edges fell to 0.42
	 * and 0.49. A point ON a surface sits up to a pixel of that surface's
	 * gradient away from whatever the buffer holds, and a tolerance that throws
	 * the big gradient away cannot cover it. The 22% came from the FIXTURE, not
	 * the rule: that view was axis-aligned on an axis-aligned cube, so its
	 * hidden back edges projected exactly onto its visible silhouette edges, and
	 * no test at any tolerance could have separated them.
	 *
	 * Measured on a general view of a cube - nine edges visible, three not:
	 *
	 *     max slope x1.5      nine at 1.00,    three at <= 0.04   margin 0.96
	 *     low quantile x3     nine at >= 0.42, three at <= 0.04   margin 0.38
	 *     |d - z| <= 1% of z  nine at >= 0.83, three at <= 0.08   margin 0.75
	 */
function gtVisibleAt(
	data: Uint8ClampedArray,
	size: number,
	px: number,
	py: number,
	z: number,
	maxDepth: number,
): boolean {
	const ix = Math.floor(px);
	const iy = Math.floor(py);
	if (ix < 0 || iy < 0 || ix >= size || iy >= size) return false;
	const centre = (iy * size + ix) * 4;
	if (data[centre + 3] === 0) return true;

	const d = gtDepthAt(data, centre, maxDepth);
	let nearest = d;
	let slope = 0;
	for (let dy = -1; dy <= 1; dy++) {
		for (let dx = -1; dx <= 1; dx++) {
			if (dx === 0 && dy === 0) continue;
			const nx = ix + dx;
			const ny = iy + dy;
			if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
			const o = (ny * size + nx) * 4;
			if (data[o + 3] === 0) continue;
			const dn = gtDepthAt(data, o, maxDepth);
			if (dn < nearest) nearest = dn;
			const step = Math.abs(dn - d);
			if (step > slope) slope = step;
		}
	}
	// 2^24 is the packing's resolution; the relative term covers the rest.
	const tolerance = slope * 1.5 + (3 * maxDepth) / 16777216 + 1e-3 * z;
	return z <= nearest + tolerance;
}

/** Clip a 2-D segment to [0,size]^2, Liang-Barsky, in parameter space. */
function gtClipToFrame(
	x0: number,
	y0: number,
	x1: number,
	y1: number,
	size: number,
): [number, number] | null {
	const dx = x1 - x0;
	const dy = y1 - y0;
	let t0 = 0;
	let t1 = 1;
	const edges: [number, number][] = [
		[-dx, x0 - 0],
		[dx, size - x0],
		[-dy, y0 - 0],
		[dy, size - y0],
	];
	for (const [p, q] of edges) {
		if (p === 0) {
			if (q < 0) return null; // parallel to this side and outside it
			continue;
		}
		const r = q / p;
		if (p < 0) {
			if (r > t1) return null;
			if (r > t0) t0 = r;
		} else {
			if (r < t0) return null;
			if (r < t1) t1 = r;
		}
	}
	return [t0, t1];
}

/** Angle between two image-space directions, as LINES, in [0, 90] degrees. */
function gtLineAngle(ax: number, ay: number, bx: number, by: number): number {
	const dot = Math.abs(ax * bx + ay * by);
	const mag = Math.hypot(ax, ay) * Math.hypot(bx, by);
	if (mag < 1e-12) return 0;
	return (Math.acos(Math.min(1, dot / mag)) * 180) / Math.PI;
}

export class PathTracerLab {
	private renderer: WebGLRenderer;
	private scene = new Scene();
	private camera: PerspectiveCamera;
	private controls: OrbitControls;
	private pathTracer: WebGLPathTracer;
	private onStatus?: (status: LabStatus) => void;

	private rafId = 0;
	private maxSamples = 0; // 0 = unlimited
	private lastResetAt = performance.now();
	private lastSamples = 0;
	private ready = false;
	private disposed = false;
	private editing = false;
	private exporting = false;
	private patchMat: MeshPhysicalMaterial | null = null;
	private rectLight: RectAreaLight | null = null;
	// Stands in for the room's ceiling lamp in the raster views (both geometric
	// rooms; the baked-env room has no lamp object to stand in for).
	private roomProxy: SpotLight | null = null;
	// Stands in for bounce light in the raster views (geometric rooms).
	private ambientFill: AmbientLight | null = null;
	// Shadow maps are re-rendered only when the scene changed (autoUpdate off).
	private shadowsDirty = true;
	// Current room and its swappable pieces (shell geometry or baked env map).
	private roomKind: RoomKind | null = null;
	private roomShell: Object3D | null = null;
	private roomEnvTex: DataTexture | null = null;
	private envIntensity = 1;

	// Editor object registry. Keyed by a stable per-session id (decoupled from
	// the display name so imported duplicates never collide).
	private objects = new Map<
		string,
		{ object3d: Object3D; name: string; key: string; included: boolean }
	>();
	private objectCounter = 0;
	private objectsChanged?: (objects: LabObject[]) => void;

	// The object library: built-in primitives plus imported models. Imports are
	// parsed once into a template Object3D that scenes clone.
	private library: LibraryItem[] = [...BUILTIN_LIBRARY];
	private importTemplates = new Map<string, Object3D>();
	private importCounter = 0;
	// Set when the included-set or a transform changed while editing, so
	// returning to render rebuilds the BVH (drops hidden meshes via
	// traverseVisible; refits for moved geometry).
	private objectsDirty = false;
	// Set when only materials changed — a cheaper updateMaterials() on return.
	private materialsDirty = false;

	// Editor lights, keyed by a stable per-session id. Lights live in their own
	// group in the scene; each has a marker sphere in markerScene, which only the
	// Edit-mode raster pass draws, so markers never reach the tracer's BVH or
	// the ground-truth passes.
	private lights = new Map<
		string,
		{ light: Light; proxy: SpotLight | null; marker: Mesh; data: LabLight }
	>();
	private lightCounter = 0;
	private lightsGroup: Group | null = null;
	private markerScene = new Scene();
	private lightsChanged?: (lights: LabLightEntry[]) => void;
	// Set when lights changed while editing — updateLights() on return, which
	// repacks the light list without a BVH rebuild.
	private lightsDirty = false;
	// True while buildEditorScene rebuilds; suppresses tracer syncs against the
	// half-built scene (setScene refreshes everything once the build finishes).
	private buildingScene = false;

	private denoiseCanvas?: HTMLCanvasElement;
	private modelUrl: string;
	private envUrl: string;
	private ldrWeightsUrl: string;
	private ldrAuxWeightsUrl: string;
	private captureCanvas = document.createElement('canvas');
	private denoiseEnabled = false;
	private denoiseState: DenoiseState = 'off';
	private denoiseBusy = false;
	private denoisedAtSamples = 0;
	private abortDenoise: (() => void) | null = null;

	// Two UNets: one trained on color only, one on color + albedo/normal aux
	// buffers. They are mutually incompatible (an aux net requires the aux
	// inputs, a plain net rejects them), so both are kept and loaded lazily.
	private unetPlain: UNet | null = null;
	private unetAux: UNet | null = null;
	private unetPromises: { plain: Promise<UNet> | null; aux: Promise<UNet> | null } = {
		plain: null,
		aux: null,
	};
	private auxEnabled = true;
	private auxAvailable = true;
	private auxCache: { albedo: ImageData; normal: ImageData } | null = null;
	private normalMaterial = new MeshNormalMaterial();
	private basicMirrors = new WeakMap<Material, MeshBasicMaterial>();
	// Object-space-position G-buffer: outputs each fragment's LOCAL vertex
	// position, normalized to the object's bounding box, into RGB (alpha = 1 as a
	// coverage mask). Because it's the *local* position (pre-world-transform), the
	// same surface point yields the same color under any rotation — a ground-truth
	// correspondence label used only for scoring feature matchers (Demo 7/8). Only
	// used in an off-screen raster pass, never handed to the path tracer.
	private positionMaterial = new ShaderMaterial({
		uniforms: { uMin: { value: new Vector3() }, uInvSize: { value: new Vector3(1, 1, 1) } },
		vertexShader: /* glsl */ `
			varying vec3 vPos;
			void main() {
				vPos = position;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
			}
		`,
		fragmentShader: /* glsl */ `
			uniform vec3 uMin;
			uniform vec3 uInvSize;
			varying vec3 vPos;
			void main() {
				vec3 n = clamp((vPos - uMin) * uInvSize, 0.0, 1.0);
				gl_FragColor = vec4(n, 1.0);
			}
		`,
	});

	// Whole-scene depth G-buffer: outputs each fragment's FORWARD depth (camera-
	// space -z, the same convention world-lab's plane-sweep uses), normalized by
	// uInvMaxDepth and packed into RGB with the standard fract ladder (24-bit
	// fixed point, so 8-bit PNG channels reconstruct depth losslessly to
	// ~maxDepth/2^24). Alpha = coverage (0 where no geometry). Ground truth for
	// grading Demo 7's dense reconstruction; raster-only, never path traced.
	private depthMaterial = new ShaderMaterial({
		uniforms: { uInvMaxDepth: { value: 1 } },
		vertexShader: /* glsl */ `
			varying float vViewZ;
			void main() {
				vec4 mv = modelViewMatrix * vec4(position, 1.0);
				vViewZ = -mv.z;
				gl_Position = projectionMatrix * mv;
			}
		`,
		fragmentShader: /* glsl */ `
			uniform float uInvMaxDepth;
			varying float vViewZ;
			void main() {
				float d = clamp(vViewZ * uInvMaxDepth, 0.0, 0.999999);
				vec3 enc = fract(vec3(1.0, 255.0, 65025.0) * d);
				enc -= enc.yzz * vec3(1.0 / 255.0, 1.0 / 255.0, 0.0);
				gl_FragColor = vec4(enc, 1.0);
			}
		`,
	});

	constructor(canvas: HTMLCanvasElement, options: LabOptions = {}) {
		this.onStatus = options.onStatus;
		this.denoiseCanvas = options.denoiseCanvas;
		this.modelUrl = options.modelUrl ?? DEFAULT_MODEL_URL;
		this.envUrl = options.envUrl ?? DEFAULT_ENV_URL;
		this.ldrWeightsUrl = options.denoiserWeights?.ldr ?? DEFAULT_LDR_WEIGHTS;
		this.ldrAuxWeightsUrl = options.denoiserWeights?.ldrAux ?? DEFAULT_LDR_AUX_WEIGHTS;

		this.renderer = new WebGLRenderer({ canvas, antialias: true });
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		this.renderer.toneMapping = ACESFilmicToneMapping;
		// Shadow maps for the raster views (Edit mode, and the tracer's own
		// interaction frames). The scene is static between edits, so they are
		// re-rendered on demand rather than every frame — see shadowsDirty.
		this.renderer.shadowMap.enabled = true;
		this.renderer.shadowMap.type = PCFSoftShadowMap;
		this.renderer.shadowMap.autoUpdate = false;

		this.camera = new PerspectiveCamera(50, 1, 0.05, 100);
		this.camera.position.set(2.2, 1.3, 2.6);

		this.controls = new OrbitControls(this.camera, canvas);
		this.controls.addEventListener('change', () => {
			if (this.ready) this.pathTracer.updateCamera();
		});

		this.pathTracer = new WebGLPathTracer(this.renderer);
		this.pathTracer.bounces = 5;
		this.pathTracer.filterGlossyFactor = 0.5;
		// Hybrid interaction pattern: rasterize during the delay after any
		// reset, path trace at low res while converging, then fade in.
		this.pathTracer.rasterizeScene = true;
		this.pathTracer.renderDelay = 150;
		this.pathTracer.fadeDuration = 300;
		this.pathTracer.minSamples = 1;
		this.pathTracer.dynamicLowRes = true;
		this.pathTracer.lowResScale = 0.35;
		this.pathTracer.tiles.set(2, 2);
	}

	async init(): Promise<void> {
		this.emit('loading');

		const kind = sceneParam();
		const isRoom = ROOM_KINDS.includes(kind ?? '');

		// Parse persisted imports into templates before building anything.
		await this.loadImports();
		if (this.disposed) return;

		if (isRoom) {
			// A room demo is just a pre-populated editor scene.
			this.buildEditorScene(demoRoomData(kind as RoomKind));
		} else {
			const [hdrEnv, model] = await Promise.all([
				new HDRLoader().loadAsync(this.envUrl),
				this.loadModel(),
			]);
			if (this.disposed) return;
			hdrEnv.mapping = EquirectangularReflectionMapping;
			this.scene.environment = hdrEnv;
			this.scene.background = hdrEnv;
			if (!model.name) model.name = 'Model';
			setShadowFlags(model, true, true);
			this.scene.add(model);

			const bounds = new Box3().setFromObject(model);
			const size = bounds.getSize(new Vector3());
			this.controls.target.set(0, size.y / 2, 0);
			this.controls.update();

			const floor = new Mesh(
				new CircleGeometry(Math.max(size.x, size.z) * 3, 64).rotateX(-Math.PI / 2),
				new MeshPhysicalMaterial({ color: 0xdedede, roughness: 0.85 }),
			);
			floor.name = 'Floor';
			floor.receiveShadow = true;
			this.scene.add(floor);
		}

		this.emit('building-bvh');
		// Yield a frame so the status paints before the synchronous BVH build.
		await new Promise(requestAnimationFrame);
		if (this.disposed) return;

		this.pathTracer.setScene(this.scene, this.camera);
		this.ready = true;
		this.lastResetAt = performance.now();
		this.emitObjects();
		this.emitLights();
		this.loop();
	}

	private async loadModel(): Promise<Object3D> {
		if (sceneParam() === 'procedural') return this.makeProceduralScene();
		try {
			const gltf = await new GLTFLoader().loadAsync(this.modelUrl);
			const model = gltf.scene;
			// Center on origin, resting on the floor plane.
			const bounds = new Box3().setFromObject(model);
			const center = bounds.getCenter(new Vector3());
			model.position.set(-center.x, -bounds.min.y, -center.z);
			return model;
		} catch (err) {
			console.warn('Model load failed, using procedural scene:', err);
			return this.makeProceduralScene();
		}
	}

	private makeProceduralScene(): Object3D {
		const group = new Group();

		const knot = new Mesh(
			new TorusKnotGeometry(0.35, 0.12, 220, 40),
			new MeshPhysicalMaterial({ color: 0xb01030, roughness: 0.25, clearcoat: 1 }),
		);
		knot.position.set(0, 0.55, 0);

		const metal = new Mesh(
			new SphereGeometry(0.35, 64, 32),
			new MeshPhysicalMaterial({ color: 0xe8e8e8, metalness: 1, roughness: 0.05 }),
		);
		metal.position.set(-1, 0.35, 0.3);

		const glass = new Mesh(
			new SphereGeometry(0.35, 64, 32),
			new MeshPhysicalMaterial({
				transmission: 1,
				roughness: 0,
				ior: 1.5,
				thickness: 0.7,
			}),
		);
		glass.position.set(1, 0.35, 0.3);

		group.add(knot, metal, glass);
		return group;
	}

	/** 2 x 1 m table: top + four legs grouped so they move as one. */
	private makeTable(): Object3D {
		const mat = new MeshPhysicalMaterial({ color: 0x8a6a48, roughness: 0.6 });
		const table = new Group();
		const top = new Mesh(new BoxGeometry(2, 0.05, 1), mat);
		top.position.y = 0.725;
		table.add(top);
		for (const [x, z] of [[-0.9, -0.4], [0.9, -0.4], [-0.9, 0.4], [0.9, 0.4]]) {
			const leg = new Mesh(new BoxGeometry(0.06, 0.7, 0.06), mat);
			leg.position.set(x, 0.35, z);
			table.add(leg);
		}
		return table;
	}

	private makeCube(): Object3D {
		const cube = new Mesh(
			new BoxGeometry(0.1, 0.1, 0.1),
			new MeshPhysicalMaterial({ color: 0xb01818, roughness: 0.4 }),
		);
		cube.position.set(-0.3, 0.8, 0);
		return cube;
	}

	private makeBall(): Object3D {
		const ball = new Mesh(
			new SphereGeometry(0.05, 48, 24),
			new MeshPhysicalMaterial({ color: 0xc8c8c8, roughness: 0.3 }),
		);
		ball.position.set(0.25, 0.8, 0.12);
		return ball;
	}

	private builtinFactory(key: string): (() => Object3D) | null {
		switch (key) {
			case 'Table':
				return () => this.makeTable();
			case 'Cube':
				return () => this.makeCube();
			case 'Ball':
				return () => this.makeBall();
			default:
				return null;
		}
	}

	/** Instantiate every library object into the scene, hidden by default. */
	private instantiateLibrary() {
		for (const item of this.library) {
			let obj: Object3D | null = null;
			if (item.kind === 'builtin') {
				obj = this.builtinFactory(item.key)?.() ?? null;
			} else {
				const tmpl = this.importTemplates.get(item.key);
				if (tmpl) obj = this.cloneWithMaterials(tmpl);
			}
			if (!obj) continue;
			obj.visible = false;
			this.registerObject(obj, item.name, item.key);
			this.scene.add(obj);
		}
	}

	/** Clone an object with its own material copies (per-scene edits stay local). */
	private cloneWithMaterials(source: Object3D): Object3D {
		const obj = source.clone();
		obj.traverse((child) => {
			const mesh = child as Mesh;
			if (!mesh.isMesh || !mesh.material) return;
			mesh.material = Array.isArray(mesh.material)
				? mesh.material.map((m) => m.clone())
				: mesh.material.clone();
		});
		return obj;
	}

	/**
	 * The room as real geometry: four walls + ceiling facing inward, and a
	 * ceiling patch just below the ceiling as the only light source — either
	 * an emissive mesh (found only by chance rays → noisy) or a RectAreaLight
	 * (importance-sampled by the path tracer → converges fast, but invisible
	 * to rays, so a dim emissive quad marks the fixture; see FIXTURE_FRACTION).
	 * The floor is added separately in init() (shared with the 'room' variant).
	 * Wall/ceiling colors are the sRGB equivalents of the radiances painted
	 * into the generated environment map, for a like-for-like comparison.
	 */
	private makeRoomShell(useAreaLight: boolean): Object3D {
		const group = new Group();
		const wallMat = new MeshPhysicalMaterial({ color: 0xa0a0a0, roughness: 0.9 });

		const wall = (x: number, z: number, rotY: number) => {
			const mesh = new Mesh(new PlaneGeometry(ROOM_HALF * 2, ROOM_CEIL), wallMat);
			mesh.position.set(x, ROOM_CEIL / 2, z);
			mesh.rotation.y = rotY;
			return mesh;
		};
		group.add(
			wall(0, -ROOM_HALF, 0),
			wall(0, ROOM_HALF, Math.PI),
			wall(ROOM_HALF, 0, -Math.PI / 2),
			wall(-ROOM_HALF, 0, Math.PI / 2),
		);

		const ceiling = new Mesh(
			new PlaneGeometry(ROOM_HALF * 2, ROOM_HALF * 2).rotateX(Math.PI / 2),
			new MeshPhysicalMaterial({ color: 0xb3b3b3, roughness: 0.9 }),
		);
		ceiling.position.y = ROOM_CEIL;
		group.add(ceiling);

		if (useAreaLight) {
			// LTC lookup tables for the rasterized preview frames.
			RectAreaLightUniformsLib.init();
			this.rectLight = new RectAreaLight(
				0xfffdf8,
				PATCH_RADIANCE * (1 - FIXTURE_FRACTION),
				PATCH_HALF_X * 2,
				PATCH_HALF_Z * 2,
			);
			// Below the fixture quad so shadow rays aimed at the light are not
			// occluded by it.
			this.rectLight.position.set(0, ROOM_CEIL - 0.01, 0);
			this.rectLight.lookAt(0, 0, 0);
			group.add(this.rectLight);
		}

		// Shadow-casting stand-in for the lamp, whichever kind it is. Just below
		// the fixture quad, so the quad is behind it and never shadows the room.
		this.roomProxy = makeProxyLight();
		this.roomProxy.position.set(0, ROOM_CEIL - 0.02, 0);
		this.roomProxy.color.set(0xfffdf8);
		group.add(this.roomProxy);

		this.ambientFill = new AmbientLight(0xfffdf8, 0);
		this.ambientFill.visible = false;
		group.add(this.ambientFill);

		// The visible fixture: carries the full lamp output in emissive mode,
		// or a small cosmetic share of it alongside the invisible RectAreaLight.
		this.patchMat = new MeshPhysicalMaterial({
			color: 0x000000,
			emissive: 0xfffdf8, // nearly white, slightly warm
			emissiveIntensity: PATCH_RADIANCE * (useAreaLight ? FIXTURE_FRACTION : 1),
		});
		const patch = new Mesh(
			new PlaneGeometry(PATCH_HALF_X * 2, PATCH_HALF_Z * 2).rotateX(Math.PI / 2),
			this.patchMat,
		);
		patch.position.y = ROOM_CEIL - 0.005;
		group.add(patch);

		// Room surfaces only receive: walls casting into the lamp's wide cone
		// would band the floor at the edges, and the fixture must never cast.
		setShadowFlags(group, false, true);

		return group;
	}

	/**
	 * Build an equirectangular HDR of the room interior by casting a ray per
	 * texel from ROOM_EYE and painting whichever box face it exits through.
	 * The ceiling patch gets a high radiance — it is the scene's light source.
	 */
	private makeRoomEnvironment(): DataTexture {
		const width = 1024;
		const height = 512;
		const data = new Float32Array(width * height * 4);

		const paint = (px: number, r: number, g: number, b: number) => {
			data[px] = r;
			data[px + 1] = g;
			data[px + 2] = b;
			data[px + 3] = 1;
		};

		for (let j = 0; j < height; j++) {
			// three.js equirect convention: v = asin(dir.y)/PI + 0.5.
			const elevation = ((j + 0.5) / height - 0.5) * Math.PI;
			const y = Math.sin(elevation);
			const horiz = Math.cos(elevation);
			for (let i = 0; i < width; i++) {
				const azimuth = ((i + 0.5) / width - 0.5) * 2 * Math.PI;
				const dx = horiz * Math.cos(azimuth);
				const dz = horiz * Math.sin(azimuth);

				// Exit distance of the ray from ROOM_EYE through the room box.
				const tx = dx === 0 ? Infinity : (Math.sign(dx) * ROOM_HALF - ROOM_EYE.x) / dx;
				const tz = dz === 0 ? Infinity : (Math.sign(dz) * ROOM_HALF - ROOM_EYE.z) / dz;
				const ty = y === 0 ? Infinity : ((y > 0 ? ROOM_CEIL : 0) - ROOM_EYE.y) / y;
				const t = Math.min(tx, ty, tz);

				const px = (j * width + i) * 4;
				if (t === ty && y > 0) {
					const hx = ROOM_EYE.x + t * dx;
					const hz = ROOM_EYE.z + t * dz;
					if (Math.abs(hx) <= PATCH_HALF_X && Math.abs(hz) <= PATCH_HALF_Z) {
						paint(px, 40, 39.5, 38.5); // the light: nearly white, slightly warm
					} else {
						paint(px, 0.45, 0.45, 0.45); // ceiling
					}
				} else if (t === ty) {
					paint(px, 0.25, 0.25, 0.25); // floor
				} else {
					paint(px, 0.35, 0.35, 0.35); // walls
				}
			}
		}

		const tex = new DataTexture(data, width, height, RGBAFormat, FloatType);
		tex.colorSpace = LinearSRGBColorSpace;
		tex.magFilter = LinearFilter;
		tex.minFilter = LinearFilter;
		tex.needsUpdate = true;
		return tex;
	}

	private loop = () => {
		if (this.disposed) return;
		this.rafId = requestAnimationFrame(this.loop);

		// During a fixed-size export, exportPNG() drives rendering itself.
		if (this.exporting) return;

		// Shadow maps are static between edits (autoUpdate is off): re-render
		// them on the first frame after anything moved, in either mode — the
		// tracer's interaction frames are rasterized too.
		if (this.shadowsDirty) {
			this.shadowsDirty = false;
			this.renderer.shadowMap.needsUpdate = true;
		}

		if (this.editing) {
			// Scene Editor: a plain, fast raster pass — no path tracing. This is
			// the same rasterization the tracer already shows while interacting,
			// so switching backends is a no-op for the renderer.
			this.controls.update();
			this.renderer.setRenderTarget(null);
			this.renderer.render(this.scene, this.camera);
			if (this.lights.size) {
				// Light markers draw over the scene, depth-tested against it.
				const prevAutoClear = this.renderer.autoClear;
				this.renderer.autoClear = false;
				this.renderer.render(this.markerScene, this.camera);
				this.renderer.autoClear = prevAutoClear;
			}
			this.emit('editing');
			return;
		}

		this.pathTracer.pausePathTracing =
			this.maxSamples > 0 && this.pathTracer.samples >= this.maxSamples;
		this.pathTracer.renderSample();

		if (this.pathTracer.samples < this.lastSamples) {
			this.lastResetAt = performance.now();
			this.hideDenoise();
		}
		this.lastSamples = this.pathTracer.samples;

		this.maybeDenoise();
		this.emit(this.pathTracer.enablePathTracing ? 'pathtracing' : 'raster');
	};

	/**
	 * Denoise on a doubling schedule (4, 8, 16, ... samples) so passes get
	 * rarer as the image converges, plus a final pass when accumulation
	 * pauses at the sample cap. Must be called right after renderSample()
	 * so the drawing buffer is still valid to capture.
	 */
	private maybeDenoise() {
		const unet = this.denoiseEnabled ? this.activeUNet() : null;
		if (!unet || this.denoiseBusy) return;
		if (!this.pathTracer.enablePathTracing) return;
		const samples = Math.floor(this.pathTracer.samples);
		const paused = this.maxSamples > 0 && samples >= this.maxSamples;
		const due =
			samples >= Math.max(4, this.denoisedAtSamples * 2) ||
			(paused && samples > this.denoisedAtSamples);
		if (!due) return;

		const src = this.renderer.domElement;
		const overlay = this.denoiseCanvas;
		if (!overlay || src.width === 0 || src.height === 0) return;

		// The aux buffers only change on camera/scene changes, which all reset
		// accumulation (invalidating the cache via hideDenoise) — so capture
		// once per accumulation cycle and reuse.
		let aux: { albedo: ImageData; normal: ImageData } | null = null;
		if (unet === this.unetAux) {
			try {
				if (
					!this.auxCache ||
					this.auxCache.albedo.width !== src.width ||
					this.auxCache.albedo.height !== src.height
				) {
					this.auxCache = this.captureAuxBuffers(src.width, src.height);
				}
				aux = this.auxCache;
			} catch (err) {
				console.warn('Aux buffer capture failed; falling back to color-only denoising:', err);
				this.auxAvailable = false;
				this.auxCache = null;
				void this.prepareUNet();
				return;
			}
		}

		this.denoiseBusy = true;
		this.denoiseState = 'denoising';

		this.captureCanvas.width = src.width;
		this.captureCanvas.height = src.height;
		const cctx = this.captureCanvas.getContext('2d', { willReadFrequently: true })!;
		cctx.drawImage(src, 0, 0);
		const image = cctx.getImageData(0, 0, src.width, src.height);

		if (overlay.width !== src.width || overlay.height !== src.height) {
			overlay.width = src.width;
			overlay.height = src.height;
		}
		const octx = overlay.getContext('2d')!;

		this.abortDenoise = unet.tileExecute({
			color: image,
			...(aux ? { albedo: aux.albedo, normal: aux.normal } : {}),
			progress: (_out, tileData, tile) => {
				if (tileData) octx.putImageData(tileData, tile.x, tile.y);
				overlay.style.opacity = '1';
			},
			done: () => {
				this.abortDenoise = null;
				this.denoiseBusy = false;
				this.denoisedAtSamples = samples;
				this.denoiseState = 'denoised';
			},
		});
	}

	/** Abort any in-flight pass and drop back to the live (noisy) render. */
	private hideDenoise() {
		this.abortDenoise?.();
		this.abortDenoise = null;
		this.denoiseBusy = false;
		this.denoisedAtSamples = 0;
		this.auxCache = null;
		if (this.denoiseCanvas) this.denoiseCanvas.style.opacity = '0';
		if (this.denoiseState === 'denoising' || this.denoiseState === 'denoised') {
			this.denoiseState = 'ready';
		}
	}

	async setDenoiseEnabled(enabled: boolean) {
		this.denoiseEnabled = enabled;
		if (!enabled) {
			this.hideDenoise();
			this.denoiseState = 'off';
			return;
		}
		if (!('gpu' in navigator)) {
			this.denoiseState = 'unsupported';
			return;
		}
		await this.prepareUNet();
	}

	setDenoiseAuxEnabled(enabled: boolean) {
		if (this.auxEnabled === enabled) return;
		this.auxEnabled = enabled;
		this.auxCache = null;
		if (!this.denoiseEnabled) return;
		// Drop the current overlay and re-denoise with the newly selected net.
		this.hideDenoise();
		void this.prepareUNet();
	}

	/** The net matching the current aux preference, if loaded. */
	private activeUNet(): UNet | null {
		return this.auxEnabled && this.auxAvailable ? this.unetAux : this.unetPlain;
	}

	/** Load (if needed) the net matching the current aux preference. */
	private async prepareUNet() {
		const wantAux = this.auxEnabled && this.auxAvailable;
		if (!this.activeUNet()) this.denoiseState = 'loading';
		let unet = await this.ensureUNet(wantAux);
		if (this.disposed) return;
		// Aux weights failed to load: auxAvailable is now false; fall back.
		if (!unet && wantAux) unet = await this.ensureUNet(false);
		if (this.disposed || !unet) return;
		if (this.denoiseEnabled && (this.denoiseState === 'loading' || this.denoiseState === 'off')) {
			this.denoiseState = 'ready';
		}
	}

	private async ensureUNet(aux: boolean): Promise<UNet | null> {
		const key = aux ? 'aux' : 'plain';
		if (!this.unetPromises[key]) {
			// Lazy: oidn-web pulls in tfjs, so only load it on first use.
			const weightsUrl = aux ? this.ldrAuxWeightsUrl : this.ldrWeightsUrl;
			this.unetPromises[key] = import('oidn-web').then(({ initUNetFromURL }) =>
				initUNetFromURL(weightsUrl, undefined, aux ? { aux: true } : undefined),
			);
		}
		try {
			const unet = await this.unetPromises[key]!;
			if (this.disposed) return null;
			if (aux) this.unetAux = unet;
			else this.unetPlain = unet;
			return unet;
		} catch (err) {
			this.unetPromises[key] = null;
			if (aux) {
				console.warn('Aux denoiser weights failed to load; falling back to color-only:', err);
				this.auxAvailable = false;
				return null;
			}
			console.error('Denoiser failed to initialize:', err);
			if (this.denoiseEnabled) this.denoiseState = 'error';
			return null;
		}
	}

	/**
	 * Render noise-free albedo and normal passes of the current view — the
	 * denoiser's auxiliary inputs. They act as an edge map: the net sees where
	 * real material/geometry boundaries are even when the color input is pure
	 * noise. Albedo = per-mesh unlit base color (background white, per OIDN
	 * convention); normal = packed view-space normals from MeshNormalMaterial,
	 * whose 0.5*n+0.5 encoding is exactly what oidn-web expects (background =
	 * packed zero normal, 0x808080).
	 */
	private captureAuxBuffers(width: number, height: number): { albedo: ImageData; normal: ImageData } {
		const renderer = this.renderer;
		const prevToneMapping = renderer.toneMapping;
		const prevBackground = this.scene.background;
		const prevAutoClear = renderer.autoClear;
		const prevClearColor = renderer.getClearColor(new Color());
		const prevClearAlpha = renderer.getClearAlpha();
		// The path tracer renders in tiles and leaves scissor test enabled,
		// clipped to the last tile. Left on, it would clip both the clear and
		// the render of these aux passes to that tile, leaving the rest of the
		// buffer at the clear color (the bug that blanked part of the export).
		const prevScissorTest = renderer.getScissorTest();

		renderer.toneMapping = NoToneMapping;
		this.scene.background = null;
		renderer.autoClear = true;
		renderer.setScissorTest(false);

		// Render targets draw in linear working space regardless of the
		// renderer's output color space; an SRGB texture makes the GPU encode
		// on write so the readback matches the sRGB color capture. Normals
		// stay linear — their packing must not be gamma-encoded.
		const albedoRT = new WebGLRenderTarget(width, height);
		albedoRT.texture.colorSpace = SRGBColorSpace;
		const normalRT = new WebGLRenderTarget(width, height);

		try {
			// Albedo: swap every mesh's material for an unlit mirror of its base
			// color/map. (scene.overrideMaterial can't carry per-object colors.)
			const swapped: [Mesh, Material | Material[]][] = [];
			this.scene.traverse((obj) => {
				const mesh = obj as Mesh;
				if (!mesh.isMesh) return;
				const source = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
					| MeshPhysicalMaterial
					| MeshBasicMaterial;
				let mirror = this.basicMirrors.get(source);
				if (!mirror) {
					mirror = new MeshBasicMaterial();
					this.basicMirrors.set(source, mirror);
				}
				if (source.color) mirror.color.copy(source.color);
				const map = source.map ?? null;
				if (mirror.map !== map) {
					mirror.map = map;
					mirror.needsUpdate = true;
				}
				swapped.push([mesh, mesh.material]);
				mesh.material = mirror;
			});
			renderer.setClearColor(0xffffff, 1);
			renderer.setRenderTarget(albedoRT);
			renderer.render(this.scene, this.camera);
			for (const [mesh, material] of swapped) mesh.material = material;

			// Normals: a global override works — normals ignore per-object color.
			this.scene.overrideMaterial = this.normalMaterial;
			renderer.setClearColor(0x808080, 1);
			renderer.setRenderTarget(normalRT);
			renderer.render(this.scene, this.camera);
			this.scene.overrideMaterial = null;

			return {
				albedo: this.readTargetPixels(albedoRT, width, height),
				normal: this.readTargetPixels(normalRT, width, height),
			};
		} finally {
			this.scene.overrideMaterial = null;
			renderer.setRenderTarget(null);
			renderer.setClearColor(prevClearColor, prevClearAlpha);
			renderer.toneMapping = prevToneMapping;
			renderer.autoClear = prevAutoClear;
			renderer.setScissorTest(prevScissorTest);
			this.scene.background = prevBackground;
			albedoRT.dispose();
			normalRT.dispose();
		}
	}

	/** Read back a render target, flipping rows (GL is bottom-up, ImageData top-down). */
	private readTargetPixels(rt: WebGLRenderTarget, width: number, height: number): ImageData {
		const buf = new Uint8Array(width * height * 4);
		this.renderer.readRenderTargetPixels(rt, 0, 0, width, height, buf);
		const flipped = new Uint8ClampedArray(width * height * 4);
		const row = width * 4;
		for (let y = 0; y < height; y++) {
			flipped.set(buf.subarray((height - 1 - y) * row, (height - y) * row), y * row);
		}
		return new ImageData(flipped, width, height);
	}

	private emit(mode: RenderMode) {
		this.onStatus?.({
			mode,
			samples: this.ready ? Math.floor(this.pathTracer.samples) : 0,
			elapsedMs: performance.now() - this.lastResetAt,
			denoise: this.denoiseState,
			denoisedAt: this.denoisedAtSamples,
			denoiseAux: this.auxEnabled && this.auxAvailable,
		});
	}

	setPathTracingEnabled(enabled: boolean) {
		this.pathTracer.enablePathTracing = enabled;
		if (!enabled) this.hideDenoise();
		if (enabled && this.ready) this.pathTracer.reset();
	}

	/** Toggle between path-traced render mode and the fast raster edit mode. */
	setEditMode(edit: boolean) {
		if (this.editing === edit) return;
		this.editing = edit;
		// Hand each area lamp's shadow share to its proxy (and take it back).
		// Visibility decides which lights the tracer collects, so this must
		// happen before the sync below.
		this.syncRasterLights();
		this.lightsDirty = true;
		this.shadowsDirty = true;
		if (edit) {
			this.hideDenoise();
		} else if (this.ready) {
			if (this.objectsDirty) {
				// Visibility or geometry changed; rebuild the BVH (setScene skips
				// hidden meshes, refits moved geometry, and resets itself). This
				// also re-reads materials and lights, so those edits are covered too.
				this.objectsDirty = false;
				this.materialsDirty = false;
				this.lightsDirty = false;
				this.pathTracer.setScene(this.scene, this.camera);
			} else {
				if (this.materialsDirty) {
					this.materialsDirty = false;
					this.pathTracer.updateMaterials();
				}
				if (this.lightsDirty) {
					this.lightsDirty = false;
					this.pathTracer.updateLights();
				}
				this.pathTracer.updateCamera();
				this.pathTracer.reset();
			}
			this.lastResetAt = performance.now();
		}
	}

	private registerObject(object3d: Object3D, name: string, key: string = name) {
		setShadowFlags(object3d, true, true);
		const id = `obj-${++this.objectCounter}`;
		this.objects.set(id, { object3d, name, key, included: object3d.visible });
	}

	listObjects(): LabObject[] {
		return [...this.objects.entries()].map(([id, e]) => ({
			id,
			name: e.name,
			included: e.included,
			removable: this.library.find((i) => i.key === e.key)?.kind === 'imported',
		}));
	}

	setObjectIncluded(id: string, included: boolean) {
		const entry = this.objects.get(id);
		if (!entry || entry.included === included) return;
		entry.included = included;
		entry.object3d.visible = included; // instant in the raster edit view
		this.objectsDirty = true;
		this.shadowsDirty = true;
		this.emitObjects();
	}

	setOnObjectsChanged(cb: (objects: LabObject[]) => void) {
		this.objectsChanged = cb;
	}

	private emitObjects() {
		this.objectsChanged?.(this.listObjects());
	}

	getObjectTransform(id: string): LabTransform | null {
		const entry = this.objects.get(id);
		if (!entry) return null;
		const o = entry.object3d;
		return {
			position: [o.position.x, o.position.y, o.position.z],
			rotation: [o.rotation.x * RAD2DEG, o.rotation.y * RAD2DEG, o.rotation.z * RAD2DEG],
			scale: [o.scale.x, o.scale.y, o.scale.z],
		};
	}

	setObjectTransform(id: string, t: LabTransform) {
		const entry = this.objects.get(id);
		if (!entry) return;
		const o = entry.object3d;
		o.position.set(t.position[0], t.position[1], t.position[2]);
		o.rotation.set(t.rotation[0] * DEG2RAD, t.rotation[1] * DEG2RAD, t.rotation[2] * DEG2RAD);
		o.scale.set(t.scale[0], t.scale[1], t.scale[2]);
		// Live in the raster view; the traced BVH refits on return to render.
		this.objectsDirty = true;
		this.shadowsDirty = true;
	}

	/** Every standard/physical material under an object (deduped). */
	private materialsOf(obj: Object3D): MeshStandardMaterial[] {
		const found = new Set<MeshStandardMaterial>();
		obj.traverse((child) => {
			const mesh = child as Mesh;
			if (!mesh.isMesh || !mesh.material) return;
			const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
			for (const m of list) {
				if ((m as MeshStandardMaterial).isMeshStandardMaterial) {
					found.add(m as MeshStandardMaterial);
				}
			}
		});
		return [...found];
	}

	getObjectMaterial(id: string): LabMaterial | null {
		const entry = this.objects.get(id);
		if (!entry) return null;
		const mats = this.materialsOf(entry.object3d);
		if (!mats.length) return null;
		const m = mats[0];
		return {
			color: `#${m.color.getHexString()}`,
			shininess: 1 - m.roughness,
			reflectivity: m.metalness,
			texture: (m.userData.labTexture as LabTexture | undefined) ?? 'none',
		};
	}

	// Lazily-built procedural cloth texture: a woven plaid with contrast at two
	// scales (thick 25 cm bands + thin 6 cm threads on the 2 m table top), so it
	// still reads as texture after aggressive downscaling (world-lab's dense
	// stereo works at ~160 px frames). Per-thread luminance jitter breaks up
	// uniform runs so windowed matchers (ZNCC) get signal everywhere.
	private clothTexture: CanvasTexture | null = null;

	private getClothTexture(): CanvasTexture {
		if (this.clothTexture) return this.clothTexture;
		const S = 512;
		const c = document.createElement('canvas');
		c.width = S;
		c.height = S;
		const ctx = c.getContext('2d')!;
		ctx.fillStyle = '#b4a284';
		ctx.fillRect(0, 0, S, S);
		// Deterministic LCG so renders are reproducible across sessions.
		let seed = 12345;
		const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
		// Thick plaid bands (64 px ≈ 25 cm on the table top).
		ctx.fillStyle = 'rgba(122, 62, 48, 0.75)';
		for (let o = 0; o < S; o += 128) {
			ctx.fillRect(o, 0, 64, S);
			ctx.fillRect(0, o, S, 64);
		}
		// Thin threads (16 px ≈ 6 cm) with jittered luminance.
		for (let o = 0; o < S; o += 16) {
			ctx.fillStyle = `rgba(40, 30, 24, ${0.15 + 0.25 * rand()})`;
			ctx.fillRect(o, 0, 3, S);
			ctx.fillStyle = `rgba(245, 240, 225, ${0.1 + 0.2 * rand()})`;
			ctx.fillRect(0, o + 8, S, 2);
		}
		// Aperiodic mottling. A purely periodic weave gives windowed matchers
		// (ZNCC) multiple cost minima one pattern-period apart — depth estimates
		// lock onto the wrong lobe (seen as satellite peaks in the depth-error
		// histogram when grading against ground truth). Random blotches at mixed
		// scales make every neighborhood unique, so the true match wins.
		for (let k = 0; k < 400; k++) {
			const r = 4 + 28 * rand() * rand();
			const dark = rand() < 0.5;
			ctx.fillStyle = dark
				? `rgba(30, 22, 18, ${0.1 + 0.25 * rand()})`
				: `rgba(250, 244, 228, ${0.1 + 0.22 * rand()})`;
			ctx.beginPath();
			ctx.ellipse(S * rand(), S * rand(), r, r * (0.4 + 0.6 * rand()), Math.PI * rand(), 0, Math.PI * 2);
			ctx.fill();
		}
		const tex = new CanvasTexture(c);
		tex.colorSpace = SRGBColorSpace;
		tex.wrapS = RepeatWrapping;
		tex.wrapT = RepeatWrapping;
		this.clothTexture = tex;
		return tex;
	}

	setObjectMaterial(id: string, mat: LabMaterial) {
		const entry = this.objects.get(id);
		if (!entry) return;
		const texture = mat.texture ?? 'none';
		for (const m of this.materialsOf(entry.object3d)) {
			m.color.set(mat.color);
			m.roughness = 1 - mat.shininess;
			m.metalness = mat.reflectivity;
			// Scalar/color uniforms update without a shader recompile, so no
			// needsUpdate. Live in raster; the tracer re-reads on return.
			const current = (m.userData.labTexture as LabTexture | undefined) ?? 'none';
			if (current !== texture) {
				m.map = texture === 'cloth' ? this.getClothTexture() : null;
				m.userData.labTexture = texture;
				m.needsUpdate = true; // shader recompile (USE_MAP toggled)
				// New/removed maps change the tracer's packed texture set —
				// updateMaterials() isn't enough, force a setScene rebuild.
				this.objectsDirty = true;
			}
		}
		this.materialsDirty = true;
		// In edit mode the rebuild happens on return to render (setEditMode).
		// Applied live in render mode, rebuild now so the tracer repacks maps.
		if (this.objectsDirty && this.ready && !this.editing && !this.buildingScene) {
			this.objectsDirty = false;
			this.materialsDirty = false;
			this.pathTracer.setScene(this.scene, this.camera);
			this.lastResetAt = performance.now();
		}
	}

	listLights(): LabLightEntry[] {
		return [...this.lights].map(([id, e]) => ({ id, ...copyLight(e.data) }));
	}

	getLight(id: string): LabLight | null {
		const entry = this.lights.get(id);
		return entry ? copyLight(entry.data) : null;
	}

	/** Add a light (defaults fill anything unspecified); returns its id. */
	addLight(init: Partial<LabLight> = {}): string {
		const type = init.type ?? 'point';
		const id = this.createLight({
			name: init.name ?? `Light ${this.lights.size + 1}`,
			type,
			color: init.color ?? '#ffffff',
			intensity: init.intensity ?? lightTypeInfo(type).defaultIntensity,
			position: init.position ?? NEW_LIGHT_POSITION,
		});
		this.syncLights();
		this.emitLights();
		return id;
	}

	setLight(id: string, data: LabLight) {
		const entry = this.lights.get(id);
		if (!entry) return;
		if (entry.data.type !== data.type) {
			// Each type is a different three.js class — swap the object, keep the id.
			this.disposeLightObjects(entry);
			const made = this.makeLight(data.type);
			entry.light = made.light;
			entry.proxy = made.proxy;
			this.addLightObjects(entry);
		}
		entry.data = copyLight(data);
		this.applyLightData(entry);
		this.syncLights();
		this.emitLights();
	}

	removeLight(id: string) {
		const entry = this.lights.get(id);
		if (!entry) return;
		this.disposeLight(entry);
		this.lights.delete(id);
		this.syncLights();
		this.emitLights();
	}

	setOnLightsChanged(cb: (lights: LabLightEntry[]) => void) {
		this.lightsChanged = cb;
	}

	private emitLights() {
		this.lightsChanged?.(this.listLights());
	}

	/** Build a light and its marker from data. Scene-graph only — no tracer sync. */
	private createLight(data: LabLight): string {
		const id = `light-${++this.lightCounter}`;
		const made = this.makeLight(data.type);
		const entry = {
			...made,
			marker: new Mesh(
				new SphereGeometry(LIGHT_MARKER_RADIUS, 16, 8),
				new MeshBasicMaterial(),
			),
			data: copyLight(data),
		};
		this.addLightObjects(entry);
		this.markerScene.add(entry.marker);
		// Registered before applying: syncRasterLights walks the map, so a light
		// added while editing would otherwise keep a dark, hidden proxy.
		this.lights.set(id, entry);
		this.applyLightData(entry);
		return id;
	}

	/** The light, plus a shadow-casting proxy for the kinds that need one. */
	private makeLight(type: LabLightType): { light: Light; proxy: SpotLight | null } {
		switch (type) {
			case 'spot': {
				// 45° cone with a soft edge. Its default target sits at the origin.
				const spot = new SpotLight(0xffffff, 1, 0, Math.PI / 4, 0.2);
				this.enableShadow(spot);
				return { light: spot, proxy: null };
			}
			case 'area':
				// LTC lookup tables for the rasterized preview frames.
				RectAreaLightUniformsLib.init();
				return {
					light: new RectAreaLight(0xffffff, 1, AREA_LIGHT_SIZE, AREA_LIGHT_SIZE),
					proxy: makeProxyLight(),
				};
			default: {
				const point = new PointLight();
				this.enableShadow(point);
				return { light: point, proxy: null };
			}
		}
	}

	/** Shadow settings for a light that casts its own (point/spot). */
	private enableShadow(light: PointLight | SpotLight) {
		light.castShadow = true;
		light.shadow.mapSize.set(1024, 1024);
		light.shadow.camera.near = 0.1;
		light.shadow.camera.far = 2 * ROOM_CEIL;
		light.shadow.bias = -0.0005;
		light.shadow.normalBias = 0.02;
	}

	private addLightObjects(entry: { light: Light; proxy: SpotLight | null }) {
		const group = this.ensureLightsGroup();
		group.add(entry.light);
		if (entry.proxy) group.add(entry.proxy);
	}

	private disposeLightObjects(entry: { light: Light; proxy: SpotLight | null }) {
		entry.light.removeFromParent();
		entry.light.dispose();
		entry.proxy?.removeFromParent();
		entry.proxy?.dispose();
	}

	private applyLightData(entry: {
		light: Light;
		proxy: SpotLight | null;
		marker: Mesh;
		data: LabLight;
	}) {
		const { light, proxy, marker, data } = entry;
		light.name = data.name;
		light.color.set(data.color);
		light.intensity = data.intensity;
		light.position.set(...data.position);
		// A rect light has no target; it emits along its -Z, so face the origin.
		if ((light as RectAreaLight).isRectAreaLight) light.lookAt(0, 0, 0);
		// The tracer packs lights from matrixWorld, which may not have been
		// refreshed by a render yet when it syncs immediately (render mode).
		light.updateMatrixWorld();
		if (proxy) {
			proxy.position.copy(light.position);
			proxy.color.set(data.color);
			proxy.updateMatrixWorld();
		}
		marker.position.set(...data.position);
		(marker.material as MeshBasicMaterial).color.set(data.color);
		this.syncRasterLights();
		this.shadowsDirty = true;
	}

	/**
	 * Move each area lamp's shadow-casting share to its proxy while editing,
	 * and give it all back on return to Render. The proxy is hidden there,
	 * which also keeps it out of the tracer (it collects only visible lights).
	 */
	private syncRasterLights() {
		const edit = this.editing;
		for (const { light, proxy, data } of this.lights.values()) {
			if (!proxy) continue;
			proxy.visible = edit;
			light.intensity = data.intensity * (edit ? 1 - PROXY_SHARE : 1);
			// Radiance (nits) over the emitting area ≈ the spot's candela.
			proxy.intensity = data.intensity * AREA_LIGHT_AREA * PROXY_SHARE;
		}
		if (this.roomProxy) this.roomProxy.visible = edit;
		if (this.ambientFill) this.ambientFill.visible = edit;
		// Re-splits the room lamp between its real light and its proxy.
		this.setEnvironmentIntensity(this.envIntensity);
	}

	private ensureLightsGroup(): Group {
		if (!this.lightsGroup) {
			this.lightsGroup = new Group();
			this.lightsGroup.name = 'Lights';
			this.scene.add(this.lightsGroup);
		}
		return this.lightsGroup;
	}

	private disposeLight(entry: { light: Light; proxy: SpotLight | null; marker: Mesh }) {
		this.disposeLightObjects(entry);
		this.markerScene.remove(entry.marker);
		disposeObject(entry.marker);
		this.shadowsDirty = true;
	}

	/** Light changes reach the tracer now in render mode, or on return from Edit. */
	private syncLights() {
		if (this.ready && !this.editing && !this.buildingScene) {
			this.pathTracer.updateLights();
			this.lastResetAt = performance.now();
		} else {
			this.lightsDirty = true;
		}
	}

	setBounces(bounces: number) {
		this.pathTracer.bounces = bounces;
		if (this.ready) this.pathTracer.reset();
	}

	setRenderScale(scale: number) {
		this.pathTracer.renderScale = scale;
		if (this.ready) this.pathTracer.reset();
	}

	/** 0 means accumulate forever. */
	setMaxSamples(samples: number) {
		this.maxSamples = samples;
	}

	setEnvironmentIntensity(intensity: number) {
		this.envIntensity = intensity;
		// In edit mode (or mid-rebuild) we only update the light objects (the
		// raster view reads them directly); the tracer resyncs afterward.
		const syncTracer = this.ready && !this.editing && !this.buildingScene;
		if (this.patchMat) {
			// The geometric rooms have no environment; the slider scales the lamp
			// (both halves of the split, in the arealight room).
			const radiance = intensity * PATCH_RADIANCE;
			this.patchMat.emissiveIntensity = this.rectLight
				? radiance * FIXTURE_FRACTION
				: radiance;
			// While editing, the proxy carries the shadow-casting share of the
			// lamp — all of it in the emissive room, where the lamp is a mesh
			// that lights the raster preview not at all.
			if (this.roomProxy) {
				this.roomProxy.intensity =
					radiance * PATCH_AREA * (this.rectLight ? PROXY_SHARE : 1);
			}
			if (this.ambientFill) this.ambientFill.intensity = intensity * AMBIENT_FILL;
			if (this.rectLight) {
				this.rectLight.intensity =
					radiance * (1 - FIXTURE_FRACTION) * (this.editing ? 1 - PROXY_SHARE : 1);
				if (syncTracer) this.pathTracer.updateLights();
			}
			if (syncTracer) this.pathTracer.updateMaterials();
		} else {
			this.scene.environmentIntensity = intensity;
			if (syncTracer) this.pathTracer.updateEnvironment();
		}
	}

	/** Swap the room shell / environment, keeping all placed objects. */
	setRoom(kind: RoomKind) {
		if (!this.ready || kind === this.roomKind) return;
		this.hideDenoise();
		this.applyRoom(kind);
		if (this.editing) {
			// Raster shows it live; the traced BVH rebuilds on return to render.
			this.objectsDirty = true;
		} else {
			this.pathTracer.setScene(this.scene, this.camera);
			this.lastResetAt = performance.now();
		}
	}

	getRoom(): RoomKind | null {
		return this.roomKind;
	}

	/**
	 * Build (or rebuild) the room's lighting. 'room' bakes a generated HDR
	 * environment; the geometric rooms add a shell with an emissive patch or a
	 * RectAreaLight. Pure scene-graph mutation — the caller syncs the tracer.
	 */
	private applyRoom(kind: RoomKind) {
		// Tear down whatever the previous room installed.
		if (this.roomShell) {
			this.scene.remove(this.roomShell);
			disposeObject(this.roomShell);
			this.roomShell = null;
		}
		if (this.roomEnvTex) {
			this.roomEnvTex.dispose();
			this.roomEnvTex = null;
		}
		this.scene.environment = null;
		this.scene.background = null;
		this.patchMat = null;
		this.rectLight = null;
		this.roomProxy = null;
		this.ambientFill = null;
		this.shadowsDirty = true;

		if (kind === 'room') {
			const tex = this.makeRoomEnvironment();
			tex.mapping = EquirectangularReflectionMapping;
			this.roomEnvTex = tex;
			this.scene.environment = tex;
			this.scene.background = tex;
		} else {
			this.roomShell = this.makeRoomShell(kind === 'room-arealight');
			this.scene.add(this.roomShell);
		}

		this.roomKind = kind;
		// Re-applies the current light intensity to the freshly built room,
		// split for the current mode.
		this.syncRasterLights();
	}

	/** Capture the current editor scene as saveable data. */
	serializeScene(): SceneData {
		const objects: SceneObjectState[] = [];
		for (const [id, entry] of this.objects) {
			const material = this.getObjectMaterial(id);
			const transform = this.getObjectTransform(id);
			if (!material || !transform) continue;
			const state: SceneObjectState = { key: entry.key, included: entry.included, material, transform };
			const item = this.library.find((i) => i.key === entry.key);
			if (item?.sha256) {
				state.glb = modelFileName(item.name, item.sha256);
				state.sha256 = item.sha256;
			}
			objects.push(state);
		}
		return {
			version: 1,
			room: this.roomKind ?? 'room-arealight',
			objects,
			lights: [...this.lights.values()].map((e) => copyLight(e.data)),
			camera: {
				position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
				target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
			},
		};
	}

	/** Parse each persisted import into a reusable template Object3D. */
	private async loadImports() {
		for (const rec of await listImports()) {
			try {
				const sha256 = await sha256Hex(rec.glb);
				const template = await this.parseGLB(rec.glb);
				this.importTemplates.set(rec.key, template);
				this.library.push({ key: rec.key, name: rec.name, kind: 'imported', sha256 });
			} catch (err) {
				console.warn('Failed to load imported object:', rec.name, err);
			}
		}
	}

	private async parseGLB(buffer: ArrayBuffer): Promise<Object3D> {
		const gltf = await new GLTFLoader().parseAsync(buffer, '');
		const model = gltf.scene;
		// Center on origin, resting on the floor; wrap in a group so the
		// object's own transform starts at identity (clean for the inspector).
		const bounds = new Box3().setFromObject(model);
		const center = bounds.getCenter(new Vector3());
		model.position.set(-center.x, -bounds.min.y, -center.z);
		const group = new Group();
		group.add(model);
		return group;
	}

	/** Import a .glb into the library (persisted) and add it to the scene. */
	async importGLB(buffer: ArrayBuffer, filename: string): Promise<void> {
		const sha256 = await sha256Hex(buffer);
		const template = await this.parseGLB(buffer);
		const key = `import-${Date.now().toString(36)}-${this.importCounter++}`;
		const name = filename.replace(/\.(glb|gltf)$/i, '').trim() || 'Imported';
		// Persist first so a quota failure aborts before we mutate state.
		await saveImport({ key, name, glb: buffer });
		this.importTemplates.set(key, template);
		this.library.push({ key, name, kind: 'imported', sha256 });

		// Add an instance (hidden) so it appears in the list immediately.
		const obj = this.cloneWithMaterials(template);
		obj.visible = false;
		this.registerObject(obj, name, key);
		this.scene.add(obj);
		this.objectsDirty = true;
		this.emitObjects();
	}

	/**
	 * Add a .glb to the library under a key the caller chooses, in memory only.
	 *
	 * For a host rendering a scene exported from another browser: the scene
	 * names each import by that browser's key, so the model has to come back
	 * under the same key for applyScene to find it. Unlike importGLB it never
	 * touches IndexedDB — a host that persisted every model it rendered would
	 * load all of them again on its next init(), and what it renders would
	 * start to depend on what it rendered before.
	 *
	 * Call it before applyScene, which instantiates the library. A key already
	 * in the library is refused rather than replaced: two models under one key
	 * would leave the scene's reference ambiguous.
	 *
	 * Resolves with the bytes' SHA-256 (undefined outside a secure context), so
	 * the caller can confirm it registered the model the scene recorded.
	 */
	async registerImport(key: string, name: string, buffer: ArrayBuffer): Promise<string | undefined> {
		if (this.library.some((i) => i.key === key)) {
			throw new Error(`registerImport: "${key}" is already in the library`);
		}
		const sha256 = await sha256Hex(buffer);
		const template = await this.parseGLB(buffer);
		this.importTemplates.set(key, template);
		this.library.push({ key, name, kind: 'imported', sha256 });

		const obj = this.cloneWithMaterials(template);
		obj.visible = false;
		this.registerObject(obj, name, key);
		this.scene.add(obj);
		this.objectsDirty = true;
		this.emitObjects();
		return sha256;
	}

	/** Remove an imported object from the library (built-ins are permanent). */
	deleteLibraryItem(key: string) {
		const item = this.library.find((i) => i.key === key);
		if (!item || item.kind !== 'imported') return;
		this.library = this.library.filter((i) => i.key !== key);
		const template = this.importTemplates.get(key);
		if (template) {
			disposeObject(template);
			this.importTemplates.delete(key);
		}
		void deleteImport(key).catch((err) => console.warn('Failed to delete import:', err));
		for (const [id, entry] of [...this.objects]) {
			if (entry.key === key) {
				this.scene.remove(entry.object3d);
				disposeObject(entry.object3d);
				this.objects.delete(id);
			}
		}
		this.objectsDirty = true;
		this.emitObjects();
	}

	removeLibraryObject(id: string) {
		const entry = this.objects.get(id);
		if (entry) this.deleteLibraryItem(entry.key);
	}

	/** Replace the whole scene with a saved (or new) editor scene. */
	applyScene(data: SceneData) {
		if (!this.ready) return;
		this.hideDenoise();
		this.buildEditorScene(data);
		this.emitObjects();
		this.emitLights();
		if (this.editing) {
			this.objectsDirty = true;
		} else {
			this.lightsDirty = false;
			this.pathTracer.setScene(this.scene, this.camera);
			this.lastResetAt = performance.now();
		}
	}

	/**
	 * Rebuild the scene from scratch: floor + object library + room + saved
	 * per-object state + lights + camera. Starting from a clean slate means
	 * applyScene works identically no matter what was loaded before (a demo or
	 * another saved scene).
	 */
	private buildEditorScene(data: SceneData) {
		this.buildingScene = true;
		for (const entry of this.lights.values()) this.disposeLight(entry);
		this.lights.clear();
		this.lightCounter = 0;
		this.lightsGroup = null;
		for (const child of [...this.scene.children]) {
			this.scene.remove(child);
			disposeObject(child);
		}
		this.objects.clear();
		this.objectCounter = 0;
		this.roomShell = null;
		this.patchMat = null;
		this.rectLight = null;
		if (this.roomEnvTex) {
			this.roomEnvTex.dispose();
			this.roomEnvTex = null;
		}
		this.roomKind = null;
		this.scene.environment = null;
		this.scene.background = null;

		const floor = new Mesh(
			new PlaneGeometry(ROOM_HALF * 2, ROOM_HALF * 2).rotateX(-Math.PI / 2),
			new MeshPhysicalMaterial({ color: 0x8c8c8c, roughness: 0.85 }),
		);
		floor.name = 'Floor'; // so groundTruthGeometry can attribute its edges
		floor.receiveShadow = true;
		this.scene.add(floor);

		// Instantiate the whole library (built-ins + imports), then apply state.
		this.instantiateLibrary();
		this.applyRoom(data.room);

		for (const [id, entry] of this.objects) {
			const saved = data.objects.find((o) => o.key === entry.key);
			const included = saved?.included ?? false;
			entry.included = included;
			entry.object3d.visible = included;
			if (saved?.material) this.setObjectMaterial(id, saved.material);
			if (saved?.transform) this.setObjectTransform(id, saved.transform);
		}

		for (const light of data.lights ?? []) this.createLight(light);

		if (data.camera) {
			this.camera.position.set(...data.camera.position);
			this.controls.target.set(...data.camera.target);
		}
		this.camera.updateProjectionMatrix();
		this.controls.update();
		this.shadowsDirty = true;
		this.buildingScene = false;
	}

	resize(width: number, height: number) {
		if (width === 0 || height === 0) return;
		this.renderer.setSize(width, height, false);
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
		this.hideDenoise();
		if (this.ready) this.pathTracer.updateCamera();
	}

	/** Current camera position in world space. */
	getCameraPosition(): [number, number, number] {
		return [this.camera.position.x, this.camera.position.y, this.camera.position.z];
	}

	/** Current orbit target — the point the camera looks at. */
	getCameraTarget(): [number, number, number] {
		return [this.controls.target.x, this.controls.target.y, this.controls.target.z];
	}

	/**
	 * Move the camera, keeping the current orbit target as its look-at (so it
	 * repositions without changing what it's aimed at).
	 */
	setCameraPosition(x: number, y: number, z: number) {
		this.camera.position.set(x, y, z);
		this.afterCameraChange();
	}

	/**
	 * Aim the camera at a new point, keeping its position (so it re-orients in
	 * place). Subsequent orbiting rotates around this target.
	 */
	setCameraTarget(x: number, y: number, z: number) {
		this.controls.target.set(x, y, z);
		this.afterCameraChange();
	}

	/** Current vertical field of view, in degrees. */
	getCameraFov(): number {
		return this.camera.fov;
	}

	/** Set the vertical field of view (degrees) — lower zooms in, higher widens. */
	setCameraFov(fov: number) {
		this.camera.fov = fov;
		this.camera.updateProjectionMatrix();
		this.afterCameraChange();
	}

	/**
	 * Sync OrbitControls to a programmatic camera change and restart
	 * accumulation — live in the raster edit view, tracer reset in render mode.
	 */
	private afterCameraChange() {
		this.controls.update();
		this.hideDenoise();
		if (this.ready && !this.editing) {
			this.pathTracer.updateCamera();
			this.pathTracer.reset();
			this.lastResetAt = performance.now();
		}
	}

	/**
	 * Render the scene at a fixed square resolution and download it as a PNG.
	 * Independent of viewport/display: the renderer is temporarily resized to
	 * size×size at pixel-ratio 1 and a square camera, converged to
	 * EXPORT_SAMPLES, captured, then the interactive view is restored.
	 */
	async exportPNG(size: number, filename = 'pt-lab.png', onProgress?: (frac: number) => void) {
		if (!this.ready || this.exporting) return;
		this.exporting = true;
		this.hideDenoise();

		const logical = this.renderer.getSize(new Vector2());
		const prevPixelRatio = this.renderer.getPixelRatio();
		const prevAspect = this.camera.aspect;
		const prevRenderScale = this.pathTracer.renderScale;
		const prevEnabled = this.pathTracer.enablePathTracing;
		const prevPaused = this.pathTracer.pausePathTracing;

		try {
			// If denoising is on, make sure the right UNet is loaded before we
			// converge (so the export waits for it rather than skipping).
			if (this.denoiseEnabled) await this.prepareUNet();
			if (this.disposed) return;
			const unet = this.denoiseEnabled ? this.activeUNet() : null;
			// Render (and denoise) at renderSize, then downscale to the requested
			// size — the denoiser needs at least its tile size to avoid padding
			// artifacts (see DENOISE_MIN_SIZE).
			const renderSize = unet ? Math.max(size, DENOISE_MIN_SIZE) : size;
			const convergeSpan = unet ? 0.85 : 1; // leave headroom for the denoise phase

			this.renderer.setPixelRatio(1);
			this.renderer.setSize(renderSize, renderSize, false);
			this.camera.aspect = 1;
			this.camera.updateProjectionMatrix();
			this.pathTracer.renderScale = 1;
			this.pathTracer.enablePathTracing = true;
			this.pathTracer.pausePathTracing = false;
			this.pathTracer.updateCamera();
			this.pathTracer.reset();

			while (this.pathTracer.samples < EXPORT_SAMPLES && !this.disposed) {
				this.pathTracer.renderSample();
				onProgress?.(convergeSpan * (this.pathTracer.samples / EXPORT_SAMPLES));
				await new Promise(requestAnimationFrame);
			}
			if (this.disposed) return;

			// Redraw and snapshot the color in the SAME tick: the WebGL drawing
			// buffer isn't preserved across composites, so a later frame blanks it.
			this.pathTracer.renderSample();
			this.captureCanvas.width = renderSize;
			this.captureCanvas.height = renderSize;
			const ctx = this.captureCanvas.getContext('2d', { willReadFrequently: true })!;
			ctx.drawImage(this.renderer.domElement, 0, 0);
			let image = ctx.getImageData(0, 0, renderSize, renderSize);

			// Denoise the export using the same UNet / aux choice as the live view.
			if (unet) {
				let aux: { albedo: ImageData; normal: ImageData } | null = null;
				if (unet === this.unetAux) {
					try {
						aux = this.captureAuxBuffers(renderSize, renderSize);
					} catch (err) {
						console.warn('Aux capture failed during export; denoising color-only:', err);
					}
				}
				if (unet !== this.unetAux || aux) {
					image = await new Promise<ImageData>((resolve) => {
						unet.tileExecute({
							color: image,
							...(aux ? { albedo: aux.albedo, normal: aux.normal } : {}),
							progress: (_out, _tile, _rect, i, n) =>
								onProgress?.(0.85 + 0.15 * ((i + 1) / Math.max(1, n))),
							done: (out) => resolve(out),
						});
					});
				}
			}
			onProgress?.(1);

			// Write out at the requested size, downscaling if we rendered larger.
			const out = document.createElement('canvas');
			out.width = size;
			out.height = size;
			const octx = out.getContext('2d')!;
			if (renderSize === size) {
				octx.putImageData(image, 0, 0);
			} else {
				const tmp = document.createElement('canvas');
				tmp.width = renderSize;
				tmp.height = renderSize;
				tmp.getContext('2d')!.putImageData(image, 0, 0);
				octx.imageSmoothingEnabled = true;
				octx.imageSmoothingQuality = 'high';
				octx.drawImage(tmp, 0, 0, size, size);
			}
			// Beauty export: tone-mapped and sRGB-encoded, so declare it as sRGB.
			await this.downloadCanvas(out, filename, true);
		} finally {
			this.renderer.setPixelRatio(prevPixelRatio);
			this.renderer.setSize(logical.x, logical.y, false);
			this.camera.aspect = prevAspect;
			this.camera.updateProjectionMatrix();
			this.pathTracer.renderScale = prevRenderScale;
			this.pathTracer.enablePathTracing = prevEnabled;
			this.pathTracer.pausePathTracing = prevPaused;
			this.pathTracer.updateCamera();
			this.pathTracer.reset();
			this.lastResetAt = performance.now();
			this.exporting = false;
		}
	}

	/**
	 * Render ONLY the target object with the object-space-position material into an
	 * off-screen buffer. RGB = local position normalized to the object's bbox;
	 * alpha = coverage mask (255 on the object, 0 on background). Same encoding
	 * every frame, so a given surface point has identical RGB under any rotation.
	 */
	private capturePositionBuffer(targetId: string, width: number, height: number): ImageData | null {
		const entry = this.objects.get(targetId);
		if (!entry) return null;
		const target = entry.object3d;
		const renderer = this.renderer;

		const prevToneMapping = renderer.toneMapping;
		const prevBackground = this.scene.background;
		const prevAutoClear = renderer.autoClear;
		const prevClearColor = renderer.getClearColor(new Color());
		const prevClearAlpha = renderer.getClearAlpha();
		const prevScissorTest = renderer.getScissorTest();

		// Normalize by the object's local bounding box (single-mesh assumption:
		// all local frames coincide, true for the helmet).
		const box = new Box3();
		target.traverse((o) => {
			const mesh = o as Mesh;
			if (!mesh.isMesh || !mesh.geometry) return;
			if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
			if (mesh.geometry.boundingBox) box.union(mesh.geometry.boundingBox);
		});
		const size = new Vector3();
		box.getSize(size);
		this.positionMaterial.uniforms.uMin.value.copy(box.min);
		this.positionMaterial.uniforms.uInvSize.value.set(
			size.x > 1e-6 ? 1 / size.x : 0,
			size.y > 1e-6 ? 1 / size.y : 0,
			size.z > 1e-6 ? 1 / size.z : 0,
		);

		// Render only the target: hide every other mesh.
		const keep = new Set<Object3D>();
		target.traverse((o) => keep.add(o));
		const hidden: Mesh[] = [];
		this.scene.traverse((o) => {
			const mesh = o as Mesh;
			if (mesh.isMesh && !keep.has(mesh) && mesh.visible) {
				mesh.visible = false;
				hidden.push(mesh);
			}
		});

		const rt = new WebGLRenderTarget(width, height); // 8-bit linear RGBA

		renderer.toneMapping = NoToneMapping;
		this.scene.background = null;
		renderer.autoClear = true;
		renderer.setScissorTest(false);
		try {
			this.scene.overrideMaterial = this.positionMaterial;
			renderer.setClearColor(0x000000, 0); // alpha 0 => background sentinel
			renderer.setRenderTarget(rt);
			renderer.render(this.scene, this.camera);
			this.scene.overrideMaterial = null;
			return this.readTargetPixels(rt, width, height);
		} finally {
			this.scene.overrideMaterial = null;
			renderer.setRenderTarget(null);
			renderer.setClearColor(prevClearColor, prevClearAlpha);
			renderer.toneMapping = prevToneMapping;
			renderer.autoClear = prevAutoClear;
			renderer.setScissorTest(prevScissorTest);
			this.scene.background = prevBackground;
			for (const mesh of hidden) mesh.visible = true;
			rt.dispose();
		}
	}

	/**
	 * Render the WHOLE visible scene with the packed-depth material into an
	 * off-screen buffer. RGB = forward depth (camera-space -z) normalized by
	 * maxDepth and packed 24-bit; alpha = coverage. maxDepth is computed from
	 * the scene bounds as seen from the camera and returned so callers can
	 * embed it in the filename (decode: depth = unpack(rgb) * maxDepth).
	 */
	private captureDepthBuffer(width: number, height: number): { img: ImageData; maxDepth: number } | null {
		const renderer = this.renderer;

		// Farthest possible forward depth: scene bbox corners in camera space.
		const box = new Box3();
		this.scene.traverse((o) => {
			const mesh = o as Mesh;
			if (mesh.isMesh && mesh.visible && mesh.geometry) box.expandByObject(mesh);
		});
		if (box.isEmpty()) return null;
		this.camera.updateMatrixWorld();
		const inv = this.camera.matrixWorldInverse;
		let maxDepth = 0;
		for (let c = 0; c < 8; c++) {
			const corner = new Vector3(
				c & 1 ? box.max.x : box.min.x,
				c & 2 ? box.max.y : box.min.y,
				c & 4 ? box.max.z : box.min.z,
			).applyMatrix4(inv);
			if (-corner.z > maxDepth) maxDepth = -corner.z;
		}
		if (maxDepth <= 0) return null;
		maxDepth *= 1.02; // margin so nothing clamps at the packing limit
		this.depthMaterial.uniforms.uInvMaxDepth.value = 1 / maxDepth;

		const prevToneMapping = renderer.toneMapping;
		const prevBackground = this.scene.background;
		const prevAutoClear = renderer.autoClear;
		const prevClearColor = renderer.getClearColor(new Color());
		const prevClearAlpha = renderer.getClearAlpha();
		const prevScissorTest = renderer.getScissorTest();

		const rt = new WebGLRenderTarget(width, height); // 8-bit linear RGBA

		renderer.toneMapping = NoToneMapping;
		this.scene.background = null;
		renderer.autoClear = true;
		renderer.setScissorTest(false);
		try {
			this.scene.overrideMaterial = this.depthMaterial;
			renderer.setClearColor(0x000000, 0); // alpha 0 => no geometry
			renderer.setRenderTarget(rt);
			renderer.render(this.scene, this.camera);
			this.scene.overrideMaterial = null;
			return { img: this.readTargetPixels(rt, width, height), maxDepth };
		} finally {
			this.scene.overrideMaterial = null;
			renderer.setRenderTarget(null);
			renderer.setClearColor(prevClearColor, prevClearAlpha);
			renderer.toneMapping = prevToneMapping;
			renderer.autoClear = prevAutoClear;
			renderer.setScissorTest(prevScissorTest);
			this.scene.background = prevBackground;
			rt.dispose();
		}
	}

	/**
	 * Export the current view's ground-truth depth pass as a PNG named by the
	 * camera position, pairing it with a beauty export of the same view:
	 * `<base>-x<X>-y<Y>-z<Z>-depth<maxDepth>.png` (positions 2dp, matching the
	 * multi-view filename convention world-lab's Demos 6/7 parse). Raster-only
	 * and instant — no path tracing involved.
	 */
	async exportDepthPass(size: number, baseName = 'view'): Promise<string | null> {
		if (!this.ready || this.exporting) return null;
		const prevAspect = this.camera.aspect;
		try {
			this.camera.aspect = 1; // square export, like exportPNG
			this.camera.updateProjectionMatrix();
			const captured = this.captureDepthBuffer(size, size);
			if (!captured) return null;
			const p = this.camera.position;
			const name =
				`${baseName}-x${p.x.toFixed(2)}-y${p.y.toFixed(2)}-z${p.z.toFixed(2)}` +
				`-depth${captured.maxDepth.toFixed(4)}.png`;
			await this.downloadImageData(captured.img, name);
			return name;
		} finally {
			this.camera.aspect = prevAspect;
			this.camera.updateProjectionMatrix();
		}
	}


	/**
	 * Export the auxiliary passes for the current view, alongside a beauty
	 * render of the same camera.
	 *
	 * These are what let a consumer say WHY an edge is in the picture rather
	 * than only that it is: a depth step is an occlusion, a normal step with no
	 * depth step is a crease, an albedo step with neither is paint. All three
	 * are raster passes, so the whole set costs a frame — nothing here path
	 * traces.
	 *
	 * Written UNTAGGED, like `exportDepthPass`: these carry raw linear code
	 * values, not colour, and an sRGB tag would invite a decoder to apply a
	 * curve that was never there. A reader must be told `from=linear`.
	 *
	 * `maxDepth` is what the depth pass decodes with — `depth = unpack(rgb) *
	 * maxDepth` — and it is returned rather than only baked into a filename,
	 * because parsing a float back out of a name is a thing that breaks.
	 */
	async exportAOVs(
		size: number,
		baseName = 'view',
		which: { depth?: boolean; normal?: boolean; albedo?: boolean } = {},
	): Promise<{ files: string[]; maxDepth: number | null }> {
		if (!this.ready || this.exporting) return { files: [], maxDepth: null };
		const want = { depth: true, normal: true, albedo: true, ...which };
		const prevAspect = this.camera.aspect;
		const files: string[] = [];
		let maxDepth: number | null = null;
		try {
			this.camera.aspect = 1; // square, like exportPNG — the same framing
			this.camera.updateProjectionMatrix();

			if (want.depth) {
				const captured = this.captureDepthBuffer(size, size);
				if (captured) {
					maxDepth = captured.maxDepth;
					const name = `${baseName}-depth.png`;
					await this.downloadImageData(captured.img, name);
					files.push(name);
				}
			}
			if (want.normal || want.albedo) {
				const aux = this.captureAuxBuffers(size, size);
				if (want.normal) {
					const name = `${baseName}-normal.png`;
					await this.downloadImageData(aux.normal, name);
					files.push(name);
				}
				if (want.albedo) {
					const name = `${baseName}-albedo.png`;
					await this.downloadImageData(aux.albedo, name);
					files.push(name);
				}
			}
		} finally {
			this.camera.aspect = prevAspect;
			this.camera.updateProjectionMatrix();
		}
		return { files, maxDepth };
	}

	/**
	 * Where the edges of this view REALLY are, as plain data.
	 *
	 * A feature detector working from the picture can only propose edges. This
	 * returns them: every mesh edge that is a silhouette, a crease or a mesh
	 * boundary, projected into image space, with the fraction of it that is
	 * actually visible taken from the depth pass. Plus the vertices where those
	 * edges meet, which is what a corner detector is trying to find.
	 *
	 * Three limits, all of them worth stating rather than discovering:
	 *
	 *   - **A geometric edge need not be a visible one.** Two faces meeting at
	 *     a crease under flat lighting produce no gradient at all. Absence of a
	 *     detection here is not automatically a miss.
	 *   - **A visible edge need not be geometric.** Texture, shadow boundaries
	 *     and specular terminators are all real image edges and none of them
	 *     are in this list. That is what the albedo and normal passes from
	 *     `exportAOVs` are for.
	 *   - **Visibility is rasterised**, so it is right to about a pixel. See
	 *     `gtVisibleAt`.
	 *
	 * Returns data, never three.js objects — the same boundary every other
	 * public method on this class keeps.
	 */
	groundTruthGeometry(
		size: number,
		opts: { creaseAngle?: number } = {},
	): GroundTruthView | null {
		if (!this.ready) return null;
		const creaseAngle = opts.creaseAngle ?? 20;
		const prevAspect = this.camera.aspect;

		try {
			this.camera.aspect = 1;
			this.camera.updateProjectionMatrix();
			const captured = this.captureDepthBuffer(size, size);
			if (!captured) return null;
			const depth = captured.img.data;
			const maxDepth = captured.maxDepth;

			this.camera.updateMatrixWorld();
			const mwi = this.camera.matrixWorldInverse;
			const projection = this.camera.projectionMatrix;
			const near = this.camera.near;
			const eye = this.camera.position.clone();

			/** World point -> camera space. Forward depth is -z. */
			const toCamera = (p: Vector3) => p.clone().applyMatrix4(mwi);
			/** Camera space -> pixels. Only valid once z >= near. */
			const toImage = (c: Vector3) => {
				const ndc = c.clone().applyMatrix4(projection);
				return { x: (ndc.x * 0.5 + 0.5) * size, y: (1 - (ndc.y * 0.5 + 0.5)) * size };
			};

			/* ---- 1. every edge of every visible mesh, in world space ---- */

			const edgeMap = new Map<string, GtRawEdge>();
			const skipped: string[] = [];
			const labelFor = (root: Object3D): string => {
				for (const [, entry] of this.objects) if (entry.object3d === root) return entry.name;
				if (root === this.roomShell) return 'Room';
				return root.name || 'Scene';
			};
			// A recursive walk rather than scene.traverse: traverse visits hidden
			// subtrees too, and an object excluded from the scene is hidden at its
			// ROOT while its meshes still say visible.
			const walk = (obj: Object3D, name: string) => {
				if (!obj.visible) return;
				const mesh = obj as Mesh;
				if (mesh.isMesh && !collectMeshEdges(mesh, name, edgeMap)) skipped.push(name);
				for (const child of obj.children) walk(child, name);
			};
			for (const root of this.scene.children) walk(root, labelFor(root));

			/* ---- 2. keep the edges that are silhouettes, creases or boundaries ---- */

			interface Kept {
				edge: GroundTruthEdge;
				a: Vector3;
				b: Vector3;
			}
			const kept: Kept[] = [];
			const edges: GroundTruthEdge[] = [];

			for (const raw of edgeMap.values()) {
				let cause: EdgeCause;
				let dihedral: number;
				if (raw.faces.length < 2) {
					cause = 'boundary';
					dihedral = 180;
				} else {
					const [f0, f1] = raw.faces;
					dihedral = (Math.acos(Math.min(1, Math.max(-1, f0.normal.dot(f1.normal)))) * 180) / Math.PI;
					const front0 = f0.normal.dot(f0.centroid.clone().sub(eye)) < 0;
					const front1 = f1.normal.dot(f1.centroid.clone().sub(eye)) < 0;
					const silhouette = front0 !== front1;
					if (!silhouette && dihedral <= creaseAngle) continue;
					// A cube's silhouette edges are creases too. Silhouette is the
					// stronger claim about the IMAGE — one side of it is not the
					// object at all — so it wins the label, and `dihedral` still
					// says the geometry is sharp there.
					cause = silhouette ? 'silhouette' : 'crease';
				}

				const ca = toCamera(raw.a);
				const cb = toCamera(raw.b);
				let za = -ca.z;
				let zb = -cb.z;
				if (za < near && zb < near) continue;
				let clipped = false;
				if (za < near) {
					ca.lerp(cb, (near - za) / (zb - za));
					za = near;
					clipped = true;
				} else if (zb < near) {
					cb.lerp(ca, (near - zb) / (za - zb));
					zb = near;
					clipped = true;
				}

				const ia = toImage(ca);
				const ib = toImage(cb);
				const span = gtClipToFrame(ia.x, ia.y, ib.x, ib.y, size);
				if (!span) continue; // entirely off-frame
				const [t0, t1] = span;
				if (t0 > 0 || t1 < 1) clipped = true;

				const x0 = ia.x + (ib.x - ia.x) * t0;
				const y0 = ia.y + (ib.y - ia.y) * t0;
				const x1 = ia.x + (ib.x - ia.x) * t1;
				const y1 = ia.y + (ib.y - ia.y) * t1;
				// Depth is linear in INVERSE depth across the image, not in depth,
				// so interpolating z directly would be wrong by the perspective.
				const zAt = (t: number) => 1 / ((1 - t) / za + t / zb);

				const length = Math.hypot(x1 - x0, y1 - y0);
				const samples = Math.min(512, Math.max(8, Math.ceil(length) + 1));
				let seen = 0;
				for (let s = 0; s < samples; s++) {
					const u = s / (samples - 1);
					const t = t0 + (t1 - t0) * u;
					if (gtVisibleAt(depth, size, x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, zAt(t), maxDepth)) {
						seen++;
					}
				}

				let angle = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
				angle = ((angle % 180) + 180) % 180;

				const edge: GroundTruthEdge = {
					id: edges.length + 1,
					cause,
					objects: [...raw.objects].sort(),
					x0, y0, x1, y1,
					z0: zAt(t0),
					z1: zAt(t1),
					length,
					angle,
					dihedral,
					visible: seen / samples,
					clipped,
					v0: 0,
					v1: 0,
				};
				edges.push(edge);
				kept.push({ edge, a: raw.a, b: raw.b });
			}

			/* ---- 3. the vertices those edges meet at ---- */

			interface RawVertex {
				p: Vector3;
				incident: { edge: GroundTruthEdge; other: Vector3 }[];
				objects: Set<string>;
			}
			const vertexMap = new Map<string, RawVertex>();
			const register = (p: Vector3, other: Vector3, k: Kept) => {
				const key = gtKey(p);
				let v = vertexMap.get(key);
				if (!v) {
					v = { p: p.clone(), incident: [], objects: new Set() };
					vertexMap.set(key, v);
				}
				v.incident.push({ edge: k.edge, other });
				for (const name of k.edge.objects) v.objects.add(name);
			};
			for (const k of kept) {
				register(k.a, k.b, k);
				register(k.b, k.a, k);
			}

			const vertices: GroundTruthVertex[] = [];
			for (const raw of vertexMap.values()) {
				const cv = toCamera(raw.p);
				const z = -cv.z;
				if (z < near) continue; // behind the camera: no image position to report
				const here = toImage(cv);

				// Direction of each incident edge as it LEAVES this vertex, in the
				// image. Near-clipped so a far endpoint behind the camera still
				// gives a usable direction.
				const directions: [number, number][] = [];
				for (const inc of raw.incident) {
					const co = toCamera(inc.other);
					let zo = -co.z;
					if (zo < near) {
						co.lerp(cv, (near - zo) / (z - zo));
						zo = near;
					}
					const there = toImage(co);
					const dx = there.x - here.x;
					const dy = there.y - here.y;
					if (Math.hypot(dx, dy) > 1e-9) directions.push([dx, dy]);
				}
				let widest = 0;
				for (let i = 0; i < directions.length; i++) {
					for (let j = i + 1; j < directions.length; j++) {
						const a = gtLineAngle(directions[i][0], directions[i][1], directions[j][0], directions[j][1]);
						if (a > widest) widest = a;
					}
				}

				const onFrame = here.x >= 0 && here.y >= 0 && here.x < size && here.y < size;
				const id = vertices.length + 1;
				for (const inc of raw.incident) {
					// An edge runs between two vertices; whichever end this is, take
					// the slot still unfilled.
					if (inc.edge.v0 === 0) inc.edge.v0 = id;
					else inc.edge.v1 = id;
				}
				vertices.push({
					id,
					x: here.x,
					y: here.y,
					z,
					degree: raw.incident.length,
					visibleDegree: raw.incident.filter((i) => i.edge.visible > 0).length,
					onFrame,
					visible: onFrame && gtVisibleAt(depth, size, here.x, here.y, z, maxDepth),
					angle: widest,
					objects: [...raw.objects].sort(),
				});
			}

			return {
				size,
				camera: {
					position: this.camera.position.toArray() as [number, number, number],
					target: this.controls.target.toArray() as [number, number, number],
					fov: this.camera.fov,
					aspect: 1,
				},
				creaseAngle,
				maxDepth,
				edges,
				vertices,
				skipped: [...new Set(skipped)],
			};
		} finally {
			this.camera.aspect = prevAspect;
			this.camera.updateProjectionMatrix();
		}
	}

	/**
	 * Write ImageData out as a PNG download. `gammaEncoded` declares the pixels
	 * as sRGB (adds the sRGB/gAMA/cHRM chunks) — true for beauty renders, false
	 * for the depth/position passes, whose raw linear values aren't color.
	 */
	private async downloadImageData(
		img: ImageData,
		filename: string,
		gammaEncoded = false,
	): Promise<void> {
		const c = document.createElement('canvas');
		c.width = img.width;
		c.height = img.height;
		c.getContext('2d')!.putImageData(img, 0, 0);
		await this.downloadCanvas(c, filename, gammaEncoded);
	}

	private async downloadCanvas(
		c: HTMLCanvasElement,
		filename: string,
		gammaEncoded: boolean,
	): Promise<void> {
		const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve));
		if (!blob) return;
		const tagged = gammaEncoded ? await tagSRGB(blob) : blob;
		const url = URL.createObjectURL(tagged);
		const a = document.createElement('a');
		a.href = url;
		a.download = filename;
		a.click();
		URL.revokeObjectURL(url);
	}

	/**
	 * Export a rotation series of the target object: for each angle, rotate,
	 * path-trace the beauty image, and also capture the object-space-position
	 * pass. Downloads `<base>-ryNNN.png` (beauty) and `<base>-ryNNN-pos.png`
	 * (position/mask) per angle. For generating feature-response datasets.
	 */
	async exportRotationSeries(
		targetId: string,
		opts: {
			axis?: 'x' | 'y' | 'z';
			from?: number;
			to?: number;
			step?: number;
			size?: number;
			samples?: number;
			baseName?: string;
			onProgress?: (frac: number, label: string) => void;
		} = {},
	): Promise<void> {
		if (!this.ready || this.exporting) return;
		const entry = this.objects.get(targetId);
		if (!entry) return;
		const orig = this.getObjectTransform(targetId);
		if (!orig) return;

		const axis = opts.axis ?? 'y';
		const from = opts.from ?? 0;
		const to = opts.to ?? 90;
		const step = opts.step ?? 15;
		const size = opts.size ?? 512;
		const samples = opts.samples ?? 200;
		const baseName = opts.baseName ?? 'series';
		const axisIdx = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
		const angles: number[] = [];
		for (let a = from; a <= to + 1e-6; a += step) angles.push(a);

		this.exporting = true;
		this.hideDenoise();
		const logical = this.renderer.getSize(new Vector2());
		const prevPixelRatio = this.renderer.getPixelRatio();
		const prevAspect = this.camera.aspect;
		const prevRenderScale = this.pathTracer.renderScale;
		const prevEnabled = this.pathTracer.enablePathTracing;
		const prevPaused = this.pathTracer.pausePathTracing;

		try {
			this.renderer.setPixelRatio(1);
			this.renderer.setSize(size, size, false);
			this.camera.aspect = 1;
			this.camera.updateProjectionMatrix();
			this.pathTracer.renderScale = 1;
			this.pathTracer.enablePathTracing = true;
			this.pathTracer.pausePathTracing = false;

			for (let i = 0; i < angles.length; i++) {
				const a = angles[i];
				const rot: [number, number, number] = [
					orig.rotation[0],
					orig.rotation[1],
					orig.rotation[2],
				];
				rot[axisIdx] = orig.rotation[axisIdx] + a;
				this.setObjectTransform(targetId, { position: orig.position, rotation: rot, scale: orig.scale });
				// Rebuild the BVH so the path-traced beauty reflects the rotation.
				this.pathTracer.setScene(this.scene, this.camera);
				this.pathTracer.updateCamera();
				this.pathTracer.reset();

				const label = `${axis}+${Math.round(a)}° (${i + 1}/${angles.length})`;
				while (this.pathTracer.samples < samples && !this.disposed) {
					this.pathTracer.renderSample();
					opts.onProgress?.((i + this.pathTracer.samples / samples) / angles.length, label);
					await new Promise(requestAnimationFrame);
				}
				if (this.disposed) return;

				// Snapshot beauty in the same tick, then the position pass.
				this.pathTracer.renderSample();
				this.captureCanvas.width = size;
				this.captureCanvas.height = size;
				const ctx = this.captureCanvas.getContext('2d', { willReadFrequently: true })!;
				ctx.drawImage(this.renderer.domElement, 0, 0);
				const color = ctx.getImageData(0, 0, size, size);
				const pos = this.capturePositionBuffer(targetId, size, size);

				const tag = `r${axis}${String(Math.round(a)).padStart(3, '0')}`;
				await this.downloadImageData(color, `${baseName}-${tag}.png`, true);
				if (pos) await this.downloadImageData(pos, `${baseName}-${tag}-pos.png`);
			}
		} finally {
			this.setObjectTransform(targetId, orig);
			this.pathTracer.setScene(this.scene, this.camera);
			this.renderer.setPixelRatio(prevPixelRatio);
			this.renderer.setSize(logical.x, logical.y, false);
			this.camera.aspect = prevAspect;
			this.camera.updateProjectionMatrix();
			this.pathTracer.renderScale = prevRenderScale;
			this.pathTracer.enablePathTracing = prevEnabled;
			this.pathTracer.pausePathTracing = prevPaused;
			this.pathTracer.updateCamera();
			this.pathTracer.reset();
			this.lastResetAt = performance.now();
			this.exporting = false;
		}
	}

	dispose() {
		this.disposed = true;
		cancelAnimationFrame(this.rafId);
		this.abortDenoise?.();
		this.unetPlain?.dispose();
		this.unetAux?.dispose();
		this.normalMaterial.dispose();
		this.controls.dispose();
		this.pathTracer.dispose();
		this.renderer.dispose();
	}
}
