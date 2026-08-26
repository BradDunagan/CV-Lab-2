import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

/*
 * Collapse paneless's sidebar the first time this app runs.
 *
 * It opens expanded and takes ~315px, which is a lot of a lab window to give
 * to a layout list before anyone has saved a layout. Written through the same
 * localStorage key paneless's own toggle uses, and only when nothing is stored
 * yet — so this is a default, not an override, and the user's choice sticks.
 */
try {
  if (localStorage.getItem('paneless-sidebar-collapsed') === null) {
    localStorage.setItem('paneless-sidebar-collapsed', '1');
  }
} catch { /* private mode, or storage disabled: not worth failing over */ }

mount(App, { target: document.getElementById('app') });
