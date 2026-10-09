<script lang="ts">
	import { onMount } from 'svelte';
	import { PathTracerLab, type LabStatus, type LabOptions } from './pathtracer';

	let {
		lab = $bindable(null),
		status = $bindable({
			mode: 'loading',
			samples: 0,
			elapsedMs: 0,
			denoise: 'off',
			denoisedAt: 0,
			denoiseAux: true,
		}),
		options = {},
	}: {
		lab: PathTracerLab | null;
		status: LabStatus;
		/**
		 * Forwarded to the PathTracerLab constructor (e.g. asset URLs). The
		 * viewer always supplies its own onStatus (drives bind:status) and
		 * denoiseCanvas (it owns the overlay), so those two are ignored here.
		 */
		options?: LabOptions;
	} = $props();

	let container: HTMLDivElement;
	let canvas: HTMLCanvasElement;
	let denoiseCanvas: HTMLCanvasElement;

	onMount(() => {
		const instance = new PathTracerLab(canvas, {
			...options,
			onStatus: (s) => (status = s),
			denoiseCanvas,
		});
		instance.resize(container.clientWidth, container.clientHeight);
		instance.init();
		lab = instance;
		// Debug hook for driving the viewer from the console or automation.
		(window as unknown as { __lab?: PathTracerLab }).__lab = instance;

		const observer = new ResizeObserver(() => {
			instance.resize(container.clientWidth, container.clientHeight);
		});
		observer.observe(container);

		return () => {
			observer.disconnect();
			instance.dispose();
			lab = null;
		};
	});
</script>

<div class="viewer" bind:this={container}>
	<canvas bind:this={canvas}></canvas>
	<canvas class="denoise" bind:this={denoiseCanvas}></canvas>
	{#if status.mode === 'loading' || status.mode === 'building-bvh'}
		<div class="overlay">
			{status.mode === 'loading' ? 'Loading assets…' : 'Building BVH…'}
		</div>
	{/if}
</div>

<style>
	.viewer {
		position: relative;
		flex: 1;
		min-width: 0;
		overflow: hidden;
	}

	canvas {
		display: block;
		width: 100%;
		height: 100%;
	}

	canvas.denoise {
		position: absolute;
		inset: 0;
		pointer-events: none;
		opacity: 0;
		transition: opacity 0.25s;
	}

	.overlay {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		background: rgba(10, 10, 14, 0.7);
		color: #ccc;
		font-size: 0.95rem;
		letter-spacing: 0.03em;
	}
</style>
