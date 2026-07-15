/**
 * Expert AI ("emax") for Four Crowns — expected-value decision-making with
 * card counting, layered on the same greedy foundations as js/ai/ai.js.
 *
 * Provenance: this is the tournament champion "expectimax-v3" — an
 * expected-value policy (expectimax-v2's decision structure) whose constants
 * were evolved by CEM self-play (21 generations, ~97k games). Measured on
 * held-out mirrored-deal games it beats the 'hard' level 68.3% (normal mode)
 * and 67.8% (hard mode), and averages ~19 fewer points per game. Development
 * history and full benchmarks: tools/ (arena, candidates, results).
 *
 * How it differs from 'hard' (expertAction in ai.js):
 *  - DRAW: compares the exact post-discard value of taking the face-up card
 *    against the EXPECTATION of a stock draw over the unseen cards
 *    (stratified: non-interacting cards in closed form, interacting cards via
 *    exact solver evaluation, rng-sampled under a per-hand-size cap).
 *  - PARTIALS: keep-incentives are probability-weighted — P(complete within
 *    the round's remaining draws) — using a measured per-round expected-turns
 *    table, with unseen WILDS counted as discounted outs.
 *  - DYNAMIC RISK: speculation is scaled down (and feed-caution up) as a round
 *    ages past its expected length and as the opponent visibly takes pile
 *    cards.
 *  - Card counting survives stock reshuffles (reshuffled pile cards become
 *    drawable again).
 *  - Proven invariants shared with 'hard': go-out detection first, wilds
 *    protected (volunteered only via the exact final-turn exception),
 *    mode-aware final-turn scoring.
 *
 * Information hygiene: reads ONLY its own hand, the discard pile, public
 * counters (stock length, turn counts, round info) and state.config.mode.
 * It never reads the opponent's hand or the stock's contents (enforced by
 * the hand-trap test in tests/ai.test.mjs).
 */

import { rank, suit, makeCard, cardPoints, isWild } from '../engine/cards.js';
import { bestArrangement } from '../engine/solver.js';

/**
 * Winner's average turn count per round slot (3s..Ks), measured over 1000
 * tournament games. The 8s round is a long grind (four wilds of rank 8 in
 * 8-card hands, shape {4,4}); Js runs long too.
 */
const TURNS_TABLE = [3.5, 5.8, 5.0, 6.2, 10.5, 5.3, 6.1, 8.4, 5.2, 5.2];

/** CEM-evolved constants (expectimax-v3, 2026-07-15 training run). */
const P = {
  MARGIN: 0.39609315573079834,   // required expected edge to take the face-up card
  GOOUT_VALUE: 10.991103600622637, // value of a reachable go-out
  GO_BONUS: 4.822686837453105,   // completion progress bonus (x goScale)
  RUN_W: 0.8684468733960875,     // run partials worth less than book partials
  WILD_OUT_W: 0.287232566786137, // discount on unseen wilds counted as outs
  WILD_HOLD: 3.460170349880884,  // hold value of a spare (deadwood) wild
  FEED: 0.7434251998660104,      // feed penalty weight (x risk)
  SAFE: 0.22884772210155668,     // credit for ranks the opponent shed
  TURNS_SCALE: 0.6161682029835834, // scale on the measured turns table
  GO_HI: 0.880822662601294,      // go curve: early-round intensity
  GO_LO: 0.19774473871038126,    // go curve: late-round intensity
  GO_CURVE: 0.976985695981974,   // go curve: bend exponent
  RISK_AGE: 1.584355444865531,   // risk growth per unit of round over-age
  RISK_START: 0.8811580891611737, // round age (fraction of expected) where risk starts
  TAKE_RISK: 0.14822900248260976, // risk per observed opponent pile take
};

/* ---------------------------------------------------------------------------
 * Utilities
 * ------------------------------------------------------------------------ */

function removeOne(hand, card) {
  const out = hand.slice();
  out.splice(out.indexOf(card), 1);
  return out;
}

function pickMinRng(cands, scores, rng) {
  let best = Infinity;
  for (const s of scores) if (s < best) best = s;
  const tied = [];
  for (let i = 0; i < cands.length; i++) if (scores[i] <= best + 1e-9) tied.push(cands[i]);
  return tied[Math.min(tied.length - 1, Math.floor(rng() * tied.length))];
}

/** Sample k distinct elements (partial Fisher-Yates, rng-driven). */
function sampleK(arr, k, rng) {
  const a = arr.slice();
  const out = [];
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (a.length - i));
    const t = a[i]; a[i] = a[j]; a[j] = t;
    out.push(a[i]);
  }
  return out;
}

/** Cap on exact solver evaluations for the stock expectation, by hand size. */
function sampleCap(handSize) {
  if (handSize <= 8) return 40;
  if (handSize === 9) return 20;
  if (handSize === 10) return 16;
  return 12;
}

/* ---------------------------------------------------------------------------
 * Round model: expected turns, go intensity, dynamic risk
 * ------------------------------------------------------------------------ */

function expTurns(roundIndex) {
  return P.TURNS_SCALE * TURNS_TABLE[roundIndex];
}

/** Smooth go-out intensity over the game: GO_HI early bending to GO_LO late. */
function goScaleOf(roundIndex) {
  const t = Math.pow(roundIndex / 9, P.GO_CURVE);
  return P.GO_HI - (P.GO_HI - P.GO_LO) * t;
}

/**
 * Risk factor >= 1: rises once the round ages past RISK_START of its expected
 * length, and with each observed opponent pile take. Divides speculation,
 * multiplies feed caution.
 */
function riskOf(state, mem, exp) {
  const age = (state.turnsThisRound / 2) / Math.max(1, exp);
  return 1 +
    P.RISK_AGE * Math.max(0, age - P.RISK_START) +
    P.TAKE_RISK * Math.min(mem.oppTaken.length, 4);
}

/* ---------------------------------------------------------------------------
 * Per-round memory + opponent inference from the public discard pile.
 * Keyed per (state, seat) like ai.js's MEM so replays and both-seats-AI work.
 * ------------------------------------------------------------------------ */

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
      lastPile: null,     // pile right after our own discard
      oppTaken: [],       // cards the opponent drew from the pile (they hold them)
      oppDiscarded: [],   // cards the opponent has put down
      seen: new Set(),    // cards currently unavailable to draw (pile history)
    };
    seats[seat] = m;
  }
  return m;
}

function reconcile(mem, pile) {
  for (const c of pile) mem.seen.add(c);
  const prev = mem.lastPile;
  mem.lastPile = null;
  if (!prev || prev.length === 0) return;
  const n = prev.length;
  const top = prev[n - 1];
  const prefixEq = (k) => {
    for (let i = 0; i < k; i++) if (pile[i] !== prev[i]) return false;
    return true;
  };
  if (pile.length === n + 1 && prefixEq(n)) { mem.oppDiscarded.push(pile[n]); return; }
  if (pile.length === n && prefixEq(n)) return; // took our X, re-discarded X
  if (pile.length === n && prefixEq(n - 1) && pile[n - 1] !== top) {
    mem.oppTaken.push(top);
    mem.oppDiscarded.push(pile[n - 1]);
    return;
  }
  if (pile.length === 2 && pile[0] === top) {
    // Opponent's stock draw reshuffled the pile: everything except `top` went
    // back into the stock and is drawable again. Opponent-held cards stay out.
    mem.oppDiscarded.push(pile[1]);
    mem.seen = new Set(pile);
    for (const c of mem.oppTaken) mem.seen.add(c);
  }
}

/** Card ids (0..51) that could still be drawn from the stock, from our view. */
function unseenList(state, mem) {
  const excl = new Set(mem.seen);
  for (const c of state.discard) excl.add(c);
  for (const c of state.hands[state.turn]) excl.add(c);
  const out = [];
  for (let c = 0; c < 52; c++) if (!excl.has(c)) out.push(c);
  return out;
}

/* ---------------------------------------------------------------------------
 * Probability-weighted partial (near-meld) valuation
 * ------------------------------------------------------------------------ */

function bookOuts(a, b, unseenSet) {
  const r = rank(a);
  let outs = 0;
  for (let s = 0; s < 4; s++) {
    const c = makeCard(r, s);
    if (c !== a && c !== b && unseenSet.has(c)) outs++;
  }
  return outs;
}

/** Are a,b a same-suit near-run window (so a wild could complete them)? */
function runAdjacent(a, b) {
  if (suit(a) !== suit(b)) return false;
  const d = Math.abs(rank(a) - rank(b));
  if (d >= 1 && d <= 2) return true;
  if (rank(a) === 1 || rank(b) === 1) {
    const x = rank(a) === 1 ? 14 : rank(a);
    const y = rank(b) === 1 ? 14 : rank(b);
    const dh = Math.abs(x - y);
    return dh >= 1 && dh <= 2;
  }
  return false;
}

function runOuts(a, b, unseenSet) {
  if (suit(a) !== suit(b)) return 0;
  const s = suit(a);
  const variants = [[rank(a), rank(b)]];
  if (rank(a) === 1) variants.push([14, rank(b)]); // ace plays high too
  if (rank(b) === 1) variants.push([rank(a), 14]);
  let best = 0;
  for (const [x, y] of variants) {
    const lo = Math.min(x, y);
    const hi = Math.max(x, y);
    const gap = hi - lo;
    if (gap < 1 || gap > 2) continue;
    const wants = gap === 2 ? [lo + 1] : [lo - 1, hi + 1];
    let outs = 0;
    for (let r of wants) {
      if (r === 14) r = 1; // ace-high extension of a ...K window
      if (r < 1 || r > 13) continue;
      if (unseenSet.has(makeCard(r, s))) outs++;
    }
    if (outs > best) best = outs;
  }
  return best;
}

/**
 * Expected value of live partials among natural deadwood, divided by the
 * round's risk factor. Each card joins at most one partial (best first).
 */
function partialBonus(natDw, wr, ctx) {
  if (ctx.T <= 0 || natDw.length < 2 || ctx.U <= 0) return 0;
  let wildOuts = 0;
  for (let s = 0; s < 4; s++) if (ctx.unseenSet.has(makeCard(wr, s))) wildOuts++;
  wildOuts *= P.WILD_OUT_W;
  const cand = [];
  for (let i = 0; i < natDw.length; i++) {
    for (let j = i + 1; j < natDw.length; j++) {
      const a = natDw[i];
      const b = natDw[j];
      const isBook = rank(a) === rank(b);
      const isRunP = !isBook && runAdjacent(a, b);
      if (!isBook && !isRunP) continue;
      const total = (isBook ? bookOuts(a, b, ctx.unseenSet) : runOuts(a, b, ctx.unseenSet)) + wildOuts;
      if (total <= 0) continue;
      const p = 1 - Math.pow(1 - Math.min(1, total / ctx.U), ctx.T);
      let val = p * (cardPoints(a, wr) + cardPoints(b, wr) + P.GO_BONUS * ctx.goScale);
      if (isRunP) val *= P.RUN_W;
      cand.push({ i, j, val });
    }
  }
  if (!cand.length) return 0;
  cand.sort((x, y) => y.val - x.val);
  const used = new Set();
  let sum = 0;
  for (const c of cand) {
    if (used.has(c.i) || used.has(c.j)) continue;
    used.add(c.i);
    used.add(c.j);
    sum += c.val;
  }
  return sum / ctx.risk;
}

/* ---------------------------------------------------------------------------
 * Hand valuation (lower = better)
 * ------------------------------------------------------------------------ */

function keptValue(kept, wr, ctx) {
  const arr = bestArrangement(kept, wr, 'normal');
  let natPts = 0;
  let wildDw = 0;
  const natDw = [];
  for (const c of arr.deadwood) {
    if (isWild(c, wr)) wildDw++;
    else { natPts += cardPoints(c, wr); natDw.push(c); }
  }
  return natPts - partialBonus(natDw, wr, ctx) - P.WILD_HOLD * wildDw;
}

/**
 * Approximate value of drawing card `u` into `hand` and then discarding
 * optimally (shed restricted to the arrangement's deadwood; the same
 * approximation applies to both sides of every comparison). One solver call.
 */
function postDrawValue(hand, u, wr, ctx) {
  const h2 = [...hand, u];
  const arr = bestArrangement(h2, wr, ctx.scoreMode);
  const dw = arr.deadwood;
  if (arr.points === 0) {
    if (ctx.finalTurn) return 0;
    // fully melded N+1 cards: a 4-meld means discarding from it goes out
    return arr.melds.some((m) => m.length === 4) ? -P.GOOUT_VALUE : 0;
  }
  if (dw.length === 1) return ctx.finalTurn ? 0 : -P.GOOUT_VALUE; // shed it -> out / 0
  if (ctx.finalTurn) {
    let mx = 0;
    for (const c of dw) { const p = cardPoints(c, wr); if (p > mx) mx = p; }
    return arr.points - mx; // exact achievable caught points (mode-aware arr)
  }
  let natPts = 0;
  let wildDw = 0;
  const natDw = [];
  for (const c of dw) {
    if (isWild(c, wr)) wildDw++;
    else { natPts += cardPoints(c, wr); natDw.push(c); }
  }
  if (natDw.length === 0) return -P.WILD_HOLD * Math.max(0, wildDw - 1);
  let best = Infinity;
  for (let k = 0; k < natDw.length; k++) {
    const rest = natDw.slice(0, k).concat(natDw.slice(k + 1));
    const v = natPts - cardPoints(natDw[k], wr) - partialBonus(rest, wr, ctx);
    if (v < best) best = v;
  }
  return best - P.WILD_HOLD * wildDw;
}

/** Could drawing `u` change the hand's meld structure at all? */
function isRelevant(u, hand, wr, wildDwCount) {
  if (rank(u) === wr) return true; // a wild always interacts
  if (wildDwCount >= 2) return true; // two spare wilds meld with ANY card
  const ru = rank(u);
  const su = suit(u);
  const radius = wildDwCount >= 1 ? 3 : 2;
  for (const c of hand) {
    const rc = rank(c);
    if (rc === ru) return true;
    if (suit(c) === su) {
      let d = Math.abs(rc - ru);
      if (ru === 1) d = Math.min(d, Math.abs(rc - 14));
      if (rc === 1) d = Math.min(d, Math.abs(14 - ru));
      if (d <= radius) return true;
    }
  }
  return false;
}

/**
 * Expected post-discard value of drawing uniformly from `pool`. Interacting
 * cards get exact postDrawValue (rng-sampled beyond `cap`); non-interacting
 * cards are valued in closed form from the current arrangement.
 */
function drawExpectation(pool, hand, wr, ctx, rng, cap) {
  const base = bestArrangement(hand, wr, ctx.scoreMode);
  let wildDw = 0;
  for (const c of base.deadwood) if (isWild(c, wr)) wildDw++;
  let piece;
  if (ctx.finalTurn) {
    let mx = 0;
    for (const c of base.deadwood) { const p = cardPoints(c, wr); if (p > mx) mx = p; }
    piece = { finalPts: base.points, finalMax: mx };
  } else {
    let natPts = 0;
    const natDw = [];
    for (const c of base.deadwood) {
      if (!isWild(c, wr)) { natPts += cardPoints(c, wr); natDw.push(c); }
    }
    const V0 = natPts - partialBonus(natDw, wr, ctx); // shed the drawn card back
    let C = Infinity; // best "swap": shed deadwood card k, keep the drawn card
    for (let k = 0; k < natDw.length; k++) {
      const rest = natDw.slice(0, k).concat(natDw.slice(k + 1));
      const v = natPts - cardPoints(natDw[k], wr) - partialBonus(rest, wr, ctx);
      if (v < C) C = v;
    }
    piece = { V0, C };
  }
  const relevant = [];
  let irrSum = 0;
  let irrN = 0;
  for (const u of pool) {
    if (isRelevant(u, hand, wr, wildDw)) { relevant.push(u); continue; }
    const p = cardPoints(u, wr); // u is never wild here
    irrSum += ctx.finalTurn
      ? piece.finalPts + p - Math.max(piece.finalMax, p)
      : Math.min(piece.V0, piece.C + p) - P.WILD_HOLD * wildDw;
    irrN++;
  }
  let relTotal = 0;
  const relN = relevant.length;
  if (relN) {
    const sample = relN <= cap ? relevant : sampleK(relevant, cap, rng);
    let s = 0;
    for (const u of sample) s += postDrawValue(hand, u, wr, ctx);
    relTotal = (s / sample.length) * relN;
  }
  const total = irrN + relN;
  return total ? (irrSum + relTotal) / total : Infinity;
}

/* ---------------------------------------------------------------------------
 * Defense: feeding the opponent
 * ------------------------------------------------------------------------ */

function feedPenalty(card, mem) {
  let danger = 0;
  const r = rank(card);
  const s = suit(card);
  for (const t of mem.oppTaken) {
    if (rank(t) === r) { danger = 1; break; }
    if (suit(t) === s) {
      const d = Math.abs(rank(t) - r);
      if (d === 1) { danger = 1; break; }
      if (d === 2 && danger < 0.6) danger = 0.6;
    }
  }
  let safe = 0;
  for (const t of mem.oppDiscarded) {
    if (rank(t) === r) { safe = 1; break; }
  }
  return P.FEED * danger - P.SAFE * safe;
}

/* ---------------------------------------------------------------------------
 * Decisions
 * ------------------------------------------------------------------------ */

function makeCtx(state, mem, unseenSet, scoreMode, finalTurn) {
  const exp = expTurns(state.roundIndex);
  const myTurns = state.turnsThisRound / 2;
  return {
    scoreMode, finalTurn, unseenSet,
    U: Math.max(1, unseenSet.size),
    T: finalTurn ? 0 : Math.max(0.5, Math.min(12, exp - myTurns)),
    goScale: goScaleOf(state.roundIndex),
    risk: riskOf(state, mem, exp),
  };
}

function decideDraw(state, mem, rng) {
  const me = state.turn;
  const hand = state.hands[me];
  const wr = state.wildRank;
  const stockAct = { type: 'draw', player: me, source: 'stock' };
  const discAct = { type: 'draw', player: me, source: 'discard' };
  const stockLegal = state.stock.length > 0 || state.discard.length > 1;
  if (state.discard.length === 0) return stockAct;
  if (!stockLegal) return discAct;

  const d = state.discard[state.discard.length - 1];
  const finalTurn = state.wentOut !== null && state.wentOut !== me;
  const gameMode = state.config && state.config.mode === 'hard' ? 'hard' : 'normal';
  const scoreMode = finalTurn ? gameMode : 'normal';

  // Forced take 1: the face-up card enables an immediate go-out.
  const h2 = [...hand, d];
  const arrTake = bestArrangement(h2, wr, 'normal');
  if (arrTake.points <= 25) {
    for (const c of h2) {
      if (cardPoints(c, wr) < arrTake.points) continue;
      if (bestArrangement(removeOne(h2, c), wr, 'normal').points === 0) return discAct;
    }
  }
  // Forced take 2: a face-up wild during play (denies the opponent a wild).
  if (!finalTurn && isWild(d, wr)) return discAct;

  const unseen = unseenList(state, mem);
  let pool = unseen;
  const unseenSet = new Set(unseen);
  if (state.stock.length === 0) {
    // A stock draw would reshuffle the pile minus its top: the draw pool is
    // KNOWN exactly, and those cards become available as future outs too.
    pool = state.discard.slice(0, -1);
    for (const c of pool) unseenSet.add(c);
  }
  const ctx = makeCtx(state, mem, unseenSet, scoreMode, finalTurn);
  const takeVal = postDrawValue(hand, d, wr, ctx);
  let action;
  if (pool.length === 0) {
    action = stockAct;
  } else {
    const stockE = drawExpectation(pool, hand, wr, ctx, rng, sampleCap(state.handSize));
    action = takeVal < stockE - P.MARGIN ? discAct : stockAct;
  }
  if (action === stockAct && state.stock.length === 0) {
    // Our stock draw reshuffles the pile minus its top into a fresh stock.
    mem.seen = new Set([state.discard[state.discard.length - 1]]);
    for (const c of mem.oppTaken) mem.seen.add(c);
  }
  return action;
}

function decideDiscard(state, mem, rng) {
  const me = state.turn;
  const hand = state.hands[me];
  const wr = state.wildRank;
  const finalTurn = state.wentOut !== null && state.wentOut !== me;
  const gameMode = state.config && state.config.mode === 'hard' ? 'hard' : 'normal';
  const finish = (card) => {
    mem.lastPile = [...state.discard, card];
    return { type: 'discard', player: me, card };
  };

  // 1) Go out whenever possible (mode-independent).
  const base = bestArrangement(hand, wr, 'normal').points;
  if (base <= 25) {
    const outs = [];
    for (const c of hand) {
      if (cardPoints(c, wr) < base) continue;
      if (bestArrangement(removeOne(hand, c), wr, 'normal').points === 0) outs.push(c);
    }
    if (outs.length) {
      return finish(outs[Math.min(outs.length - 1, Math.floor(rng() * outs.length))]);
    }
  }

  // 2) Final caught turn: minimize the REAL mode-aware score exactly. A wild
  // is volunteered ONLY if no non-wild discard reaches as few points.
  if (finalTurn) {
    const ptsOf = (c) => bestArrangement(removeOne(hand, c), wr, gameMode).points;
    const wilds = hand.filter((c) => isWild(c, wr));
    const nonWild = hand.filter((c) => !isWild(c, wr));
    if (!nonWild.length) {
      return finish(hand[Math.min(hand.length - 1, Math.floor(rng() * hand.length))]);
    }
    let bestNW = Infinity;
    const nwPts = nonWild.map((c) => { const p = ptsOf(c); if (p < bestNW) bestNW = p; return p; });
    let bestW = Infinity;
    let bestWCard = null;
    for (const c of wilds) { const p = ptsOf(c); if (p < bestW) { bestW = p; bestWCard = c; } }
    if (wilds.length && bestW < bestNW - 1e-9) return finish(bestWCard);
    const tied = nonWild.filter((c, i) => nwPts[i] <= bestNW + 1e-9);
    return finish(pickMinRng(tied, tied.map((c) => -cardPoints(c, wr)), rng));
  }

  // 3) Normal play: expected-value discard with risk-scaled feed caution.
  // Never volunteer a wild.
  const unseen = unseenList(state, mem);
  const ctx = makeCtx(state, mem, new Set(unseen), 'normal', false);
  let cands = hand.filter((c) => !isWild(c, wr));
  if (!cands.length) cands = hand.slice();
  const scores = cands.map((c) =>
    keptValue(removeOne(hand, c), wr, ctx) +
    feedPenalty(c, mem) * ctx.risk -
    cardPoints(c, wr) * 0.001); // tie-break: shed the higher card
  return finish(pickMinRng(cands, scores, rng));
}

/**
 * Decide the current player's action ('draw' or 'discard' phase).
 * Same contract as the policies in js/ai/ai.js; ai.js routes the 'expert'
 * level here and applies its own legality fallback.
 */
export function emaxAction(state, rng) {
  const mem = getMem(state, state.turn);
  reconcile(mem, state.discard);
  if (state.phase === 'draw') return decideDraw(state, mem, rng);
  return decideDiscard(state, mem, rng);
}
