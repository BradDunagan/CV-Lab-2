<script lang="ts">
	import BundleTree from './BundleTree.svelte'; // recurses on itself
	import type { BundleDir, BundleFile } from './bundled';

	let {
		node,
		importedNames,
		onimport,
	}: {
		node: BundleDir;
		importedNames: Set<string>;
		onimport: (file: BundleFile) => void;
	} = $props();
</script>

{#each node.dirs as dir (dir.name)}
	<details class="dir" open>
		<summary>{dir.name}</summary>
		<div class="children">
			<BundleTree node={dir} {importedNames} {onimport} />
		</div>
	</details>
{/each}

{#each node.files as file (file.url)}
	<button
		class="file"
		disabled={importedNames.has(file.name)}
		title={importedNames.has(file.name) ? 'Already in library' : `Import ${file.name}`}
		onclick={() => onimport(file)}
	>
		<span class="mark">{importedNames.has(file.name) ? '✓' : '+'}</span>
		{file.name}
	</button>
{/each}

<style>
	.dir > summary {
		cursor: pointer;
		font-size: 0.78rem;
		color: #bbb;
		padding: 0.2rem 0;
		user-select: none;
	}

	.children {
		padding-left: 0.55rem;
		margin-left: 0.15rem;
		border-left: 1px solid #2a2a33;
	}

	.file {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		width: 100%;
		text-align: left;
		padding: 0.2rem 0.35rem;
		margin: 0.08rem 0;
		border: none;
		border-radius: 4px;
		background: none;
		color: #ccc;
		font-size: 0.8rem;
		cursor: pointer;
	}

	.file:hover:not(:disabled) {
		background: #22222b;
		color: #fff;
	}

	.file:disabled {
		color: #7bbf7b;
		cursor: default;
	}

	.mark {
		width: 0.8rem;
		text-align: center;
		opacity: 0.8;
	}
</style>
