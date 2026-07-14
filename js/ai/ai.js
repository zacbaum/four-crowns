/**
 * AI opponents for Four Crowns.
 *
 * Public API (docs/ARCHITECTURE.md):
 *   chooseAction(level, state, rng) -> action
 *
 * Design (empirically calibrated by seat-balanced self-play — see
 * tests/ai.test.mjs): in a two-player go-out race, minimizing the points you
 * can be caught holding is close to optimal, so a clean greedy point-minimizer
 * is the strong core policy that ALL levels share:
 *   - draw: take the face-up discard only when it strictly lowers the points
 *     we can be caught with (it advances a meld); otherwise draw the stock.
 *   - discard: leave the fewest caught points; go out the instant the hand
 *     allows; among equally cheap discards, shed the highest-value card.
 *
 * Difficulty is the RELIABILITY of that optimal play: each level sets how often
 * a turn is played sub-optimally instead, and since fewer mistakes is strictly
 * stronger the ordering easy < medium < hard holds by construction. Measured
 * decided win rates (seat-balanced): medium beats easy ~0.66-0.72, hard beats
 * easy ~0.79-0.82, hard beats medium ~0.59-0.63.
 *
 *   easy   - plays a sub-optimal move ~45% of turns (draws the wrong pile, or
 *            sheds a random deadwood card instead of the point-minimizing one).
 *            Beatable by a casual player, but never breaks its own melds and
 *            never declines an available go-out, so it stays sensible.
 *   medium - the same, ~20% of turns. A genuine but fallible opponent.
 *   hard   - never makes those mistakes, plus two refinements that never raise
 *            its own caught points:
 *              * correct endgame scoring: on the final caught turn it minimizes
 *                the REAL game-mode score (strict-shape in a hard-mode game),
 *                where medium keeps minimizing the normal score - a genuine
 *                edge in every hard-mode game.
 *              * defense: as a LAST tie-break among equally point-minimizing,
 *                equal-value discards, it avoids feeding cards near the ones it
 *                has observed the opponent take from the pile (card counting
 *                from public information only). Provably never self-harming.
 *
 * Information hygiene: this module reads ONLY state.turn, state.phase,
 * state.wentOut, state.hands[state.turn], state.discard, state.stock,
 * state.handSize, state.roundIndex, state.wildRank, state.config and (via
 * legalActions) public game structure. It NEVER reads state.hands[opponent];
 * all knowledge of opponent behaviour comes from discard-pile deltas observed
 * between the AI's own turns.
 *
 * All levels go out whenever a discard allows it (the engine detects going out
 * automatically on discard), and never return an illegal action.
 */

import { rank, suit, cardPoints, isWild } from '../engine/cards.js';
import { bestArrangement } from '../engine/solver.js';
import { legalActions } from '../engine/game.js';

const ENV = typeof process !== 'undefined' && process.env ? process.env : {};
// Difficulty is the reliability of optimal play: all three levels share one
// strong greedy policy, and the level sets how often a turn is played
// sub-optimally instead. Fewer mistakes is strictly stronger, so the ordering
// easy < medium < hard holds by construction. (Calibrated by seat-balanced
// self-play; see the AI tests.)
const MISS_EASY = Number(ENV.FC_ME ?? 0.45);
const MISS_MEDIUM = Number(ENV.FC_MM ?? 0.2);
const DANGER = Number(ENV.FC_D ?? 1); // hard: severity of feeding an observed opponent pick

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

/** Copy of hand with one occurrence of card removed. */
function removeOne(hand, card) {
  const out = hand.slice();
  out.splice(out.indexOf(card), 1);
  return out;
}

const discardAction = (player, card) => ({ type: 'discard', player, card });

/** Pick the candidate with the minimal score; rng breaks ties uniformly. */
function pickMin(candidates, scores, rng) {
  let best = Infinity;
  for (const s of scores) if (s < best) best = s;
  const tied = [];
  for (let i = 0; i < candidates.length; i++) {
    if (scores[i] <= best + 1e-9) tied.push(candidates[i]);
  }
  return tied[Math.min(tied.length - 1, Math.floor(rng() * tied.length))];
}

/** Structural action equality (draw: source, discard: card). */
function sameAction(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === 'draw') return a.player === b.player && a.source === b.source;
  if (a.type === 'discard') return a.player === b.player && a.card === b.card;
  return true;
}

/** Return the action if legal, else fall back to a random legal action. */
function ensureLegal(state, action, rng) {
  const legal = legalActions(state);
  if (legal.length === 0) {
    throw new Error(`chooseAction: no legal actions in phase '${state.phase}'`);
  }
  for (const a of legal) if (sameAction(a, action)) return action;
  return legal[Math.min(legal.length - 1, Math.floor(rng() * legal.length))];
}

// ---------------------------------------------------------------------------
// Core evaluation
// ---------------------------------------------------------------------------

/**
 * Discards whose removal leaves a fully-meldable hand (going out). Pruning is
 * exact: if hand-minus-c melds fully then hand has an arrangement worth
 * cardPoints(c), so the whole hand's minimal points are <= cardPoints(c) <= 25.
 * Going out is mode-independent (a fully-melded hand is all size 3-4 melds, so
 * it trivially satisfies the round shape).
 */
function goOutDiscards(hand, wildRank, basePoints) {
  if (basePoints > 25) return [];
  const outs = [];
  for (const c of hand) {
    if (cardPoints(c, wildRank) < basePoints) continue;
    if (bestArrangement(removeOne(hand, c), wildRank, 'normal').points === 0) {
      outs.push(c);
    }
  }
  return outs;
}

/**
 * For a hand, the point-minimizing discards under the given scoring mode: the
 * cards whose removal leaves the fewest caught points, plus which of them go
 * out. `min` is that fewest-points value.
 * @returns {{outs: number[], best: number[], min: number}}
 */
function candidateDiscards(hand, wildRank, mode) {
  const base = bestArrangement(hand, wildRank, 'normal').points;
  const outs = goOutDiscards(hand, wildRank, base);
  let min = Infinity;
  const pts = new Array(hand.length);
  for (let i = 0; i < hand.length; i++) {
    pts[i] = bestArrangement(removeOne(hand, hand[i]), wildRank, mode).points;
    if (pts[i] < min) min = pts[i];
  }
  const best = [];
  for (let i = 0; i < hand.length; i++) if (pts[i] <= min + 1e-9) best.push(hand[i]);
  return { outs, best, min };
}

/** Legal draw actions split into the stock option and the discard option. */
function drawOptions(state) {
  const legal = legalActions(state);
  return {
    stock: legal.find(a => a.type === 'draw' && a.source === 'stock') || null,
    disc: legal.find(a => a.type === 'draw' && a.source === 'discard') || null,
  };
}

// ---------------------------------------------------------------------------
// Greedy baseline (medium)
// ---------------------------------------------------------------------------

/**
 * Take the face-up discard only when it strictly lowers the points we can be
 * caught holding (it slots into or completes a meld); otherwise draw the hidden
 * stock. Never creates a take/put-back loop: if taking d lowers our points, the
 * point-minimizing discard is never d itself.
 */
function greedyDraw(state, mode) {
  const { stock, disc } = drawOptions(state);
  if (!disc) return stock;
  if (!stock) return disc;
  const hand = state.hands[state.turn];
  const wr = state.wildRank;
  const d = state.discard[state.discard.length - 1];
  const base = bestArrangement(hand, wr, mode).points;
  const withD = bestArrangement([...hand, d], wr, mode).points;
  return withD < base ? disc : stock;
}

/**
 * Discard to leave the fewest caught points (in the given mode); go out if a
 * discard allows it. Among equally point-minimizing discards, shed the
 * highest-value card so the hand we keep stays cheap if the round ends before
 * our next turn. rng breaks remaining ties.
 */
function greedyDiscard(state, rng, mode) {
  const me = state.turn;
  const hand = state.hands[me];
  const wr = state.wildRank;
  const { outs, best } = candidateDiscards(hand, wr, mode);
  if (outs.length) {
    return discardAction(me, outs[Math.min(outs.length - 1, Math.floor(rng() * outs.length))]);
  }
  const scores = best.map(c => -cardPoints(c, wr));
  return discardAction(me, pickMin(best, scores, rng));
}

// ---------------------------------------------------------------------------
// Fallible greedy (easy + medium): the greedy policy with a per-turn chance of
// a sub-optimal move. Mistakes stay meld-building (so rounds still terminate)
// and never decline an available go-out (so play never looks absurd).
// ---------------------------------------------------------------------------

function fallibleAction(state, rng, missRate) {
  const me = state.turn;
  const wr = state.wildRank;
  if (state.phase === 'draw') {
    // Mistake: draw the hidden stock even when the face-up discard would help.
    if (rng() < missRate) return drawOptions(state).stock || greedyDraw(state, 'normal');
    return greedyDraw(state, 'normal');
  }
  const hand = state.hands[me];
  const outs = goOutDiscards(hand, wr, bestArrangement(hand, wr, 'normal').points);
  if (outs.length) {
    return discardAction(me, outs[Math.min(outs.length - 1, Math.floor(rng() * outs.length))]);
  }
  // Mistake: shed a RANDOM unmelded card instead of the point-minimizing one,
  // so the player tends to get caught holding more points. Restricted to
  // deadwood so it never breaks its own melds.
  if (rng() < missRate) {
    const dead = bestArrangement(hand, wr, 'normal').deadwood;
    const pool = dead.length ? dead : hand;
    return discardAction(me, pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))]);
  }
  return greedyDiscard(state, rng, 'normal');
}

// ---------------------------------------------------------------------------
// Hard (medium + card counting, defense, go-out planning, hard-mode awareness)
// ---------------------------------------------------------------------------

const MEM = new WeakMap();

function getMem(state, seat) {
  let seats = MEM.get(state);
  if (!seats) {
    seats = [null, null];
    MEM.set(state, seats);
  }
  let m = seats[seat];
  if (!m || m.roundIndex !== state.roundIndex) {
    m = { roundIndex: state.roundIndex, lastPile: null, oppTaken: [] };
    seats[seat] = m;
  }
  return m;
}

/**
 * Infer what the opponent did from the discard-pile delta since our last
 * discard. mem.lastPile is the pile right after our own discard (top = our
 * discard X). Before our next draw the possibilities are:
 *   - opponent drew stock:            pile = lastPile + [Y]
 *   - opponent took X, discarded Y:   pile = lastPile[0..-2] + [Y]   (took X)
 *   - opponent took X, re-discarded X: pile = lastPile               (no info)
 *   - stock reshuffle on their draw:  pile = [X, Y]
 * Anything else yields no inference. Uses only the public discard pile.
 */
function reconcile(mem, pile) {
  const prev = mem.lastPile;
  mem.lastPile = null;
  if (!prev || prev.length === 0) return;
  const n = prev.length;
  const top = prev[n - 1];
  const prefixEq = k => {
    for (let i = 0; i < k; i++) if (pile[i] !== prev[i]) return false;
    return true;
  };
  if (pile.length === n + 1 && prefixEq(n)) return; // opponent drew stock
  if (pile.length === n && prefixEq(n)) return; // took X, re-discarded X
  if (pile.length === n && prefixEq(n - 1) && pile[n - 1] !== top) {
    mem.oppTaken.push(top); // took our discard and kept it
    return;
  }
  if (pile.length === 2 && pile[0] === top) return; // stock reshuffle
}

/** Severity of discarding a card near the opponent's observed pile picks. */
function dangerPenalty(card, oppTaken) {
  for (const t of oppTaken) {
    if (rank(card) === rank(t)) return DANGER;
    if (suit(card) === suit(t) && Math.abs(rank(card) - rank(t)) <= 2) return DANGER;
  }
  return 0;
}

function hardDiscard(state, rng, mem, finalTurn, gameMode) {
  const me = state.turn;
  const hand = state.hands[me];
  const wr = state.wildRank;
  // During play, always minimize the NORMAL score: every meld (even a sub-meld
  // that doesn't yet fit the round shape) is progress toward going out, which
  // scores zero in either mode. Strict-shape scoring only matters once we're
  // caught, so switch to the real game mode on the final turn — a genuine edge
  // in hard-mode games, where medium keeps minimizing the wrong objective.
  const scoreMode = finalTurn ? gameMode : 'normal';
  const { outs, best } = candidateDiscards(hand, wr, scoreMode);
  if (outs.length) {
    return discardAction(me, outs[Math.min(outs.length - 1, Math.floor(rng() * outs.length))]);
  }
  // Every candidate already leaves the same minimal caught points. Shed the
  // highest-value card first (keeps the future hand cheap); defense is only a
  // LAST tie-break among cards of equal value, so it can never make us hold a
  // more expensive card — provably non-harmful, and it denies the opponent a
  // card near one we've observed them take from the pile.
  const scores = best.map(c => {
    let s = -cardPoints(c, wr) * 1000; // dominant: shed the highest-value card
    if (!finalTurn) s += dangerPenalty(c, mem.oppTaken);
    return s;
  });
  return discardAction(me, pickMin(best, scores, rng));
}

function hardAction(state, rng) {
  const me = state.turn;
  const mem = getMem(state, me);
  const gameMode = state.config && state.config.mode === 'hard' ? 'hard' : 'normal';
  const finalTurn = state.wentOut !== null && state.wentOut !== me;
  if (state.phase === 'draw') {
    reconcile(mem, state.discard);
    return greedyDraw(state, 'normal'); // build toward going out (mode-independent)
  }
  const action = hardDiscard(state, rng, mem, finalTurn, gameMode);
  mem.lastPile = [...state.discard, action.card]; // the pile as it will be after us
  return action;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decide the current player's next action for the state's phase
 * ('draw' -> a draw action, 'discard' -> a discard action; 'roundEnd' ->
 * acknowledge). Never returns an illegal action. Uses rng for tie-breaking.
 * @param {'easy'|'medium'|'hard'} level
 * @param {object} state - full game state; the AI reads only its own hand and
 *   public information (discard pile, counts, round info).
 * @param {() => number} rng - returns floats in [0, 1)
 * @returns {object} a legal action for the current state
 */
export function chooseAction(level, state, rng) {
  const rand = typeof rng === 'function' ? rng : () => 0.5;
  if (state.phase === 'roundEnd') return { type: 'nextRound' };
  if (state.phase !== 'draw' && state.phase !== 'discard') {
    throw new Error(`chooseAction: no decisions in phase '${state.phase}'`);
  }
  let action;
  if (level === 'easy') {
    action = fallibleAction(state, rand, MISS_EASY);
  } else if (level === 'medium') {
    action = fallibleAction(state, rand, MISS_MEDIUM);
  } else if (level === 'hard') {
    action = hardAction(state, rand);
  } else {
    throw new Error(`Unknown AI level: ${level}`);
  }
  return ensureLegal(state, action, rand);
}
