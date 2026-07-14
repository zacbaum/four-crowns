/**
 * Four Crowns — app shell: tiny hash router + toasts.
 *
 * Contract (ARCHITECTURE.md):
 *   registerScreen(name, { mount })  // mount(container, params)
 *   navigate(name, params = {})      // sets location.hash; params stay in
 *                                    // memory and are NEVER serialized
 *   toast(message)
 *
 * Back/forward works via `hashchange`. Params passed to navigate() are held
 * in memory for the pending navigation; when a screen is re-entered via
 * browser history the last params used for that screen are reused.
 */

const screens = new Map();
const paramsCache = new Map();

/** @type {null | {name: string, params: object}} */
let pending = null;

/** @type {null | (() => void)} cleanup returned by the current screen's mount */
let cleanup = null;

/**
 * Register a screen with the router.
 * @param {string} name
 * @param {{mount: (container: HTMLElement, params: object) => (void | (() => void))}} def
 */
export function registerScreen(name, def) {
  screens.set(name, def);
}

/** @param {string} name @returns {boolean} whether a screen is registered */
export function hasScreen(name) {
  return screens.has(name);
}

/**
 * Navigate to a screen. `params` is an in-memory object (may contain
 * functions, adapters, etc.) and is NOT serialized into the hash.
 * @param {string} name
 * @param {object} [params]
 */
export function navigate(name, params = {}) {
  pending = { name, params };
  const target = '#/' + name;
  if (location.hash === target) {
    handleRoute(); // hashchange won't fire; render directly
  } else {
    location.hash = target;
  }
}

/** Show a transient toast message at the bottom of the screen. */
export function toast(message) {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = String(message);
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 2400);
}

function screenNameFromHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  return raw || 'home';
}

function handleRoute() {
  const name = screenNameFromHash();
  let params;
  if (pending && pending.name === name) {
    params = pending.params;
  } else {
    params = paramsCache.get(name) || {};
  }
  pending = null;
  render(name, params);
}

function render(name, params) {
  const def = screens.get(name);
  if (!def) {
    // Unknown route: fall back to home (guards against stale bookmarks).
    if (name !== 'home' && screens.has('home')) navigate('home');
    return;
  }
  if (typeof cleanup === 'function') {
    try { cleanup(); } catch (e) { console.error('screen cleanup failed', e); }
  }
  cleanup = null;
  paramsCache.set(name, params);

  const root = document.getElementById('app');
  root.replaceChildren();
  root.dataset.screen = name;
  window.scrollTo(0, 0);

  const ret = def.mount(root, params);
  if (typeof ret === 'function') cleanup = ret;
}

window.addEventListener('hashchange', handleRoute);
