/**
 * The scene editor's page: pt-lab's editor, mounted in a view the main process
 * lays over the Scene Editor frame. See Editor.svelte.
 */
import { mount } from 'svelte';
import Editor from './Editor.svelte';

mount(Editor, { target: document.getElementById('app') });
