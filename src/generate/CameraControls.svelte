<script>
	/**
	 * Camera position and target, as numbers. Ported from pt-lab's demo.
	 *
	 * The demo's FOV slider is left out on purpose: a SceneData records where
	 * the camera is and what it looks at, not its field of view, so a FOV set
	 * here would look saved and not be. The generator frames every shot at
	 * pt-lab's default FOV.
	 */
	let {
		lab,
		// Live values (updated every frame), so orbiting the viewport moves these.
		position,
		target,
	} = $props();

	const AXES = ['X', 'Y', 'Z'];
</script>

{#snippet vec(label, v, apply)}
	<div class="block">
		<div class="block-label">{label}</div>
		<div class="row">
			{#each AXES as ax, i (ax)}
				<label class="axis">
					<span>{ax}</span>
					<input
						type="number"
						step="0.1"
						value={v[i].toFixed(2)}
						onchange={(e) => {
							const a = [...v];
							a[i] = +e.currentTarget.value;
							apply(a[0], a[1], a[2]);
						}}
					/>
				</label>
			{/each}
		</div>
	</div>
{/snippet}

<div class="camera">
	{@render vec('Position (m)', position, (x, y, z) => lab?.setCameraPosition(x, y, z))}
	{@render vec('Target (m)', target, (x, y, z) => lab?.setCameraTarget(x, y, z))}
</div>

<style>
	.camera {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
		padding: 0.6rem 0.75rem;
	}

	.block-label {
		display: flex;
		justify-content: space-between;
		font-size: 0.75rem;
		color: #999;
		margin-bottom: 0.3rem;
	}

	.block-label span {
		color: #eee;
		font-variant-numeric: tabular-nums;
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
