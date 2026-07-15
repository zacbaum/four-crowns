/**
 * AI opponent tests: legality/termination/card-conservation across full
 * AI-vs-AI games, the difficulty ordering (easy < medium < hard) measured by
 * seat-balanced self-play, and information hygiene (the AI never reads the
 * opponent's hand).
 *
 * Run: node --test "tests/ai.test.mjs"   (the bare `node --test tests/`
 * directory form is broken on Node 24 / Windows — use the glob).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { mulberry32 } from '../js/engine/cards.js';
import { createGame, applyAction, legalActions } from '../js/engine/game.js';
import { chooseAction } from '../js/ai/ai.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function actionInLegalSet(state, action) {
  return legalActions(state).some(a => {
    if (a.type !== action.type) return false;
    if (a.type === 'draw') return a.player === action.player && a.source === action.source;
    if (a.type === 'discard') return a.player === action.player && a.card === action.card;
    return true;
  });
}

/** All 52 distinct cards are conserved across hands + stock + discard. */
function assertConservation(state, ctx) {
  const all = [...state.hands[0], ...state.hands[1], ...state.stock, ...state.discard];
  assert.equal(all.length, 52, `card count ${all.length} != 52 (${ctx})`);
  const set = new Set(all);
  assert.equal(set.size, 52, `duplicate cards (${ctx})`);
  for (const c of all) assert.ok(c >= 0 && c < 52, `card ${c} out of range (${ctx})`);
}

/**
 * Play one full seeded game. levels[seat] is the AI level for that seat.
 * Verifies legality + conservation at every step when `check` is true.
 * Returns { winner, totals, steps }.
 */
function playGame(levels, seed, { mode = 'normal', check = false } = {}) {
  let s = createGame({ mode, seed, players: [{ name: 'A' }, { name: 'B' }] });
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  let steps = 0;
  while (s.phase !== 'gameOver') {
    // The engine's round-turn safety cap guarantees termination; this is only
    // a test guard so a regression can't hang the suite.
    assert.ok(steps++ < 40000, `game ${seed} did not terminate`);
    if (s.phase === 'roundEnd') {
      s = applyAction(s, { type: 'nextRound' });
      continue;
    }
    if (check) assertConservation(s, `seed ${seed} round ${s.roundIndex} ${s.phase}`);
    const action = chooseAction(levels[s.turn], s, rng);
    assert.ok(actionInLegalSet(s, action), `illegal action ${JSON.stringify(action)} (seed ${seed}, ${s.phase})`);
    s = applyAction(s, action);
  }
  return { winner: s.winner, totals: s.totals, steps };
}

/**
 * Decided win rate of A vs B, seat-balanced: each seed is played twice so each
 * level occupies each seat equally, cancelling any first-move advantage.
 */
function decidedWinRate(A, B, seeds, { mode = 'normal', base = 500 } = {}) {
  let aWin = 0, bWin = 0;
  for (let g = 0; g < seeds; g++) {
    const seed = base + g * 101;
    for (const flip of [0, 1]) {
      const levels = flip === 0 ? [A, B] : [B, A];
      const { winner } = playGame(levels, seed + flip * 7, { mode });
      if (winner === 'tie') continue;
      const winnerLevel = levels[winner];
      if (winnerLevel === A) aWin++;
      else bWin++;
    }
  }
  const decided = aWin + bWin;
  return { rate: decided ? aWin / decided : 0, aWin, bWin, decided };
}

// ---------------------------------------------------------------------------
// Legality, termination, card conservation
// ---------------------------------------------------------------------------

for (const level of ['easy', 'medium', 'hard']) {
  test(`${level}: 30 full AI-vs-AI games are legal, terminate, conserve cards`, () => {
    for (let g = 0; g < 30; g++) {
      const r = playGame([level, level], 7000 + g * 31, { check: true });
      assert.ok(r.winner === 0 || r.winner === 1 || r.winner === 'tie');
    }
  });
}

test('mixed-level games also stay legal and terminate', () => {
  const pairs = [['easy', 'hard'], ['medium', 'hard'], ['easy', 'medium']];
  for (const pair of pairs) {
    for (let g = 0; g < 10; g++) playGame(pair, 8000 + g * 13, { check: true, mode: g % 2 ? 'hard' : 'normal' });
  }
});

// ---------------------------------------------------------------------------
// Difficulty ordering (thresholds set conservatively below measured means,
// which vary with the seed set because the game is high-variance)
// ---------------------------------------------------------------------------

// Thresholds sit well below the measured means (medium>easy ~0.60-0.69,
// hard>easy ~0.64-0.67, hard>medium ~0.51-0.59) to stay non-flaky given the
// game's high variance. hard's edge over medium is real but modest — it plays
// the requested expert style (protects wilds, keeps live pairs, dumps faces)
// which is only slightly point-suboptimal, so we assert "at least as strong".
test('medium clearly beats easy', { timeout: 180000 }, () => {
  const { rate, aWin, bWin } = decidedWinRate('medium', 'easy', 110);
  assert.ok(rate > 0.55, `medium vs easy = ${rate.toFixed(3)} (${aWin}-${bWin}); expected > 0.55`);
});

test('hard clearly beats easy', { timeout: 180000 }, () => {
  const { rate, aWin, bWin } = decidedWinRate('hard', 'easy', 110);
  assert.ok(rate > 0.55, `hard vs easy = ${rate.toFixed(3)} (${aWin}-${bWin}); expected > 0.55`);
});

test('hard is at least as strong as medium', { timeout: 180000 }, () => {
  // Two seed sets combined to cut variance on this thin (~0.55) margin.
  const a = decidedWinRate('hard', 'medium', 90, { base: 500 });
  const b = decidedWinRate('hard', 'medium', 90, { base: 90000 });
  const rate = (a.aWin + b.aWin) / (a.aWin + b.aWin + a.bWin + b.bWin);
  assert.ok(rate >= 0.50, `hard vs medium = ${rate.toFixed(3)}; expected >= 0.50`);
});

// ---------------------------------------------------------------------------
// Information hygiene: the AI must never read the opponent's hand
// ---------------------------------------------------------------------------

function handTrap(seat) {
  return new Proxy([], {
    get() { throw new Error(`AI read opponent hand (seat ${seat})`); },
    has() { throw new Error(`AI probed opponent hand (seat ${seat})`); },
    ownKeys() { throw new Error(`AI enumerated opponent hand (seat ${seat})`); },
  });
}

for (const level of ['easy', 'medium', 'hard']) {
  test(`${level}: never touches the opponent's hand during a decision`, () => {
    // Same level on both seats to exercise the level from both perspectives.
    let s = createGame({ mode: level === 'hard' ? 'hard' : 'normal', seed: 24680, players: [{ name: 'A' }, { name: 'B' }] });
    const rng = mulberry32(12345);
    let steps = 0;
    while (s.phase !== 'gameOver') {
      assert.ok(steps++ < 40000, 'did not terminate');
      if (s.phase === 'roundEnd') { s = applyAction(s, { type: 'nextRound' }); continue; }
      const me = s.turn;
      const realOpp = s.hands[1 - me];
      s.hands[1 - me] = handTrap(1 - me); // trap only while the AI decides
      let action;
      try {
        action = chooseAction(level, s, rng);
      } finally {
        s.hands[1 - me] = realOpp; // restore before the engine applies the move
      }
      s = applyAction(s, action);
    }
  });
}
