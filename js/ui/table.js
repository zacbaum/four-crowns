/**
 * Four Crowns — game table screen.
 *
 * Owns the game loop per the "Player adapters" contract (docs/ARCHITECTURE.md):
 *   - 'ai' adapter: chooseAction with a short thinking delay per action;
 *   - 'local' adapter: waits for tap input;
 *   - 'remote' adapter: waits for the registered remote-action handler, and
 *     every locally applied action is reported via onLocalAction.
 *
 * All state transitions go through the engine's applyAction inside try/catch;
 * on error we toast and re-render — the screen never crashes mid-game.
 *
 * Game-loop logic that does not touch the DOM lives in the exported pure
 * helpers (arrangeHand, pileLegality, canAdvanceRound, buildGameRecord,
 * roundLabel, aiThinkDelay) so they are node-testable with the real engine.
 *
 * The AI module is imported lazily (dynamic import) the first time an AI
 * adapter must act, so this module has no hard dependency on js/ai/ai.js.
 */

import { registerScreen, navigate, toast } from './app.js';
import { card as renderCard, handRow } from './cards-render.js';
import { createGame, applyAction, legalActions } from '../engine/game.js';
import { bestArrangement, shapesFor } from '../engine/solver.js';
import { ROUNDS, RANK_NAMES, rank, cardName, cardPoints, mulberry32 } from '../engine/cards.js';
import { saveGame } from '../stats/store.js';

/* ------------------------------------------------------------------ */
/* Pure helpers (no DOM) — exported for node sanity tests              */
/* ------------------------------------------------------------------ */

const MELD_COLORS = ['#e9c46a', '#7ec8a9', '#9ec5ff', '#eaa9dd'];
const GROUP_GAP = 12; // extra px between meld groups / deadwood in the hand row

/**
 * Solver-backed display arrangement of a hand: melds first (each sorted by
 * rank), deadwood on the right sorted by descending point value.
 *
 * During the discard phase the hand transiently holds N+1 cards; for the one
 * size with no valid hard-mode shape (5 cards, round of 4s) we fall back to
 * 'normal' so the display does not degenerate into all-deadwood.
 *
 * @param {number[]} hand
 * @param {number} wildRank
 * @param {'normal'|'hard'} mode
 * @returns {{melds: number[][], deadwood: number[], points: number}}
 */
export function arrangeHand(hand, wildRank, mode) {
  let effMode = mode;
  if (mode === 'hard' && shapesFor(hand.length).length === 0) effMode = 'normal';
  const arr = bestArrangement(hand, wildRank, effMode);
  const melds = arr.melds.map(m => m.slice().sort((a, b) => rank(a) - rank(b) || a - b));
  melds.sort((a, b) => rank(a[0]) - rank(b[0]) || a[0] - b[0]);
  const deadwood = arr.deadwood
    .slice()
    .sort((a, b) => cardPoints(b, wildRank) - cardPoints(a, wildRank) || a - b);
  return { melds, deadwood, points: arr.points };
}

/**
 * Banner text for the current round, e.g. "Round 3 of 10 — 6s".
 * @param {object} state
 * @returns {string}
 */
export function roundLabel(state) {
  if (state.phase === 'gameOver' || state.roundIndex >= ROUNDS.length) return 'Game over';
  return `Round ${state.roundIndex + 1} of ${ROUNDS.length} — ${RANK_NAMES[state.wildRank - 1]}s`;
}

/**
 * Which piles may legally be drawn from right now (mirrors legalActions).
 * @param {object} state
 * @returns {{stock: boolean, discard: boolean}}
 */
export function pileLegality(state) {
  if (state.phase !== 'draw') return { stock: false, discard: false };
  return {
    stock: state.stock.length > 0 || state.discard.length > 1,
    discard: state.discard.length > 0,
  };
}

/**
 * May this device advance past the round summary? In remote games only the
 * device seated at 0 (the host side) sends nextRound; single-device games can
 * always advance.
 * @param {Array<{kind: string}>} adapters
 * @param {0|1} localSeat
 * @returns {boolean}
 */
export function canAdvanceRound(adapters, localSeat) {
  const hasRemote = (adapters || []).some(a => a && a.kind === 'remote');
  return !hasRemote || localSeat === 0;
}

/**
 * Build a stats-store game record (docs/ARCHITECTURE.md storage schema) from
 * the live game state.
 * @param {object} state - engine state
 * @param {Array<{kind: string, level?: string}>} adapters
 * @param {string} id - stable record id (same id per table session, so
 *   repeated saves replace rather than duplicate)
 * @param {boolean} finished
 * @returns {object} record for stats/store.js saveGame
 */
export function buildGameRecord(state, adapters, id, finished) {
  const ai = (adapters || []).find(a => a && a.kind === 'ai') || null;
  return {
    id,
    dateISO: new Date().toISOString(),
    kind: ai ? 'ai' : 'online',
    aiLevel: ai ? ai.level : null,
    hardMode: state.config.mode === 'hard',
    players: state.config.players.map(p => p.name),
    rounds: state.roundResults.map(r => ({
      round: r.round,
      scores: [r.scores[0], r.scores[1]],
      wentOut: r.wentOut,
    })),
    totals: [state.totals[0], state.totals[1]],
    winner: finished ? state.winner : null,
    finished,
  };
}

/**
 * AI "thinking" delay in ms: 600–900 so moves feel alive.
 * @param {() => number} rng
 * @returns {number}
 */
export function aiThinkDelay(rng) {
  return 600 + Math.floor(rng() * 300);
}

/* ------------------------------------------------------------------ */
/* Lazy AI module                                                      */
/* ------------------------------------------------------------------ */

let aiPromise = null;
function loadAI() {
  if (!aiPromise) aiPromise = import('../ai/ai.js');
  return aiPromise;
}

/* ------------------------------------------------------------------ */
/* DOM helpers + injected styles                                       */
/* ------------------------------------------------------------------ */

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function newGameId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'g-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

const TB_CSS = `
#app[data-screen="table"] { background: var(--felt); }

.tb-screen {
  position: relative;
  max-width: 560px;
  margin: 0 auto;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  padding-top: calc(env(safe-area-inset-top, 0px) + 10px);
  padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 12px);
  padding-left: max(12px, env(safe-area-inset-left, 0px));
  padding-right: max(12px, env(safe-area-inset-right, 0px));
  background: var(--felt);
  color: #fff;
}

.tb-topbar { display: flex; align-items: center; gap: 8px; min-height: 44px; }
.tb-topbar .tb-mode {
  flex: 1; text-align: center; font-size: 13px; font-weight: 700;
  letter-spacing: .08em; text-transform: uppercase; color: rgba(255,255,255,.55);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tb-icon-btn {
  width: 40px; height: 40px; flex: 0 0 auto; border: none; border-radius: 50%;
  background: rgba(255,255,255,.14); color: #fff; font-size: 17px; font-weight: 700;
  line-height: 1; display: flex; align-items: center; justify-content: center;
  cursor: pointer; transition: transform .12s ease;
}
.tb-icon-btn:active { transform: scale(.92); }

.tb-zone { padding: 2px 2px; }
.tb-player-line {
  display: flex; align-items: center; gap: 8px;
  font-weight: 700; font-size: 15px; min-height: 26px;
}
.tb-player-line .tb-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tb-total-pill {
  margin-left: auto; flex: 0 0 auto; background: rgba(0,0,0,.28); color: rgba(255,255,255,.92);
  border-radius: 14px; padding: 3px 10px; font-size: 13px; font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.tb-turn-dot {
  width: 9px; height: 9px; flex: 0 0 auto; border-radius: 50%;
  background: var(--gold-soft); box-shadow: 0 0 8px 2px rgba(243,207,88,.65);
  opacity: 0; transition: opacity .25s ease;
}
.tb-zone.tb-active .tb-turn-dot { opacity: 1; animation: tb-breathe 1.8s ease-in-out infinite; }

.tb-opp-fan {
  display: flex; justify-content: center; --card-w: 34px;
  padding: 6px 0 2px; min-height: 50px;
}
.tb-opp-fan .card { box-shadow: 0 1px 2px rgba(0,0,0,.35); }
.tb-opp-fan .card + .card { margin-left: calc(var(--card-w) * -0.62); }

.tb-mid {
  flex: 1; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 10px; padding: 8px 0;
}
.tb-round-banner {
  display: flex; align-items: center; justify-content: center;
  flex-wrap: wrap; gap: 8px; font-weight: 800; font-size: 16px; text-align: center;
}
.tb-wild-chip {
  display: inline-flex; align-items: center; gap: 4px;
  background: linear-gradient(180deg, var(--gold-soft), var(--gold));
  color: #402f00; border-radius: 12px; padding: 2px 10px;
  font-size: 13px; font-weight: 800; letter-spacing: .02em;
  box-shadow: 0 1px 3px rgba(0,0,0,.3);
}
.tb-lastturn {
  background: linear-gradient(180deg, var(--gold-soft), var(--gold)); color: #402f00;
  font-weight: 800; font-size: 14px; border-radius: 14px; padding: 5px 16px;
  text-align: center; box-shadow: 0 2px 8px rgba(0,0,0,.35);
  animation: tb-breathe 1.6s ease-in-out infinite;
}
.tb-status {
  min-height: 21px; font-size: 14px; font-weight: 600;
  color: rgba(255,255,255,.82); text-align: center;
}

.tb-piles { display: flex; gap: 28px; align-items: flex-start; --card-w: 70px; }
.tb-pile {
  position: relative; display: flex; flex-direction: column; align-items: center;
  gap: 6px; background: none; border: none; padding: 0;
  color: rgba(255,255,255,.75); font: inherit; cursor: pointer;
}
.tb-pile:disabled { cursor: default; opacity: 1; }
.tb-pile-label {
  font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
}
.tb-pile-count {
  position: absolute; top: -7px; right: -9px; z-index: 2;
  min-width: 24px; height: 24px; padding: 0 6px; border-radius: 12px;
  background: rgba(0,0,0,.55); color: #fff; font-size: 12px; font-weight: 800;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 1px 3px rgba(0,0,0,.4); font-variant-numeric: tabular-nums;
}
.tb-pile-empty {
  width: var(--card-w); aspect-ratio: 5 / 7;
  border: 2px dashed rgba(255,255,255,.35);
  border-radius: calc(var(--card-w) * .11);
}
.tb-pile.tb-pulse .card, .tb-pile.tb-pulse .tb-pile-empty {
  animation: tb-pulse 1.5s ease-in-out infinite;
}
.tb-pile.tb-drop-ready .card, .tb-pile.tb-drop-ready .tb-pile-empty {
  box-shadow: 0 0 0 3px var(--gold-soft), 0 4px 14px rgba(0,0,0,.4);
}

.tb-me { padding-bottom: 2px; }
.tb-hand-wrap { touch-action: none; padding-bottom: 10px; }
.tb-meldcard::after {
  content: ""; position: absolute; left: 7%; right: 7%; bottom: -6px; height: 4px;
  border-radius: 2px; background: var(--tb-meld-color, var(--gold));
}
.tb-me-bar { display: flex; align-items: center; gap: 10px; margin: 2px 0 8px; min-height: 46px; }
.tb-points-pill {
  background: rgba(0,0,0,.28); color: #fff; border-radius: 16px; padding: 8px 14px;
  font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap;
}
.tb-screen .btn.tb-inline { width: auto; flex: 1; min-height: 46px; }
.tb-screen .btn:disabled, .tb-overlay .btn:disabled { opacity: .45; pointer-events: none; }

.tb-ghost {
  position: fixed; z-index: 600; pointer-events: none;
  transform: translate(-50%, -70%) rotate(4deg); opacity: .92; margin: 0 !important;
}

.tb-overlay {
  position: fixed; inset: 0; z-index: 300; background: rgba(0,0,0,.55);
  display: flex; align-items: center; justify-content: center; padding: 18px;
}
.tb-overlay.tb-opaque { background: rgba(0,0,0,.72); }
.tb-overlay.tb-bottom { align-items: flex-end; padding: 0; }
.tb-modal {
  width: 100%; max-width: 520px; max-height: calc(100dvh - 40px); overflow-y: auto;
  background: var(--surface-1); color: var(--ink-1);
  border-radius: 18px; padding: 18px; box-shadow: var(--shadow-2);
}
.tb-modal h2 { margin: 0 0 4px; font-size: 21px; }
.tb-sub { margin: 0 0 12px; color: var(--ink-muted); font-size: 14px; font-weight: 600; }
.tb-sheet {
  width: 100%; max-width: 560px; margin: 0 auto; max-height: 78dvh; overflow-y: auto;
  background: var(--surface-1); color: var(--ink-1);
  border-radius: 18px 18px 0 0; box-shadow: var(--shadow-2);
  padding: 16px 18px calc(env(safe-area-inset-bottom, 0px) + 18px);
}
.tb-sheet-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.tb-sheet-head h2 { margin: 0; font-size: 19px; }
.tb-sheet .tb-icon-btn, .tb-modal .tb-icon-btn { background: var(--grid); color: var(--ink-1); }
.tb-modal-actions { display: grid; gap: 10px; margin-top: 16px; }
.tb-btn-danger { background: var(--critical); border-color: var(--critical); color: #fff; }

.tb-table-wrap { overflow-x: auto; margin-top: 8px; }
.tb-table {
  width: 100%; border-collapse: collapse;
  font-variant-numeric: tabular-nums; font-size: 15px;
}
.tb-table th {
  font-size: 12px; text-transform: uppercase; letter-spacing: .05em;
  color: var(--ink-muted); text-align: right; padding: 6px 8px;
  border-bottom: 1px solid var(--grid);
  max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tb-table th:first-child { text-align: left; }
.tb-table th.tb-p0 { color: var(--series-1); }
.tb-table th.tb-p1 { color: var(--series-2); }
.tb-table td { padding: 6px 8px; text-align: right; border-bottom: 1px solid var(--grid); }
.tb-table td:first-child { text-align: left; font-weight: 700; color: var(--ink-2); }
.tb-table td.tb-out { color: var(--gold); font-weight: 800; }
.tb-table tfoot td { border-bottom: none; border-top: 2px solid var(--baseline); font-weight: 800; font-size: 17px; }
.tb-table tr.tb-inplay td { color: var(--ink-muted); font-style: italic; font-weight: 400; }
.tb-legend { font-size: 12px; color: var(--ink-muted); margin: 8px 0 0; }

.tb-reveal { padding: 10px 0; border-top: 1px solid var(--grid); }
.tb-reveal:first-of-type { border-top: none; }
.tb-reveal-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
.tb-reveal-head .tb-name {
  font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tb-reveal-head .tb-name.tb-p0 { color: var(--series-1); }
.tb-reveal-head .tb-name.tb-p1 { color: var(--series-2); }
.tb-reveal-head .tb-round-score {
  margin-left: auto; flex: 0 0 auto; font-weight: 800; font-variant-numeric: tabular-nums;
}
.tb-out-chip {
  flex: 0 0 auto; background: linear-gradient(180deg, var(--gold-soft), var(--gold));
  color: #402f00; font-size: 11px; font-weight: 800; border-radius: 10px; padding: 2px 8px;
}
.tb-reveal-cards {
  display: flex; flex-wrap: wrap; gap: 12px 14px; --card-w: 36px; align-items: flex-start;
}
.tb-meld-group {
  display: flex; gap: 3px; padding-bottom: 5px;
  border-bottom: 3px solid var(--tb-meld-color, var(--gold)); border-radius: 2px;
}
.tb-dw-group { display: flex; flex-wrap: wrap; gap: 6px; }
.tb-dw { display: flex; flex-direction: column; align-items: center; gap: 3px; }
.tb-dw .card { box-shadow: 0 0 0 2px var(--critical), 0 1px 3px rgba(0,0,0,.25); }
.tb-dw-pts { font-size: 11px; font-weight: 800; color: var(--critical); }
.tb-none { color: var(--ink-muted); font-size: 13px; font-style: italic; align-self: center; }

.tb-final-crown { text-align: center; font-size: 44px; line-height: 1; margin: 2px 0 6px; color: var(--gold); }
.tb-final-title { text-align: center; font-size: 24px; font-weight: 800; margin: 0 0 2px; }
.tb-final-score {
  text-align: center; font-size: 17px; font-weight: 700; color: var(--ink-2);
  margin: 0 0 6px; font-variant-numeric: tabular-nums;
}

@keyframes tb-pulse {
  0%, 100% { transform: translateY(0); }
  50% {
    transform: translateY(-3px);
    box-shadow: 0 0 0 3px rgba(243,207,88,.75), 0 6px 14px rgba(0,0,0,.4);
  }
}
@keyframes tb-breathe {
  0%, 100% { opacity: 1; }
  50% { opacity: .45; }
}
`;

function injectStyles() {
  if (document.getElementById('tb-style')) return;
  const style = document.createElement('style');
  style.id = 'tb-style';
  style.textContent = TB_CSS;
  document.head.appendChild(style);
}

/* ------------------------------------------------------------------ */
/* startTable                                                          */
/* ------------------------------------------------------------------ */

/**
 * Mount the game screen into container and run a full game.
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {object} opts.config - createGame config
 * @param {Array} opts.adapters - [adapter0, adapter1]; each one of
 *   {kind:'local'} | {kind:'ai', level} |
 *   {kind:'remote', onLocalAction, registerRemoteActionHandler}
 * @param {0|1} [opts.localSeat=0] - which seat is this device
 * @param {(state: object) => void} [opts.onGameEnd] - navigate away after save
 * @param {() => void} [opts.onQuit]
 * @returns {() => void} cleanup (cancels timers/listeners)
 */
export function startTable(container, opts) {
  injectStyles();

  const adapters = opts.adapters || [];
  const mySeat = opts.localSeat === 1 ? 1 : 0;
  const oppSeat = 1 - mySeat;
  const players = opts.config.players;
  const hasRemote = adapters.some(a => a && a.kind === 'remote');
  const onQuit = typeof opts.onQuit === 'function' ? opts.onQuit : () => navigate('home');
  const onGameEnd = typeof opts.onGameEnd === 'function' ? opts.onGameEnd : () => navigate('stats');
  const aiRng = mulberry32(((opts.config.seed | 0) ^ 0x9e3779b9) | 0);

  let state = createGame(opts.config);
  let gameId = newGameId();
  let sel = null;          // selected card id during the local discard phase
  let scoresOpen = false;  // score-sheet bottom drawer
  let quitOpen = false;    // quit confirm dialog
  let saved = false;       // finished game already persisted?
  let disposed = false;
  let suppressClick = false; // swallow the click that follows a drag
  let aiTimer = 0;
  let driveToken = 0;
  let resizeRaf = 0;

  /* ---- adapter wiring ---- */

  for (const a of adapters) {
    if (a && a.kind === 'remote' && typeof a.registerRemoteActionHandler === 'function') {
      a.registerRemoteActionHandler((action) => {
        if (disposed) return;
        apply(action, true);
      });
    }
  }

  function reportLocal(action) {
    for (const a of adapters) {
      if (a && a.kind === 'remote' && typeof a.onLocalAction === 'function') {
        try {
          a.onLocalAction(action);
        } catch (err) {
          console.error('onLocalAction failed', err);
        }
      }
    }
  }

  /* ---- game loop ---- */

  function apply(action, fromRemote = false) {
    try {
      applyAction(state, action);
    } catch (err) {
      console.error('applyAction rejected', action, err);
      toast(err && err.message ? err.message : 'Illegal move');
      render();
      return false;
    }
    if (!fromRemote) reportLocal(action);
    sel = null;
    render();
    drive();
    return true;
  }

  function drive() {
    if (disposed) return;
    clearTimeout(aiTimer);
    if (state.phase !== 'draw' && state.phase !== 'discard') return;
    const a = adapters[state.turn];
    if (!a || a.kind !== 'ai') return; // local waits for taps; remote for its handler
    const token = ++driveToken;
    aiTimer = setTimeout(() => {
      loadAI()
        .then((mod) => {
          if (disposed || token !== driveToken) return;
          let action = null;
          try {
            action = mod.chooseAction(a.level, state, aiRng);
          } catch (err) {
            console.error('AI chooseAction failed', err);
            const legal = legalActions(state);
            action = legal.length ? legal[0] : null; // never stall the game
          }
          if (action) apply(action);
        })
        .catch((err) => {
          console.error('AI module failed to load', err);
          if (!disposed) toast('AI is unavailable');
        });
    }, aiThinkDelay(aiRng));
  }

  /* ---- interaction predicates ---- */

  const seatIsLocal = adapters[mySeat] && adapters[mySeat].kind === 'local';

  function canDrawNow() {
    return seatIsLocal && state.phase === 'draw' && state.turn === mySeat;
  }

  function canDiscardNow() {
    return seatIsLocal && state.phase === 'discard' && state.turn === mySeat;
  }

  function confirmDiscard(id) {
    if (!canDiscardNow()) return;
    if (state.hands[mySeat].indexOf(id) === -1) return;
    apply({ type: 'discard', player: mySeat, card: id });
  }

  function onCardTap(id) {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (!canDiscardNow()) return;
    if (sel === id) {
      confirmDiscard(id);
    } else {
      sel = id;
      render();
    }
  }

  /* ---- persistence ---- */

  function persistFinished() {
    if (saved) return;
    try {
      saveGame(buildGameRecord(state, adapters, gameId, true));
      saved = true;
    } catch (err) {
      console.error('failed to save game', err);
      toast('Could not save the game');
    }
  }

  function doQuit() {
    try {
      if (state.phase === 'gameOver') {
        persistFinished();
      } else {
        saveGame(buildGameRecord(state, adapters, gameId, false));
      }
    } catch (err) {
      console.error('failed to save unfinished game', err);
    }
    onQuit();
  }

  function rematch() {
    state = createGame({ ...opts.config, seed: Math.floor(Math.random() * 2 ** 31) });
    gameId = newGameId();
    saved = false;
    sel = null;
    scoresOpen = false;
    quitOpen = false;
    render();
    drive();
  }

  /* ---- drag-to-discard ---- */

  function attachDrag(cardEl, id) {
    cardEl.addEventListener('pointerdown', (ev) => {
      if (!canDiscardNow()) return;
      if (ev.button !== undefined && ev.button !== 0) return;
      const startX = ev.clientX;
      const startY = ev.clientY;
      let ghost = null;

      const move = (e) => {
        if (!ghost && Math.hypot(e.clientX - startX, e.clientY - startY) > 12) {
          ghost = cardEl.cloneNode(true);
          ghost.classList.remove('selected');
          ghost.classList.add('tb-ghost');
          const r = cardEl.getBoundingClientRect();
          ghost.style.setProperty('--card-w', r.width + 'px');
          ghost.style.width = r.width + 'px';
          document.body.appendChild(ghost);
          const pile = container.querySelector('.tb-pile-discard');
          if (pile) pile.classList.add('tb-drop-ready');
        }
        if (ghost) {
          ghost.style.left = e.clientX + 'px';
          ghost.style.top = e.clientY + 'px';
        }
      };

      const up = (e) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        const wasDrag = !!ghost;
        if (ghost) {
          ghost.remove();
          ghost = null;
        }
        const pile = container.querySelector('.tb-pile-discard');
        if (pile) pile.classList.remove('tb-drop-ready');
        if (!wasDrag) return;
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
        if (e.type === 'pointerup' && pile) {
          const r = pile.getBoundingClientRect();
          if (
            e.clientX >= r.left - 10 && e.clientX <= r.right + 10 &&
            e.clientY >= r.top - 10 && e.clientY <= r.bottom + 10
          ) {
            confirmDiscard(id);
          }
        }
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
  }

  /* ---- render: building blocks ---- */

  function totalPill(seat) {
    return el('span', 'tb-total-pill', 'Total ' + state.totals[seat]);
  }

  function statusText() {
    if (state.phase !== 'draw' && state.phase !== 'discard') return '';
    const cur = state.turn;
    const a = adapters[cur] || {};
    if (cur === mySeat && seatIsLocal) {
      if (state.phase === 'draw') return 'Your turn — draw from a pile';
      return sel == null
        ? 'Select a card to discard'
        : 'Tap again, drag to the pile, or press Discard';
    }
    const name = players[cur].name;
    if (a.kind === 'ai') return `${name} is thinking…`;
    if (a.kind === 'remote') return `Waiting for ${name}…`;
    return `${name}'s turn`;
  }

  function buildPiles() {
    const wrap = el('div', 'tb-piles');
    const leg = pileLegality(state);
    const myDraw = canDrawNow();

    const stockBtn = el('button', 'tb-pile tb-pile-stock');
    stockBtn.type = 'button';
    stockBtn.setAttribute(
      'aria-label',
      `Draw from stock, ${state.stock.length} card${state.stock.length === 1 ? '' : 's'} left`
    );
    if (state.stock.length > 0) {
      stockBtn.appendChild(renderCard(0, { faceDown: true }));
    } else {
      stockBtn.appendChild(el('span', 'tb-pile-empty'));
    }
    stockBtn.appendChild(el('span', 'tb-pile-count', String(state.stock.length)));
    stockBtn.appendChild(el('span', 'tb-pile-label', 'Stock'));
    stockBtn.disabled = !(myDraw && leg.stock);
    if (myDraw && leg.stock) stockBtn.classList.add('tb-pulse');
    stockBtn.addEventListener('click', () => {
      if (canDrawNow() && pileLegality(state).stock) {
        apply({ type: 'draw', player: mySeat, source: 'stock' });
      }
    });
    wrap.appendChild(stockBtn);

    const discBtn = el('button', 'tb-pile tb-pile-discard');
    discBtn.type = 'button';
    const top = state.discard[state.discard.length - 1];
    discBtn.setAttribute(
      'aria-label',
      top === undefined ? 'Discard pile, empty' : `Discard pile, top card ${cardName(top)}`
    );
    if (top === undefined) {
      discBtn.appendChild(el('span', 'tb-pile-empty'));
    } else {
      discBtn.appendChild(renderCard(top, { wildRank: state.wildRank }));
    }
    discBtn.appendChild(el('span', 'tb-pile-label', 'Discard'));
    const canTake = myDraw && leg.discard;
    const canDrop = canDiscardNow() && sel != null;
    discBtn.disabled = !(canTake || canDrop);
    if (canTake) discBtn.classList.add('tb-pulse');
    if (canDrop) discBtn.classList.add('tb-drop-ready');
    discBtn.addEventListener('click', () => {
      if (canDrawNow() && pileLegality(state).discard) {
        apply({ type: 'draw', player: mySeat, source: 'discard' });
      } else if (canDiscardNow() && sel != null) {
        confirmDiscard(sel);
      }
    });
    wrap.appendChild(discBtn);

    return wrap;
  }

  function buildMyHand() {
    const hand = state.hands[mySeat];
    if (sel != null && hand.indexOf(sel) === -1) sel = null;
    const arr = arrangeHand(hand, state.wildRank, state.config.mode);
    const ordered = [];
    const groupOf = new Map(); // card id -> meld index, or -1 for deadwood
    arr.melds.forEach((m, i) => m.forEach((c) => { ordered.push(c); groupOf.set(c, i); }));
    arr.deadwood.forEach((c) => { ordered.push(c); groupOf.set(c, -1); });

    const groups = arr.melds.length + (arr.deadwood.length ? 1 : 0);
    const boundaries = Math.max(0, groups - 1);
    const zoneW = Math.min(container.clientWidth || 390, 560) - 24;
    const interactive = canDiscardNow();

    const row = handRow(ordered, {
      wildRank: state.wildRank,
      selectedId: sel,
      maxWidth: Math.max(160, zoneW - boundaries * GROUP_GAP),
      onTap: interactive ? onCardTap : null,
    });
    row.classList.add('tb-hand');

    const cardEls = row.children;
    for (let i = 0; i < ordered.length; i++) {
      const id = ordered[i];
      const g = groupOf.get(id);
      const cardEl = cardEls[i];
      if (g >= 0) {
        cardEl.classList.add('tb-meldcard');
        cardEl.style.setProperty('--tb-meld-color', MELD_COLORS[g % MELD_COLORS.length]);
      }
      if (i > 0 && g !== groupOf.get(ordered[i - 1])) {
        cardEl.style.marginLeft = `calc(var(--hand-overlap, 8px) + ${GROUP_GAP}px)`;
      }
      if (interactive) attachDrag(cardEl, id);
    }
    return { row, points: arr.points };
  }

  function buildScoreTable(withInPlay) {
    const table = el('table', 'tb-table');
    const thead = el('thead');
    const hr = el('tr');
    hr.appendChild(el('th', null, 'Round'));
    hr.appendChild(el('th', 'tb-p0', players[0].name));
    hr.appendChild(el('th', 'tb-p1', players[1].name));
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const r of state.roundResults) {
      const tr = el('tr');
      tr.appendChild(el('td', null, `${RANK_NAMES[r.wildRank - 1]}s`));
      for (const p of [0, 1]) {
        const td = el('td', null, String(r.scores[p]) + (r.wentOut === p ? ' ★' : ''));
        if (r.wentOut === p) td.classList.add('tb-out');
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    if (withInPlay && (state.phase === 'draw' || state.phase === 'discard')) {
      const tr = el('tr', 'tb-inplay');
      tr.appendChild(el('td', null, `${RANK_NAMES[state.wildRank - 1]}s (in play)`));
      tr.appendChild(el('td', null, '—'));
      tr.appendChild(el('td', null, '—'));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    const tfoot = el('tfoot');
    const tr = el('tr');
    tr.appendChild(el('td', null, 'Total'));
    tr.appendChild(el('td', null, String(state.totals[0])));
    tr.appendChild(el('td', null, String(state.totals[1])));
    tfoot.appendChild(tr);
    table.appendChild(tfoot);

    const wrap = el('div', 'tb-table-wrap');
    wrap.appendChild(table);
    return wrap;
  }

  function buildReveal(p, res) {
    const box = el('div', 'tb-reveal');
    const head = el('div', 'tb-reveal-head');
    const nm = el('span', 'tb-name ' + (p === 0 ? 'tb-p0' : 'tb-p1'), players[p].name);
    head.appendChild(nm);
    if (res.wentOut === p) head.appendChild(el('span', 'tb-out-chip', 'went out'));
    head.appendChild(el('span', 'tb-round-score', `+${res.scores[p]}`));
    box.appendChild(head);

    const cardsWrap = el('div', 'tb-reveal-cards');
    const a = res.arrangements[p];
    a.melds
      .map((m) => m.slice().sort((x, y) => rank(x) - rank(y) || x - y))
      .forEach((m, i) => {
        const g = el('div', 'tb-meld-group');
        g.style.setProperty('--tb-meld-color', MELD_COLORS[i % MELD_COLORS.length]);
        for (const c of m) g.appendChild(renderCard(c, { wildRank: res.wildRank }));
        cardsWrap.appendChild(g);
      });
    if (a.deadwood.length) {
      const dw = el('div', 'tb-dw-group');
      const sorted = a.deadwood
        .slice()
        .sort((x, y) => cardPoints(y, res.wildRank) - cardPoints(x, res.wildRank) || x - y);
      for (const c of sorted) {
        const holder = el('div', 'tb-dw');
        holder.appendChild(renderCard(c, { wildRank: res.wildRank }));
        holder.appendChild(el('span', 'tb-dw-pts', `+${cardPoints(c, res.wildRank)}`));
        dw.appendChild(holder);
      }
      cardsWrap.appendChild(dw);
    } else {
      cardsWrap.appendChild(el('span', 'tb-none', 'fully melded — 0 points'));
    }
    box.appendChild(cardsWrap);
    return box;
  }

  function buildRoundEnd() {
    const res = state.roundResults[state.roundResults.length - 1];
    const overlay = el('div', 'tb-overlay');
    const modal = el('div', 'tb-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Round summary');
    modal.appendChild(el('h2', null, `${RANK_NAMES[res.wildRank - 1]}s round complete`));
    modal.appendChild(el('p', 'tb-sub', `${players[res.wentOut].name} went out`));
    for (const p of [mySeat, oppSeat]) modal.appendChild(buildReveal(p, res));
    modal.appendChild(buildScoreTable(false));
    modal.appendChild(el('p', 'tb-legend', '★ = went out'));

    const actions = el('div', 'tb-modal-actions');
    const btn = el('button', 'btn btn-primary');
    btn.type = 'button';
    if (canAdvanceRound(adapters, mySeat)) {
      btn.textContent = state.roundIndex === ROUNDS.length - 1 ? 'See final results' : 'Next round';
      btn.addEventListener('click', () => apply({ type: 'nextRound' }));
    } else {
      btn.textContent = `Waiting for ${players[0].name}…`;
      btn.disabled = true;
    }
    actions.appendChild(btn);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    return overlay;
  }

  function buildGameOver() {
    const overlay = el('div', 'tb-overlay tb-opaque');
    const modal = el('div', 'tb-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Game result');
    modal.appendChild(el('div', 'tb-final-crown', '♛'));
    const title = state.winner === 'tie' ? 'It’s a tie!' : `${players[state.winner].name} wins!`;
    modal.appendChild(el('h2', 'tb-final-title', title));
    modal.appendChild(
      el('p', 'tb-final-score', `${players[0].name} ${state.totals[0]} — ${players[1].name} ${state.totals[1]}`)
    );
    modal.appendChild(buildScoreTable(false));
    modal.appendChild(el('p', 'tb-legend', '★ = went out · lowest total wins'));

    const actions = el('div', 'tb-modal-actions');
    const save = el('button', 'btn btn-primary', 'Save & finish');
    save.type = 'button';
    save.addEventListener('click', () => {
      persistFinished();
      onGameEnd(state);
    });
    actions.appendChild(save);
    if (!hasRemote) {
      const rem = el('button', 'btn', 'Rematch');
      rem.type = 'button';
      rem.addEventListener('click', () => {
        persistFinished();
        rematch();
      });
      actions.appendChild(rem);
    }
    const home = el('button', 'btn btn-quiet', 'Home');
    home.type = 'button';
    home.addEventListener('click', () => {
      persistFinished();
      onQuit();
    });
    actions.appendChild(home);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    return overlay;
  }

  function buildScoresSheet() {
    const overlay = el('div', 'tb-overlay tb-bottom');
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        scoresOpen = false;
        render();
      }
    });
    const sheet = el('div', 'tb-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Score sheet');
    const head = el('div', 'tb-sheet-head');
    head.appendChild(el('h2', null, 'Score sheet'));
    const close = el('button', 'tb-icon-btn', '✕');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close score sheet');
    close.addEventListener('click', () => {
      scoresOpen = false;
      render();
    });
    head.appendChild(close);
    sheet.appendChild(head);
    let sub = roundLabel(state);
    if (state.wentOut !== null && (state.phase === 'draw' || state.phase === 'discard')) {
      sub += ` · ${players[state.wentOut].name} went out`;
    }
    sheet.appendChild(el('p', 'tb-sub', sub));
    sheet.appendChild(buildScoreTable(true));
    sheet.appendChild(el('p', 'tb-legend', '★ = went out'));
    overlay.appendChild(sheet);
    return overlay;
  }

  function buildQuitConfirm() {
    const overlay = el('div', 'tb-overlay');
    const modal = el('div', 'tb-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Quit game');
    modal.appendChild(el('h2', null, 'Quit this game?'));
    modal.appendChild(el('p', 'tb-sub', 'It will be saved as unfinished.'));
    const actions = el('div', 'tb-modal-actions');
    const stay = el('button', 'btn', 'Keep playing');
    stay.type = 'button';
    stay.addEventListener('click', () => {
      quitOpen = false;
      render();
    });
    const quit = el('button', 'btn tb-btn-danger', 'Quit game');
    quit.type = 'button';
    quit.addEventListener('click', doQuit);
    actions.appendChild(stay);
    actions.appendChild(quit);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    return overlay;
  }

  /* ---- render ---- */

  function render() {
    if (disposed) return;
    const playing = state.phase === 'draw' || state.phase === 'discard';
    const root = el('div', 'tb-screen');

    // top bar
    const bar = el('div', 'tb-topbar');
    const quitBtn = el('button', 'tb-icon-btn', '✕');
    quitBtn.type = 'button';
    quitBtn.setAttribute('aria-label', 'Quit game');
    quitBtn.addEventListener('click', () => {
      if (state.phase === 'gameOver') {
        doQuit();
      } else {
        quitOpen = true;
        render();
      }
    });
    const modeChip = el('span', 'tb-mode', state.config.mode === 'hard' ? 'Hard mode' : 'Four Crowns');
    const scoresBtn = el('button', 'tb-icon-btn', '▤');
    scoresBtn.type = 'button';
    scoresBtn.setAttribute('aria-label', 'Score sheet');
    scoresBtn.addEventListener('click', () => {
      scoresOpen = true;
      render();
    });
    bar.append(quitBtn, modeChip, scoresBtn);
    root.appendChild(bar);

    // opponent zone (face-down fan only — never their actual cards)
    const opp = el('section', 'tb-zone tb-opp');
    if (playing && state.turn === oppSeat) opp.classList.add('tb-active');
    const oppLine = el('div', 'tb-player-line');
    oppLine.appendChild(el('span', 'tb-turn-dot'));
    oppLine.appendChild(el('span', 'tb-name', players[oppSeat].name));
    oppLine.appendChild(totalPill(oppSeat));
    const fan = el('div', 'tb-opp-fan');
    const oppCount = state.hands[oppSeat].length;
    for (let i = 0; i < oppCount; i++) fan.appendChild(renderCard(0, { faceDown: true }));
    opp.append(oppLine, fan);
    root.appendChild(opp);

    // middle: round banner, piles, status
    const mid = el('section', 'tb-mid');
    const banner = el('div', 'tb-round-banner');
    banner.appendChild(el('span', null, roundLabel(state)));
    if (state.phase !== 'gameOver') {
      banner.appendChild(el('span', 'tb-wild-chip', `${RANK_NAMES[state.wildRank - 1]} ★ wild`));
    }
    mid.appendChild(banner);
    if (state.wentOut !== null && playing) {
      mid.appendChild(el('div', 'tb-lastturn', `${players[state.wentOut].name} went out! LAST TURN`));
    }
    mid.appendChild(buildPiles());
    mid.appendChild(el('div', 'tb-status', statusText()));
    root.appendChild(mid);

    // local player zone
    const me = el('section', 'tb-zone tb-me');
    if (playing && state.turn === mySeat) me.classList.add('tb-active');
    const handWrap = el('div', 'tb-hand-wrap');
    const { row, points } = buildMyHand();
    handWrap.appendChild(row);
    me.appendChild(handWrap);
    const meBar = el('div', 'tb-me-bar');
    meBar.appendChild(el('span', 'tb-points-pill', `Points in hand: ${points}`));
    if (canDiscardNow()) {
      const discard = el('button', 'btn btn-primary tb-inline', 'Discard');
      discard.type = 'button';
      discard.disabled = sel == null;
      discard.addEventListener('click', () => {
        if (sel != null) confirmDiscard(sel);
      });
      meBar.appendChild(discard);
    }
    me.appendChild(meBar);
    const myLine = el('div', 'tb-player-line');
    myLine.appendChild(el('span', 'tb-turn-dot'));
    myLine.appendChild(el('span', 'tb-name', players[mySeat].name));
    myLine.appendChild(totalPill(mySeat));
    me.appendChild(myLine);
    root.appendChild(me);

    // overlays
    if (state.phase === 'roundEnd') root.appendChild(buildRoundEnd());
    if (state.phase === 'gameOver') root.appendChild(buildGameOver());
    if (scoresOpen) root.appendChild(buildScoresSheet());
    if (quitOpen) root.appendChild(buildQuitConfirm());

    container.replaceChildren(root);
  }

  /* ---- lifecycle ---- */

  const onResize = () => {
    if (disposed) return;
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(render);
  };
  window.addEventListener('resize', onResize);

  render();
  drive();

  return function cleanup() {
    disposed = true;
    clearTimeout(aiTimer);
    cancelAnimationFrame(resizeRaf);
    window.removeEventListener('resize', onResize);
  };
}

/* ------------------------------------------------------------------ */
/* Screen registration                                                 */
/* ------------------------------------------------------------------ */

registerScreen('table', {
  mount(container, params) {
    if (!params || !params.config || !params.adapters) {
      // Re-entered via history without live params — nothing to resume.
      navigate('home');
      return;
    }
    return startTable(container, {
      localSeat: 0,
      onQuit: () => navigate('home'),
      onGameEnd: () => navigate('stats'),
      ...params,
    });
  },
});
