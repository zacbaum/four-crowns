/**
 * AI opponents for Four Crowns.
 *
 * Public API (docs/ARCHITECTURE.md):
 *   chooseAction(level, state, rng) -> action
 *
 * Design (empirically calibrated by seat-balanced self-play — see
 * tests/ai.test.mjs). The shared foundation is greedy point-minimisation: in a
 * two-player go-out race, minimising the points you can be caught holding is
 * close to optimal.
 *
 *   easy   - the greedy player, but ~20% of turns it plays a sub-optimal move
 *            (draws the wrong pile, or sheds a random deadwood card). Never
 *            breaks its own sets and never declines an available go-out, so it
 *            stays sensible while being beatable.
 *   medium - the clean greedy player: point-minimising, goes out the instant it
 *            can, correct end-game (strict-shape) scoring in hard-mode games,
 *            and a non-harmful defensive tie-break (avoids feeding cards near
 *            ones it has seen the opponent take).
 *   hard   - an expert layered on the greedy core: WILDS ARE PROTECTED (never
 *            dumped just to save points); draws and keeps are gated by CARD
 *            COUNTING so it never chases a book/run whose cards are already
 *            gone; it favours books over runs, dumps high singles, and shifts
 *            with the round — early rounds chase the go-out (keep even high
 *            pairs, take tail risk), late rounds shed points. It also tracks
 *            what the opponent picks up and puts down, and avoids feeding cards
 *            near what they've taken. Wilds are never locked to a set —
 *            bestArrangement re-optimises their use every turn.
 *
 * Measured decided win rates (seat-balanced): medium beats easy and hard beats
 * medium, both comfortably (see tests/ai.test.mjs for the asserted floors).
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

import { rank, suit, cardPoints, isWild, makeCard } from '../engine/cards.js';
import { bestArrangement } from '../engine/solver.js';
import { legalActions } from '../engine/game.js';

const ENV = typeof process !== 'undefined' && process.env ? process.env : {};
// easy/medium share one greedy policy; easy plays a fraction of turns
// sub-optimally. medium is the clean greedy player (no mistakes). hard is the
// expert policy below. (All ordering calibrated by seat-balanced self-play;
// see the AI tests.)
const MISS_EASY = Number(ENV.FC_ME ?? 0.2);
const DANGER = Number(ENV.FC_D ?? 1); // medium: severity of feeding an observed opponent pick

// ---- Expert (hard) tuning — calibrated by self-play ----
const B_BOOK = Number(ENV.FC_BB ?? 4);   // keep-incentive for a live book pair
const B_RUN = Number(ENV.FC_BR ?? 2);    // keep-incentive for a live run pair (books favoured)
const PH_EARLY = Number(ENV.FC_PE ?? 0.8); // rounds 3-6: chase the go-out (more tail risk)
const PH_MID = Number(ENV.FC_PM ?? 0.5);
const PH_LATE = Number(ENV.FC_PL ?? 0.25); // rounds J-K: shed points, dump high singles
const DEF = Number(ENV.FC_DEF ?? 2);       // expert: weight of not feeding the opponent
const TAKE_EPS = Number(ENV.FC_TE ?? 0.5); // min expert-value gain to take the discard

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
    m = {
      roundIndex: state.roundIndex,
      lastPile: null,
      oppTaken: [],       // cards the opponent drew from the pile (they hold them)
      oppDiscarded: [],   // cards the opponent has put down
      seen: new Set(),    // every card that's passed through the discard pile
    };
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
  for (const c of pile) mem.seen.add(c); // accumulate everything ever seen face-up
  const prev = mem.lastPile;
  mem.lastPile = null;
  if (!prev || prev.length === 0) return;
  const n = prev.length;
  const top = prev[n - 1];
  const prefixEq = k => {
    for (let i = 0; i < k; i++) if (pile[i] !== prev[i]) return false;
    return true;
  };
  if (pile.length === n + 1 && prefixEq(n)) { mem.oppDiscarded.push(pile[n]); return; } // drew stock, discarded pile[n]
  if (pile.length === n && prefixEq(n)) return; // took X, re-discarded X
  if (pile.length === n && prefixEq(n - 1) && pile[n - 1] !== top) {
    mem.oppTaken.push(top);            // took our discard X and kept it
    mem.oppDiscarded.push(pile[n - 1]); // ...and discarded pile[n-1]
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
// Expert (hard): greedy point-minimisation, but wilds are protected (never
// dumped to save points), draws/keeps are gated by card-counting so it never
// chases a dead book/run, and the keep/dump balance shifts with the round —
// early rounds chase the go-out (keep even high pairs), late rounds shed
// points (dump high singles). Books are favoured over runs. Wilds stay
// flexible: bestArrangement re-optimises their use every turn, nothing is
// locked in.
// ---------------------------------------------------------------------------

function phaseMult(roundIndex) {
  if (roundIndex <= 2) return PH_EARLY; // 3s, 4s, 6s
  if (roundIndex >= 7) return PH_LATE;  // Js, Qs, Ks
  return PH_MID;
}

/** Cards that can no longer be drawn from the stock (seen + held + opp's). */
function unavailable(state, mem) {
  const u = new Set(mem.seen);
  for (const c of state.discard) u.add(c);
  for (const c of state.hands[state.turn]) u.add(c);
  for (const c of mem.oppTaken) u.add(c);
  return u;
}

/**
 * Keep-incentive for the live near-books/near-runs among a hand's deadwood.
 * A partial only earns its incentive if at least one completing card is still
 * live (card-counting) — so a pair whose other cards are all gone earns
 * nothing and gets dumped. Books earn more than runs (more ways to finish).
 * Scaled by the round phase. Each card joins at most one partial (best first).
 */
function partialBonus(deadwood, wr, mult, u) {
  const nat = deadwood.filter((c) => !isWild(c, wr));
  const cand = [];
  for (let i = 0; i < nat.length; i++) {
    for (let j = i + 1; j < nat.length; j++) {
      const a = nat[i];
      const b = nat[j];
      let outs = 0;
      let base = 0;
      if (rank(a) === rank(b)) {
        base = B_BOOK;
        for (let s = 0; s < 4; s++) {
          const c = makeCard(rank(a), s);
          if (s !== suit(a) && s !== suit(b) && !u.has(c)) outs++;
        }
      } else if (suit(a) === suit(b) && Math.abs(rank(a) - rank(b)) <= 2) {
        base = B_RUN;
        const lo = Math.min(rank(a), rank(b));
        const hi = Math.max(rank(a), rank(b));
        const wants = hi - lo === 2 ? [lo + 1] : [lo - 1, hi + 1];
        for (const r of wants) {
          if (r >= 1 && r <= 13 && !u.has(makeCard(r, suit(a)))) outs++;
        }
      } else {
        continue;
      }
      if (outs > 0) cand.push({ i, j, val: base });
    }
  }
  cand.sort((x, y) => y.val - x.val);
  const used = new Set();
  let sum = 0;
  for (const p of cand) {
    if (used.has(p.i) || used.has(p.j)) continue;
    used.add(p.i); used.add(p.j);
    sum += p.val;
  }
  return sum * mult;
}

/**
 * Expert value of a kept hand (lower = better): its normal-mode caught points
 * with unmelded WILDS treated as free (never worth shedding), minus the
 * keep-incentive of any live partials it still holds.
 */
function expertValue(hand, wr, mult, u) {
  const arr = bestArrangement(hand, wr, 'normal');
  let pts = arr.points;
  for (const c of arr.deadwood) if (isWild(c, wr)) pts -= cardPoints(c, wr); // wild -> 0
  return pts - partialBonus(arr.deadwood, wr, mult, u);
}

function expertDraw(state, mem) {
  const { stock, disc } = drawOptions(state);
  if (!disc) return stock;
  if (!stock) return disc;
  const hand = state.hands[state.turn];
  const wr = state.wildRank;
  const d = state.discard[state.discard.length - 1];
  const mult = phaseMult(state.roundIndex);
  const u = unavailable(state, mem);
  // Value of standing pat vs the best N-card hand reachable by taking d.
  const keepVal = expertValue(hand, wr, mult, u);
  const withD = [...hand, d];
  let takeVal = Infinity;
  const cands = withD.filter((c) => !isWild(c, wr));
  for (const c of (cands.length ? cands : withD)) {
    const v = expertValue(removeOne(withD, c), wr, mult, u);
    if (v < takeVal) takeVal = v;
  }
  // Take the discard only for a real, card-counting-backed improvement (never
  // to chase a dead combo — that wouldn't lower takeVal).
  return takeVal < keepVal - TAKE_EPS ? disc : stock;
}

function expertDiscard(state, rng, mem, finalTurn, gameMode) {
  const me = state.turn;
  const hand = state.hands[me];
  const wr = state.wildRank;
  const base = bestArrangement(hand, wr, 'normal').points;
  const outs = goOutDiscards(hand, wr, base);
  if (outs.length) {
    return discardAction(me, outs[Math.min(outs.length - 1, Math.floor(rng() * outs.length))]);
  }
  // Final caught turn: no future, so protection is off — minimise the REAL
  // score (dump a wild if it cuts points), mode-aware.
  if (finalTurn) {
    const { best } = candidateDiscards(hand, wr, gameMode);
    const scores = best.map((c) => -cardPoints(c, wr));
    return discardAction(me, pickMin(best, scores, rng));
  }
  const mult = phaseMult(state.roundIndex);
  const u = unavailable(state, mem);
  // Never volunteer a wild while any other card can go.
  let cands = hand.filter((c) => !isWild(c, wr));
  if (!cands.length) cands = hand.slice();
  const scores = cands.map((c) =>
    expertValue(removeOne(hand, c), wr, mult, u) + dangerPenalty(c, mem.oppTaken) * DEF);
  return discardAction(me, pickMin(cands, scores, rng));
}

function expertAction(state, rng) {
  const me = state.turn;
  const mem = getMem(state, me);
  const gameMode = state.config && state.config.mode === 'hard' ? 'hard' : 'normal';
  const finalTurn = state.wentOut !== null && state.wentOut !== me;
  if (state.phase === 'draw') {
    reconcile(mem, state.discard);
    return expertDraw(state, mem);
  }
  reconcile(mem, state.discard); // keep the seen-set current for out-counting
  const action = expertDiscard(state, rng, mem, finalTurn, gameMode);
  mem.lastPile = [...state.discard, action.card];
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
    action = hardAction(state, rand);
  } else if (level === 'hard') {
    action = expertAction(state, rand);
  } else {
    throw new Error(`Unknown AI level: ${level}`);
  }
  return ensureLegal(state, action, rand);
}
