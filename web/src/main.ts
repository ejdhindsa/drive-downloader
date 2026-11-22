import '@unwreck/core/reset';
import '@unwreck/core/fonts.css';
import '@unwreck/core/css';
import './styles/base.css';

import { mount } from 'svelte';
import App from './App.svelte';

const target = document.getElementById('app');
if (!target) {
  throw new Error('Missing #app mount node');
}

mount(App, { target });
