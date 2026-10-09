<script lang="ts">
	import { untrack } from 'svelte';
	import { LIGHT_TYPES, lightTypeInfo, type LabLight, type LabLightType } from './pathtracer';

	let {
		light,
		onchange,
	}: {
		light: LabLight;
		onchange: (l: LabLight) => void;
	} = $props();

	// Seeded once from the prop; the parent keys this by light id so a new
	// selection remounts and re-seeds it (see TransformPanel for the pattern).
	let name = $state(untrack(() => light.name));
	let type = $state<LabLightType>(untrack(() => light.type));
	let color = $state(untrack(() => light.color));
	let intensity = $state(untrack(() => light.intensity));
	let pos = $state<[number, number, number]>(untrack(() => [...light.position]));

	const info = $derived(lightTypeInfo(type));

	function emit() {
		onchange({ name, type, color, intensity, position: [...pos] });
	}

	const AXES = ['X', 'Y', 'Z'] as const;
</script>

<div class="light">
	<label class="row">
		<span>Name</span>
		<input
			type="text"
			value={name}
			oninput={(e) => {
				name = e.currentTarget.value;
				emit();
			}}
		/>
	</label>

	<label class="row">
		<span>Type</span>
		<select
			value={type}
			onchange={(e) => {
				type = e.currentTarget.value as LabLightType;
				// Units and useful ranges differ per type; start from its default.
				intensity = lightTypeInfo(type).defaultIntensity;
				emit();
			}}
		>
			{#each LIGHT_TYPES as t (t.type)}
				<option value={t.type}>{t.label}</option>
			{/each}
		</select>
	</label>

	<label class="row">
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
		<div class="lbl">Intensity <span>{intensity.toFixed(1)} {info.unit}</span></div>
		<input
			type="range"
			min="0"
			max={info.maxIntensity}
			step={info.maxIntensity / 400}
			value={intensity}
			oninput={(e) => {
				intensity = +e.currentTarget.value;
				emit();
			}}
		/>
	</label>

	<div class="block">
		<div class="block-label">Position (m)</div>
		<div class="axes">
			{#each AXES as ax, i (ax)}
				<label class="axis">
					<span>{ax}</span>
					<input
						type="number"
						step="0.05"
						value={pos[i]}
						oninput={(e) => {
							pos[i] = +e.currentTarget.value;
							emit();
						}}
					/>
				</label>
			{/each}
		</div>
	</div>
</div>

<style>
	.light {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		padding: 0.6rem 0.75rem;
	}

	.row {
		display: flex;
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		font-size: 0.8rem;
		color: #bbb;
	}

	.row input[type='text'],
	.row select {
		flex: 1;
		min-width: 0;
		max-width: 11rem;
		font: inherit;
		font-size: 0.78rem;
		padding: 0.2rem 0.35rem;
		border: 1px solid #3a3a45;
		border-radius: 4px;
		background: #1a1a22;
		color: #eee;
	}

	.row input[type='color'] {
		width: 2.5rem;
		height: 1.5rem;
		padding: 0;
		border: 1px solid #3a3a45;
		border-radius: 4px;
		background: none;
		cursor: pointer;
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

	.block-label {
		font-size: 0.75rem;
		color: #999;
		margin-bottom: 0.3rem;
	}

	.axes {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 0.3rem;
	}

	.axis {
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: 0.25rem;
		font-size: 0.75rem;
		color: #888;
	}

	.axis span {
		width: 0.7rem;
	}

	.axis input {
		width: 100%;
		min-width: 0;
		padding: 0.25rem 0.3rem;
		border: 1px solid #3a3a45;
		border-radius: 4px;
		background: #1a1a22;
		color: #eee;
		font-size: 0.78rem;
		font-variant-numeric: tabular-nums;
	}

	.row input:focus,
	.row select:focus,
	.axis input:focus {
		outline: none;
		border-color: #7c6cf4;
	}
</style>
