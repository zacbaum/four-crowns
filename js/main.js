/**
 * Four Crowns — entry point.
 * Imports all screen modules, registers the service worker (relative path),
 * and navigates to home.
 */

import { registerScreen, hasScreen, navigate } from './ui/app.js';
import './ui/home.js';        // registers 'home' + 'rules'
import './ui/scorekeeper.js'; // registers 'scorekeeper'
import * as tableMod from './ui/table.js';
import './ui/online.js';
import './ui/stats-ui.js';
import { saveGame } from './stats/store.js';

/**
 * Screen modules self-register via registerScreen(). table.js additionally
 * exports startTable(container, opts) per its contract; if it did not
 * register a 'table' screen itself, bridge navigate('table', params) to
 * startTable here so both integration styles work.
 */
if (!hasScreen('table') && typeof tableMod.startTable === 'function') {
  registerScreen('table', {
    mount(container, params) {
      if (!params || !params.config) {
        // Re-entered via history without live params — nothing to resume.
        navigate('home');
        return;
      }
      tableMod.startTable(container, {
        localSeat: 0,
        onQuit: () => navigate('home'),
        onGameEnd: (state) => {
          try { persistGame(params, state); } catch (e) { console.error('stat save failed', e); }
          navigate('stats');
        },
        ...params,
      });
    },
  });
}

/** Persist a finished table game to the stats store. */
function persistGame(params, state) {
  const adapters = params.adapters || [];
  const ai = adapters.find(a => a && a.kind === 'ai');
  const remote = adapters.some(a => a && a.kind === 'remote');
  saveGame({
    id: crypto.randomUUID(),
    dateISO: new Date().toISOString(),
    kind: ai ? 'ai' : remote ? 'online' : 'ai',
    aiLevel: ai ? ai.level : null,
    hardMode: state.config.mode === 'hard',
    players: state.config.players.map(p => p.name),
    rounds: state.roundResults.map(r => ({
      round: r.round,
      scores: r.scores,
      wentOut: r.wentOut,
    })),
    totals: state.totals,
    winner: state.winner,
    finished: state.phase === 'gameOver',
  });
}

// PWA: register the service worker with a RELATIVE path (subpath deploys).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => {
      console.warn('service worker registration failed', e);
    });
  });
}

navigate('home');
