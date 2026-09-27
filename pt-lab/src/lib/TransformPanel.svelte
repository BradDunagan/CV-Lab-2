<script lang="ts">
	import { untrack } from 'svelte';
	import type { LabTransform } from './pathtracer';

	let {
		transform,
		onchange,
	}: {
		transform: LabTransform;
		onchange: (t: LabTransform) => void;
	} = $props();

	// Local editable copy, seeded once from the prop. The parent keys this
	// component by object id, so selecting a different object remounts it and
	// re-seeds from that object's current transform. untrack makes the
	// intentional one-time read explicit (no reactive tie-back to the prop).
	let pos = $state<[number, number, number]>(untrack(() => [...transform.position]));
	let rot = $state<[number, number, number]>(untrack(() => [...transform.rotation]));
	let scl = $state<[number, number, number]>(untrack(() => [...transform.scale]));

	function emit() {
		onchange({ position: [...pos], rotation: [...rot], scale: [...scl] });
	}

	const AXES = ['X', 'Y', 'Z'] as const;
</script>

{#snippet block(label: string, vec: number[], step: number, min: number | undefined)}
	<div class="block">
		<div class="block-label">{label}</div>
		<div class="row">
			{#each AXES as ax, i (ax)}
				<label class="axis">
					<span>{ax}</span>
					<input
						type="number"
						{step}
						{min}
						value={vec[i]}
						oninput={(e) => {
							vec[i] = +e.currentTarget.value;
							emit();
						}}
					/>
				</label>
			{/each}
		</div>
	</div>
{/snippet}

<div class="xform">
	{@render block('Position (m)', pos, 0.05, undefined)}
	{@render block('Rotation (°)', rot, 5, undefined)}
	{@render block('Scale', scl, 0.05, 0.05)}
</div>

<style>
	.xform {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		padding: 0.6rem 0.75rem;
	}

	.block-label {
		font-size: 0.75rem;
		color: #999;
		margin-bottom: 0.3rem;
	}

	.row {
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

	.axis input:focus {
		outline: none;
		border-color: #7c6cf4;
	}
</style>
