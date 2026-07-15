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
import { ROUNDS, RANK_NAMES, rank, suit, cardName, cardPoints, mulberry32 } from '../engine/cards.js';
import { saveGame, getSettings } from '../stats/store.js';
import { saveResume, clearResume } from './resume.js';

/* ------------------------------------------------------------------ */
/* Pure helpers (no DOM) — exported for node sanity tests              */
/* ------------------------------------------------------------------ */

const SET_COLORS = ['#e9c46a', '#7ec8a9', '#9ec5ff', '#eaa9dd'];
const GROUP_GAP = 12; // extra px between meld groups / deadwood in the hand row

/** Display suit order, left to right: ♠ ♣ ♦ ♥ (engine suit ids 0,3,2,1). */
const SUIT_WEIGHT = [0, 3, 2, 1];
const suitW = (c) => SUIT_WEIGHT[suit(c)];

/**
 * A card's "thrown down" scatter on the discard pile — a small rotation and
 * offset, deterministic per card id so it never jitters between re-renders
 * (real cards don't land perfectly square). {rot: deg, dx, dy: px}.
 */
function discScatter(cardId) {
  const h = ((cardId + 1) * 2654435761) >>> 0;
  return {
    rot: ((h % 21) - 10),           // -10°..+10°
    dx: (((h >> 5) % 9) - 4),       // -4..+4 px
    dy: (((h >> 10) % 7) - 3),      // -3..+3 px
  };
}

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
  const melds = arr.melds.map(m => displaySet(m, wildRank));
  melds.sort((a, b) => rank(b[0]) - rank(a[0]) || suitW(a[0]) - suitW(b[0]));
  const deadwood = arr.deadwood
    .slice()
    .sort((a, b) => cardPoints(b, wildRank) - cardPoints(a, wildRank)
      || suitW(a) - suitW(b));
  return { melds, deadwood, points: arr.points };
}

/**
 * Order a meld's cards for display. Runs read highest (left) to lowest
 * (right) with any wilds shown in the run position they fill: natural cards
 * sit at their own rank, forced interior gaps take wilds, and spare wilds
 * extend the run at the HIGH end when the window allows (a wild next to 9-10
 * reads as the Jack, not the 8). Groups show naturals (suit order) with
 * wilds on the right.
 * @param {number[]} meld - 3-4 card ids forming a valid meld
 * @param {number} wildRank
 * @returns {number[]} the same cards, display-ordered
 */
export function displaySet(meld, wildRank) {
  const naturals = meld.filter((c) => rank(c) !== wildRank);
  const wilds = meld.filter((c) => rank(c) === wildRank);
  const distinct = new Set(naturals.map(rank));
  const bySuit = (a, b) => suitW(a) - suitW(b);
  // Group (incl. all-wild-rank, which is a natural group of the wild rank):
  if (naturals.length === 0) return meld.slice().sort(bySuit);
  if (distinct.size === 1) {
    return naturals.sort(bySuit).concat(wilds.sort(bySuit));
  }
  // Run: read highest (left) to lowest (right). The ace plays low unless the
  // naturals only seat as an ace-high run (Q-K-A), in which case A -> 14 and
  // shows at the top. Pick the highest window so spare wilds land up top.
  const n = meld.length;
  const hasAce = naturals.some((c) => rank(c) === 1);
  const fitsLow = () => {
    const rr = naturals.map(rank);
    const mn = Math.min(...rr);
    const mx = Math.max(...rr);
    return mx - mn <= n - 1 && Math.max(1, mx - n + 1) <= Math.min(mn, 14 - n);
  };
  const aceHigh = hasAce && !fitsLow();
  const mr = (c) => (aceHigh && rank(c) === 1 ? 14 : rank(c));
  const bandHi = aceHigh ? 14 : 13;
  const rr = naturals.map(mr);
  const lo = Math.min(Math.min(...rr), bandHi - n + 1);
  const byRank = new Map(naturals.map((c) => [mr(c), c]));
  const spareWilds = wilds.slice().sort(bySuit).reverse(); // ♠ pops first
  const out = [];
  for (let r = lo + n - 1; r >= lo; r--) {
    out.push(byRank.has(r) ? byRank.get(r) : spareWilds.pop());
  }
  return out;
}

/**
 * Merge a user-chosen hand order with the hand's current contents: keep the
 * user's relative order for cards still held, drop discarded/melded-away
 * cards, and append newly drawn cards on the right (so a fresh draw is easy
 * to spot and place).
 * @param {number[]} prevOrder - last user order (card ids)
 * @param {number[]} hand - the authoritative current hand
 * @returns {number[]} every card of `hand`, in user order
 */
export function mergeOrder(prevOrder, hand) {
  const inHand = new Set(hand);
  const out = prevOrder.filter((c) => inHand.has(c));
  const seen = new Set(out);
  for (const c of hand) if (!seen.has(c)) out.push(c);
  return out;
}

/**
 * Reorder: move `id` so it sits at visual slot `insertIdx` (an index into the
 * CURRENT order, counting gaps: 0 = far left, order.length = far right).
 * @param {number[]} order
 * @param {number} id
 * @param {number} insertIdx
 * @returns {number[]} new order (input untouched)
 */
export function moveCard(order, id, insertIdx) {
  const cur = order.indexOf(id);
  if (cur === -1) return order.slice();
  const out = order.slice();
  out.splice(cur, 1);
  const idx = insertIdx > cur ? insertIdx - 1 : insertIdx;
  out.splice(Math.max(0, Math.min(out.length, idx)), 0, id);
  return out;
}

/**
 * Home a just-kept card into its most logical spot in the player's order:
 * - If the arrangement melds it, it slots in next to its meld-mates, at the
 *   position the meld reads in (its display-order neighbour).
 * - Otherwise it files into the deadwood: just before the first deadwood card
 *   worth fewer points (scanning left to right), or after the last one.
 * @param {number[]} order - user order containing `id`
 * @param {number} id - the kept card
 * @param {{melds: number[][], deadwood: number[]}} arr - arrangeHand() output
 *   for the full current hand (melds display-ordered)
 * @param {number} wildRank
 * @returns {number[]} new order (input untouched)
 */
export function placeCard(order, id, arr, wildRank) {
  const out = order.filter((c) => c !== id);
  if (out.length === order.length) return order.slice(); // id not present
  const meld = arr.melds.find((m) => m.includes(id));
  if (meld) {
    const k = meld.indexOf(id);
    const left = k > 0 ? meld[k - 1] : null;
    const right = k < meld.length - 1 ? meld[k + 1] : null;
    const li = left != null ? out.indexOf(left) : -1;
    if (li !== -1) { out.splice(li + 1, 0, id); return out; }
    const ri = right != null ? out.indexOf(right) : -1;
    if (ri !== -1) { out.splice(ri, 0, id); return out; }
    out.push(id);
    return out;
  }
  const dead = new Set(arr.deadwood);
  const pts = cardPoints(id, wildRank);
  let lastDead = -1;
  for (let i = 0; i < out.length; i++) {
    if (!dead.has(out[i])) continue;
    if (cardPoints(out[i], wildRank) < pts) { out.splice(i, 0, id); return out; }
    lastDead = i;
  }
  if (lastDead === -1) out.push(id); // no other deadwood: rightmost
  else out.splice(lastDead + 1, 0, id); // after the last (cheapest-so-far) deadwood
  return out;
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
      // Turns the going-out player needed — feeds the round-length analytics.
      ...(Number.isInteger(r.turns) ? { turns: r.turns } : {}),
      // Final meld arrangement per player (arrays of card ids 0-51) — feeds
      // the meld-trends analytics. The wild rank is recoverable from `round`.
      ...(r.arrangements
        ? { melds: r.arrangements.map(a => a.melds.map(m => m.slice())) }
        : {}),
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
.tb-setcard::after {
  content: ""; position: absolute; left: 7%; right: 7%; bottom: -6px; height: 4px;
  border-radius: 2px; background: var(--tb-set-color, var(--gold));
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
/* Drop-slot marker while rearranging the hand */
.tb-insert-before { box-shadow: -3px 0 0 0 var(--gold, #e9c46a); }
.tb-insert-after { box-shadow: 3px 0 0 0 var(--gold, #e9c46a); }

/* Discard pile: a slightly messy stack — recent cards peek out underneath at
   their own scatter angles and the top card sits above at the angle it landed
   on. The mess stands for the whole hand; the pile is never tidied/squared. */
.tb-disc-card:not(.tb-disc-peek) { position: relative; z-index: 1; }
.tb-disc-peek {
  position: absolute; top: 0; left: 50%;
  margin-left: calc(var(--card-w) * -0.5); z-index: 0;
}
/* A card in flight from the hand to the pile (tapped-in discards) */
.tb-fly {
  position: fixed; z-index: 650; pointer-events: none; margin: 0 !important;
  transition: transform .3s cubic-bezier(.3, .8, .35, 1); will-change: transform;
}

/* The card just drawn: gold glow + slight lift until it's placed/discarded */
.tb-newcard {
  box-shadow: 0 0 0 2px var(--gold, #e9c46a), 0 0 14px rgba(233, 196, 106, .55);
  transform: translateY(-6px);
}

/* Required meld shape for the round, e.g. [3][3][4], filled = already made */
.tb-shape-row {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  flex-wrap: wrap; margin: 0 0 8px;
}
.tb-shape-group { display: inline-flex; gap: 4px; }
.tb-shape-or { font-size: 11px; color: rgba(255,255,255,.55); padding: 0 1px; }
.tb-shape-label {
  font-size: 11px; letter-spacing: .05em; text-transform: uppercase;
  color: rgba(255,255,255,.72); margin-right: 2px;
}
.tb-shape-chip {
  min-width: 26px; text-align: center; padding: 3px 8px; border-radius: 8px;
  font-size: 13px; font-weight: 700; color: rgba(255,255,255,.85);
  background: rgba(0,0,0,.25); border: 1.5px dashed rgba(255,255,255,.4);
  font-variant-numeric: tabular-nums;
}
.tb-shape-done {
  border-style: solid; border-color: var(--gold, #e9c46a);
  background: rgba(233, 196, 106, .24); color: #fff;
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
.tb-set-group {
  display: flex; gap: 3px; padding-bottom: 5px;
  border-bottom: 3px solid var(--tb-set-color, var(--gold)); border-radius: 2px;
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

  // "No assist" mode: a local display preference (never synced — each player
  // chooses their own). Strips every aid you wouldn't have with real cards:
  // no meld grouping/underlines, no wild highlighting, no shape hints, no
  // points readout. The hand is only ordered high-to-low at the deal; from
  // then on it's arranged purely by hand.
  let pure = false;
  try { pure = !!getSettings().pureMode; } catch (e) { /* default assisted */ }

  // Resuming: a saved engine state replaces the fresh deal, and the stats
  // record id is reused so finishing later upgrades the same record.
  let state = opts.resumeState || createGame(opts.config);
  let gameId = opts.resumeGameId || newGameId();
  let sel = null;          // selected card id during the local discard phase
  let scoresOpen = false;  // score-sheet bottom drawer
  let quitOpen = false;    // quit confirm dialog
  let saved = false;       // finished game already persisted?
  let disposed = false;
  let suppressClick = false; // swallow the click that follows a drag
  let handOrder = Array.isArray(opts.resumeHandOrder) ? opts.resumeHandOrder.slice() : [];
  let orderRound = Number.isInteger(opts.resumeOrderRound) ? opts.resumeOrderRound : -1;
  let sortAnimFrom = null; // previous visual order to FLIP-animate from
  let sortAnimDelay = 420; // hold before the glide (long at deal, short on keep)
  let dragging = false;    // a hand-card drag is in flight
  let pendingRender = false; // a render arrived mid-drag; run it on release
  let lastDrawn = null;    // the card the local player just drew (until they discard)
  let drawnMoved = false;  // the player hand-placed the drawn card themselves
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
    // Track the local player's fresh draw (the engine appends it to the hand);
    // it stays highlighted — and outside the meld annotation — until discard.
    if (action.type === 'draw' && action.player === mySeat && seatIsLocal) {
      const h = state.hands[mySeat];
      lastDrawn = h[h.length - 1];
      drawnMoved = false;
    } else if (action.type !== 'draw') {
      // Kept the drawn card (discarded another): home it into its logical
      // spot — its new meld, or the deadwood by points — with a quick glide.
      // If the player already placed it by hand, their spot stands.
      if (!pure && action.type === 'discard' && action.player === mySeat && seatIsLocal
        && lastDrawn != null && action.card !== lastDrawn && !drawnMoved) {
        const h = state.hands[mySeat];
        if (h.includes(lastDrawn)) {
          const merged = mergeOrder(handOrder, h);
          const arr = arrangeHand(h, state.wildRank, state.config.mode);
          const placed = placeCard(merged, lastDrawn, arr, state.wildRank);
          if (placed.join() !== merged.join()) {
            sortAnimFrom = merged;
            sortAnimDelay = 80;
          }
          handOrder = placed;
        }
      }
      lastDrawn = null; // own discard, or a round boundary
    }
    if (!fromRemote) reportLocal(action);
    sel = null;
    render();
    // Opponent discards fly into the pile too, so both players see it land.
    if (action.type === 'discard' && action.player !== mySeat) flyOppDiscard(action.card);
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

  function confirmDiscard(id, animate = true) {
    if (!canDiscardNow()) return;
    if (state.hands[mySeat].indexOf(id) === -1) return;
    // Tapped-in discards fly from the hand to the pile; dragged ones already
    // moved under the finger, so they pass animate=false. Capture the card's
    // screen spot before the re-render replaces it.
    let fromRect = null;
    if (animate) {
      const row = container.querySelector('.tb-hand');
      const idx = handOrder.indexOf(id);
      if (row && idx >= 0 && row.children[idx]) fromRect = row.children[idx].getBoundingClientRect();
    }
    apply({ type: 'discard', player: mySeat, card: id });
    if (fromRect) flyToDiscard(id, fromRect);
  }

  /** Animate a card clone from a hand slot onto the discard pile. Cosmetic. */
  function flyToDiscard(id, fromRect) {
    if (disposed) return;
    const pile = container.querySelector('.tb-pile-discard');
    if (!pile || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    const toRect = (pile.querySelector('.tb-disc-card') || pile).getBoundingClientRect();
    const clone = renderCard(id, pure ? {} : { wildRank: state.wildRank });
    clone.classList.add('tb-fly');
    clone.style.left = `${fromRect.left}px`;
    clone.style.top = `${fromRect.top}px`;
    clone.style.width = `${fromRect.width}px`;
    clone.style.height = `${fromRect.height}px`;
    document.body.appendChild(clone);
    const sc = discScatter(id);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const dx = toRect.left - fromRect.left + (toRect.width - fromRect.width) / 2;
      const dy = toRect.top - fromRect.top + (toRect.height - fromRect.height) / 2;
      clone.style.transform = `translate(${dx}px, ${dy}px) rotate(${sc.rot}deg)`;
    }));
    const done = () => clone.remove();
    clone.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 600);
  }

  /**
   * Opponent discards fly from their fan into the pile as well, so both players
   * see the card land (not just whoever discarded). Runs after the re-render,
   * from a pile-sized clone centred on the opponent fan.
   */
  function flyOppDiscard(id) {
    if (disposed) return;
    const pile = container.querySelector('.tb-pile-discard');
    const fan = container.querySelector('.tb-opp-fan');
    if (!pile || !fan) return;
    const toRect = (pile.querySelector('.tb-disc-card') || pile).getBoundingClientRect();
    const fanRect = fan.getBoundingClientRect();
    flyToDiscard(id, {
      left: fanRect.left + fanRect.width / 2 - toRect.width / 2,
      top: fanRect.top + fanRect.height / 2 - toRect.height / 2,
      width: toRect.width,
      height: toRect.height,
    });
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

  // In-progress persistence: AI games save themselves; online games save with
  // the metadata online.js provides (seat, room code) so peers can reconnect.
  const aiAdapter = adapters.find((a) => a && a.kind === 'ai');
  const resumeMeta = opts.resumeMeta
    || (aiAdapter && seatIsLocal ? { kind: 'ai', aiLevel: aiAdapter.level } : null);

  function persistResume() {
    if (!resumeMeta || disposed) return;
    if (state.phase === 'gameOver') {
      clearResume(); // finished games are in the stats, not the resume slot
      return;
    }
    saveResume({ ...resumeMeta, state, gameId, handOrder, orderRound });
  }

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
    handOrder = [];
    orderRound = -1;
    sortAnimFrom = null;
    lastDrawn = null;
    drawnMoved = false;
    scoresOpen = false;
    quitOpen = false;
    render();
    drive();
  }

  /* ---- hand-card dragging: reorder anytime, discard on your turn ---- */

  /** Insertion slot (0..n) for a pointer x among the hand row's cards. */
  function insertIndexAt(row, x) {
    const kids = [...row.children];
    for (let i = 0; i < kids.length; i++) {
      const r = kids[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) return i;
    }
    return kids.length;
  }

  function clearInsertMarkers(row) {
    for (const k of row.children) k.classList.remove('tb-insert-before', 'tb-insert-after');
  }

  function attachDrag(cardEl, id) {
    cardEl.addEventListener('pointerdown', (ev) => {
      if (ev.button !== undefined && ev.button !== 0) return;
      const row = cardEl.parentElement;
      const startX = ev.clientX;
      const startY = ev.clientY;
      let ghost = null;

      const overPile = (e, pile) => {
        if (!pile) return false;
        const r = pile.getBoundingClientRect();
        return e.clientX >= r.left - 10 && e.clientX <= r.right + 10 &&
          e.clientY >= r.top - 10 && e.clientY <= r.bottom + 10;
      };

      const move = (e) => {
        if (!ghost && Math.hypot(e.clientX - startX, e.clientY - startY) > 12) {
          ghost = cardEl.cloneNode(true);
          ghost.classList.remove('selected');
          ghost.classList.add('tb-ghost');
          const r = cardEl.getBoundingClientRect();
          ghost.style.setProperty('--card-w', r.width + 'px');
          ghost.style.width = r.width + 'px';
          document.body.appendChild(ghost);
          dragging = true;
          if (canDiscardNow()) {
            const pile = container.querySelector('.tb-pile-discard');
            if (pile) pile.classList.add('tb-drop-ready');
          }
        }
        if (ghost) {
          ghost.style.left = e.clientX + 'px';
          ghost.style.top = e.clientY + 'px';
          // Insertion marker: a thin line at the slot the card would land in.
          clearInsertMarkers(row);
          const pile = container.querySelector('.tb-pile-discard');
          if (!(canDiscardNow() && overPile(e, pile))) {
            const idx = insertIndexAt(row, e.clientX);
            if (idx < row.children.length) row.children[idx].classList.add('tb-insert-before');
            else if (row.children.length) row.lastElementChild.classList.add('tb-insert-after');
          }
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
        clearInsertMarkers(row);
        const pile = container.querySelector('.tb-pile-discard');
        if (pile) pile.classList.remove('tb-drop-ready');
        dragging = false;
        if (!wasDrag) return;
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);

        let acted = false;
        if (e.type === 'pointerup') {
          if (canDiscardNow() && overPile(e, pile)) {
            confirmDiscard(id, false); // dragged: the ghost already animated
            acted = true;
          } else {
            // Reorder — only when released near the hand row, so an aborted
            // drag (let go somewhere random) doesn't scramble the hand.
            const rr = row.getBoundingClientRect();
            if (e.clientY > rr.top - 80 && e.clientY < rr.bottom + 80) {
              handOrder = moveCard(handOrder, id, insertIndexAt(row, e.clientX));
              if (id === lastDrawn) drawnMoved = true; // their spot now stands
              acted = true;
            }
          }
        }
        if (pendingRender || acted) {
          pendingRender = false;
          render();
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
      // Messy stack: a few recent cards peek out underneath, each frozen at
      // its own scatter angle — the angle it was thrown down at. The pile is
      // never tidied, so the top card keeps the angle it landed on all hand.
      const recent = state.discard.slice(-4); // bottom..top
      recent.forEach((c, i) => {
        const isTop = i === recent.length - 1;
        // No-assist: render plainly so a wild in the pile isn't flagged for you.
        const cardEl = renderCard(c, pure ? {} : { wildRank: state.wildRank });
        cardEl.classList.add('tb-disc-card');
        if (!isTop) cardEl.classList.add('tb-disc-peek');
        const sc = discScatter(c);
        cardEl.style.transform = `translate(${sc.dx}px, ${sc.dy}px) rotate(${sc.rot}deg)`;
        discBtn.appendChild(cardEl);
      });
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

    // The player owns the card ORDER (drag to rearrange, anytime).
    // Each round STARTS sorted — animated from the deal order so the sort is
    // visible — and is the player's to rearrange from there. Assisted mode
    // opens into the solver's best arrangement (melds grouped, runs high-to-
    // low, deadwood by points); no-assist opens into a plain high-to-low sort.
    if (orderRound !== state.roundIndex) {
      let sorted;
      if (pure) {
        sorted = hand.slice().sort((a, b) =>
          cardPoints(b, state.wildRank) - cardPoints(a, state.wildRank) || suitW(a) - suitW(b));
      } else {
        const dealt = arrangeHand(hand, state.wildRank, state.config.mode);
        sorted = [...dealt.melds.flat(), ...dealt.deadwood];
      }
      sortAnimFrom = hand.slice(); // deal order, for the FLIP animation
      sortAnimDelay = 420;
      handOrder = sorted;
      orderRound = state.roundIndex;
    } else {
      handOrder = mergeOrder(handOrder, hand);
    }
    const ordered = handOrder;
    const interactive = canDiscardNow();
    const zoneW = Math.min(container.clientWidth || 390, 560) - 24;

    // No-assist: plain row, no meld grouping/underlines, no wild flag, no
    // points, no drawn-card glow — nothing you wouldn't have with real cards.
    if (pure) {
      const row = handRow(ordered, {
        wildRank: 0, // 0 matches no rank -> wilds render as ordinary cards
        selectedId: sel,
        maxWidth: Math.max(160, zoneW),
        onTap: interactive ? onCardTap : null,
      });
      row.classList.add('tb-hand');
      for (let i = 0; i < ordered.length; i++) attachDrag(row.children[i], ordered[i]);
      return { row, pointsLabel: null, meldSizes: [] };
    }

    // A fresh draw stays OUT of the meld annotation until the player discards:
    // the underlines keep showing the hand as it was, and the new card sits
    // highlighted for the player to place — the solver never yanks wilds into
    // a "helpful" new grouping (2 wilds + a drawn King) uninvited.
    const freshDraw = canDiscardNow() && lastDrawn != null && hand.includes(lastDrawn)
      ? lastDrawn : null;
    const annotBasis = freshDraw != null ? hand.filter((c) => c !== freshDraw) : hand;
    const arr = arrangeHand(annotBasis, state.wildRank, state.config.mode);
    const groupOf = new Map(); // card id -> meld index, or -1 for deadwood
    arr.melds.forEach((m, i) => m.forEach((c) => groupOf.set(c, i)));
    arr.deadwood.forEach((c) => groupOf.set(c, -1));
    if (freshDraw != null) groupOf.set(freshDraw, -2); // its own visual group

    // Pill: with a fresh draw in hand, show the best you can get DOWN to —
    // the minimum over every possible discard.
    let points = arr.points;
    if (freshDraw != null) {
      points = Infinity;
      for (const c of hand) {
        const p = arrangeHand(hand.filter((x) => x !== c), state.wildRank, state.config.mode).points;
        if (p < points) points = p;
      }
    }

    let boundaries = 0;
    for (let i = 1; i < ordered.length; i++) {
      if (groupOf.get(ordered[i]) !== groupOf.get(ordered[i - 1])) boundaries++;
    }

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
        cardEl.classList.add('tb-setcard');
        cardEl.style.setProperty('--tb-set-color', SET_COLORS[g % SET_COLORS.length]);
      }
      if (id === freshDraw) cardEl.classList.add('tb-newcard');
      if (i > 0 && g !== groupOf.get(ordered[i - 1])) {
        cardEl.style.marginLeft = `calc(var(--hand-overlap, 8px) + ${GROUP_GAP}px)`;
      }
      attachDrag(cardEl, id); // reorder works even when it's not your turn
    }
    return {
      row,
      pointsLabel: freshDraw != null ? `Best after discard: ${points}` : `Points in hand: ${points}`,
      meldSizes: arr.melds.map((m) => m.length),
    };
  }

  /**
   * The round's required meld shape(s), e.g. 3·3·4 for the 10s round, with the
   * slots the player's current melds already fill lit up. Rounds with more
   * than one valid shape (the Qs round: 4·4·4 or 3·3·3·3) show BOTH from the
   * start, joined by "or", each lit independently.
   */
  function buildShapeChips(meldSizes) {
    const shapes = shapesFor(state.handSize);
    if (!shapes.length) return null;
    const have = {};
    for (const s of meldSizes) have[s] = (have[s] || 0) + 1;

    const row = el('div', 'tb-shape-row');
    row.appendChild(el('span', 'tb-shape-label', 'Sets needed'));
    const labelParts = [];
    shapes.forEach((sh, idx) => {
      if (idx > 0) row.appendChild(el('span', 'tb-shape-or', 'or'));
      const group = el('span', 'tb-shape-group');
      const slots = sh.slice().sort((a, b) => a - b);
      const remaining = { ...have };
      for (const s of slots) {
        const filled = (remaining[s] || 0) > 0;
        if (filled) remaining[s]--;
        group.appendChild(el('span', 'tb-shape-chip' + (filled ? ' tb-shape-done' : ''), String(s)));
      }
      row.appendChild(group);
      labelParts.push(slots.join('·'));
    });
    row.setAttribute('aria-label', `Sets needed this round: ${labelParts.join(' or ')}`);
    return row;
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
      .map((m) => displaySet(m, res.wildRank))
      .forEach((m, i) => {
        const g = el('div', 'tb-set-group');
        g.style.setProperty('--tb-set-color', SET_COLORS[i % SET_COLORS.length]);
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
      cardsWrap.appendChild(el('span', 'tb-none', 'all in sets — 0 points'));
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
    if (dragging) {
      // Never rebuild the DOM out from under an in-flight drag (an AI or
      // remote move can land mid-gesture); catch up when the card is dropped.
      pendingRender = true;
      return;
    }
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
    const { row, pointsLabel, meldSizes } = buildMyHand();
    if (playing && !pure) {
      const chips = buildShapeChips(meldSizes);
      if (chips) me.appendChild(chips);
    }
    handWrap.appendChild(row);
    me.appendChild(handWrap);
    const meBar = el('div', 'tb-me-bar');
    if (pointsLabel) meBar.appendChild(el('span', 'tb-points-pill', pointsLabel));
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
    runSortAnimation();
    persistResume();
  }

  /**
   * Round-start FLIP: the hand is already rendered in its sorted arrangement;
   * offset every card back to where it sat in the deal order, hold a beat so
   * the deal is seen, then glide each card into its group.
   */
  function runSortAnimation() {
    const from = sortAnimFrom;
    sortAnimFrom = null;
    if (!from) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const row = container.querySelector('.tb-hand');
    if (!row || row.children.length !== from.length) return;
    const kids = [...row.children];
    const slots = kids.map((c) => c.getBoundingClientRect().left);
    const moved = [];
    for (let i = 0; i < kids.length; i++) {
      const dealIdx = from.indexOf(handOrder[i]);
      if (dealIdx === -1 || dealIdx === i) continue;
      kids[i].style.transition = 'none';
      kids[i].style.transform = `translateX(${slots[dealIdx] - slots[i]}px)`;
      moved.push(kids[i]);
    }
    if (!moved.length) return;
    setTimeout(() => {
      for (const k of moved) {
        k.style.transition = 'transform .5s cubic-bezier(.22, .9, .3, 1)';
        k.style.transform = '';
      }
      setTimeout(() => { for (const k of moved) k.style.transition = ''; }, 550);
    }, sortAnimDelay);
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
