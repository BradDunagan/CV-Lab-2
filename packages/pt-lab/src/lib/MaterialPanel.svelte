<script lang="ts">
	import { untrack } from 'svelte';
	import type { LabMaterial, LabTexture } from './pathtracer';

	let {
		material,
		onchange,
	}: {
		material: LabMaterial;
		onchange: (m: LabMaterial) => void;
	} = $props();

	// Seeded once from the prop; the parent keys this by object id so a new
	// selection remounts and re-seeds it (see TransformPanel for the pattern).
	let color = $state(untrack(() => material.color));
	let shininess = $state(untrack(() => material.shininess));
	let reflectivity = $state(untrack(() => material.reflectivity));
	let texture = $state<LabTexture>(untrack(() => material.texture ?? 'none'));

	function emit() {
		onchange({ color, shininess, reflectivity, texture });
	}
</script>

<div class="mat">
	<label class="color-row">
		<span>Color</span>
		<input
			type="color"
			value={color}
			oninput={(e) => {
				color = e.currentTarget.value;
				emit();
			}}
		/>
	</label>

	<label class="slider">
		<div class="lbl">Shininess <span>{shininess.toFixed(2)}</span></div>
		<input
			type="range"
			min="0"
			max="1"
			step="0.01"
			value={shininess}
			oninput={(e) => {
				shininess = +e.currentTarget.value;
				emit();
			}}
		/>
	</label>

	<label class="tex-row">
		<span>Texture</span>
		<select
			value={texture}
			onchange={(e) => {
				texture = e.currentTarget.value as LabTexture;
				emit();
			}}
		>
			<option value="none">None</option>
			<option value="cloth">Cloth (plaid)</option>
		</select>
	</label>

	<label class="slider">
		<div class="lbl">Reflectivity <span>{reflectivity.toFixed(2)}</span></div>
		<input
			type="range"
			min="0"
			max="1"
			step="0.01"
			value={reflectivity}
			oninput={(e) => {
				reflectivity = +e.currentTarget.value;
				emit();
			}}
		/>
	</label>
</div>

<style>
	.mat {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		padding: 0.6rem 0.75rem;
	}

	.color-row {
		display: flex;
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
		font-size: 0.8rem;
		color: #bbb;
	}

	.color-row input {
		width: 2.5rem;
		height: 1.5rem;
		padding: 0;
		border: 1px solid #3a3a45;
		border-radius: 4px;
		background: none;
		cursor: pointer;
	}

	.tex-row {
		display: flex;
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
		font-size: 0.8rem;
		color: #bbb;
	}

	.tex-row select {
		font: inherit;
		font-size: 0.75rem;
		padding: 0.15em 0.3em;
		border: 1px solid #3a3a45;
		border-radius: 4px;
		background: #1c1c22;
		color: #eee;
	}

	.slider {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.8rem;
		color: #bbb;
	}

	.lbl {
		display: flex;
		justify-content: space-between;
	}

	.lbl span {
		color: #eee;
		font-variant-numeric: tabular-nums;
	}

	.slider input[type='range'] {
		width: 100%;
		accent-color: #7c6cf4;
	}
</style>
