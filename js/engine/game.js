/**
 * Four Crowns game engine: deterministic, pure, serializable state.
 *
 * Reducer style: applyAction(state, action) mutates state in place and returns
 * it; callers treat the return value as canonical. Randomness comes ONLY from
 * the seeded mulberry32 rng whose state lives in state.rngState, so host and
 * guest replay identically from the same seed + action sequence.
 */

import { ROUNDS, shuffled } from './cards.js';
import { bestArrangement, canGoOut } from './solver.js';

/**
 * Safety backstop: a round ends only when a player goes out (see RULES.md), so
 * two players who can never complete a go-out would cycle the deck forever. No
 * real round lasts anywhere near this many discards (~30-40 is typical; this is
 * ~10 full deck cycles); if it is ever reached, nobody went out and both hands
 * are scored as caught. This can only fire in pathological/degenerate play and
 * never alters a normally-ending round.
 */
const ROUND_TURN_CAP = 500;

/** Advance the state's mulberry32 rng and return a float in [0, 1). */
function nextRand(state) {
  state.rngState = (state.rngState + 0x6D2B79F5) | 0;
  let t = state.rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t = t ^ (t + Math.imul(t ^ (t >>> 7), t | 61));
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Shuffle a fresh 52-card deck and deal the current round into state. */
function deal(state) {
  const n = ROUNDS[state.roundIndex];
  state.handSize = n;
  state.wildRank = n;
  state.dealer = state.roundIndex % 2;
  const deck = [];
  for (let c = 0; c < 52; c++) deck.push(c);
  state.stock = shuffled(deck, () => nextRand(state)); // top = last element
  state.hands = [[], []];
  const nonDealer = 1 - state.dealer;
  for (let i = 0; i < n; i++) {
    state.hands[nonDealer].push(state.stock.pop());
    state.hands[state.dealer].push(state.stock.pop());
  }
  state.discard = [state.stock.pop()];
  state.turn = nonDealer;
  state.phase = 'draw';
  state.wentOut = null;
  state.lastTurnFor = null;
  state.turnsThisRound = 0;
  state.wentOutOnTurn = null;
  balanceDeal(state);
}

/**
 * Optional deal balancing (config.balance = a seat index): after both hands
 * are dealt — and before either is revealed — the balanced seat is given
 * whichever of the two dealt hands has the lower opening deadwood, swapping
 * the two hands if needed. Pure function of the dealt cards (no rng, so
 * networked peers stay byte-identical) and the 52-card invariant is untouched
 * — it only decides which player holds which of the two hands already dealt.
 */
function balanceDeal(state) {
  const seat = state.config.balance;
  if (seat !== 0 && seat !== 1) return;
  const opp = 1 - seat;
  const mode = state.config.mode;
  const minePts = bestArrangement(state.hands[seat], state.wildRank, mode).points;
  const oppPts = bestArrangement(state.hands[opp], state.wildRank, mode).points;
  if (oppPts < minePts) {
    const tmp = state.hands[seat];
    state.hands[seat] = state.hands[opp];
    state.hands[opp] = tmp;
  }
}

/**
 * Create a new game and deal round 0.
 * @param {{ mode: 'normal'|'hard', seed: number, players: [{name: string}, {name: string}] }} config
 * @returns {object} state (see docs/ARCHITECTURE.md "State shape")
 */
export function createGame(config) {
  const state = {
    config,
    roundIndex: 0,
    handSize: 0,
    wildRank: 0,
    dealer: 0,
    turn: 0,
    phase: 'draw',
    hands: [[], []],
    stock: [],
    discard: [],
    wentOut: null,
    lastTurnFor: null,
    turnsThisRound: 0,
    wentOutOnTurn: null,
    roundResults: [],
    totals: [0, 0],
    rngState: config.seed | 0,
    winner: null,
  };
  deal(state);
  return state;
}

function doDraw(state, action) {
  if (state.phase !== 'draw') throw new Error(`Illegal draw: phase is '${state.phase}'`);
  if (action.player !== state.turn) throw new Error(`Illegal draw: not player ${action.player}'s turn`);
  let card;
  if (action.source === 'stock') {
    if (state.stock.length === 0) {
      // Stock exhausted: reshuffle the discard pile minus its top card.
      const top = state.discard.pop();
      state.stock = shuffled(state.discard, () => nextRand(state));
      state.discard = [top];
    }
    if (state.stock.length === 0) throw new Error('Illegal draw: no cards available in stock');
    card = state.stock.pop();
  } else if (action.source === 'discard') {
    if (state.discard.length === 0) throw new Error('Illegal draw: discard pile is empty');
    card = state.discard.pop();
  } else {
    throw new Error(`Illegal draw: unknown source '${action.source}'`);
  }
  state.hands[state.turn].push(card);
  state.phase = 'discard';
  return state;
}

function doDiscard(state, action) {
  if (state.phase !== 'discard') throw new Error(`Illegal discard: phase is '${state.phase}'`);
  if (action.player !== state.turn) throw new Error(`Illegal discard: not player ${action.player}'s turn`);
  const hand = state.hands[state.turn];
  const idx = hand.indexOf(action.card);
  if (idx === -1) throw new Error(`Illegal discard: card ${action.card} not in hand`);
  hand.splice(idx, 1);
  state.discard.push(action.card);
  const player = state.turn;
  state.turnsThisRound += 1;
  if (state.wentOut === null && canGoOut(hand, state.wildRank)) {
    state.wentOut = player;
    state.lastTurnFor = 1 - player;
    // The going-out player's own turn number: discards alternate starting
    // with the non-dealer, so their count is ceil(total/2) whichever seat
    // they sit in (odd totals belong to the first mover, even to the second).
    state.wentOutOnTurn = Math.ceil(state.turnsThisRound / 2);
  }
  if (state.wentOut !== null && player === state.lastTurnFor) {
    endRound(state);
  } else if (state.wentOut === null && state.turnsThisRound >= ROUND_TURN_CAP) {
    endRound(state); // safety backstop: nobody could go out — score both as caught
  } else {
    state.turn = 1 - player;
    state.phase = 'draw';
  }
  return state;
}

function endRound(state) {
  const arrangements = state.hands.map(h => bestArrangement(h, state.wildRank, state.config.mode));
  const scores = arrangements.map((a, p) => (p === state.wentOut ? 0 : a.points));
  state.roundResults.push({
    round: state.handSize,
    wildRank: state.wildRank,
    scores,
    wentOut: state.wentOut,
    // Turns the going-out player needed (cap-ended rounds: each player's
    // approximate turn count — wentOut is null there so it's distinguishable).
    turns: state.wentOutOnTurn ?? Math.ceil(state.turnsThisRound / 2),
    arrangements,
  });
  state.totals[0] += scores[0];
  state.totals[1] += scores[1];
  state.phase = 'roundEnd';
}

function doNextRound(state) {
  if (state.phase !== 'roundEnd') throw new Error(`Illegal nextRound: phase is '${state.phase}'`);
  state.roundIndex += 1;
  if (state.roundIndex >= ROUNDS.length) {
    state.phase = 'gameOver';
    state.winner =
      state.totals[0] < state.totals[1] ? 0 : state.totals[1] < state.totals[0] ? 1 : 'tie';
  } else {
    deal(state);
  }
  return state;
}

/**
 * Apply an action to the state (mutates and returns state).
 * @param {object} state
 * @param {{type: 'draw', player: 0|1, source: 'stock'|'discard'}
 *       | {type: 'discard', player: 0|1, card: number}
 *       | {type: 'nextRound'}} action
 * @returns {object} state
 * @throws {Error} on illegal actions (wrong player, wrong phase, card not in hand)
 */
export function applyAction(state, action) {
  switch (action && action.type) {
    case 'draw':
      return doDraw(state, action);
    case 'discard':
      return doDiscard(state, action);
    case 'nextRound':
      return doNextRound(state);
    default:
      throw new Error(`Unknown action type: ${action && action.type}`);
  }
}

/**
 * All legal actions in the current state (for AI + UI enabling).
 * @param {object} state
 * @returns {object[]} actions (empty when phase === 'gameOver')
 */
export function legalActions(state) {
  const acts = [];
  if (state.phase === 'draw') {
    if (state.stock.length > 0 || state.discard.length > 1) {
      acts.push({ type: 'draw', player: state.turn, source: 'stock' });
    }
    if (state.discard.length > 0) {
      acts.push({ type: 'draw', player: state.turn, source: 'discard' });
    }
  } else if (state.phase === 'discard') {
    for (const card of state.hands[state.turn]) {
      acts.push({ type: 'discard', player: state.turn, card });
    }
  } else if (state.phase === 'roundEnd') {
    acts.push({ type: 'nextRound' });
  }
  return acts;
}
