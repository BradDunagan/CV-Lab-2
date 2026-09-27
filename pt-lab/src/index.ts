/**
 * pt-lab — browser GPU path tracing + scene editor.
 *
 * Public entry point. Consumers import from 'pt-lab':
 *   import { PathTracerLab, PathTracerViewer } from 'pt-lab';
 */

// Svelte components
export { default as PathTracerViewer } from './lib/PathTracerViewer.svelte';
export { default as TransformPanel } from './lib/TransformPanel.svelte';
export { default as MaterialPanel } from './lib/MaterialPanel.svelte';
export { default as LightPanel } from './lib/LightPanel.svelte';
export { default as BundleTree } from './lib/BundleTree.svelte';

// Core renderer/editor class + all its data types
export * from './lib/pathtracer';

// Named-scene persistence (localStorage)
export * from './lib/scenes';

// Imported-object persistence (IndexedDB)
export * from './lib/library-store';

// Build-time enumeration of bundled importable objects
export * from './lib/bundled';
