import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, legalActions } from '../js/engine/game.js';
import { ROUNDS, mulberry32, cardPoints } from '../js/engine/cards.js';
import { bestArrangement, canGoOut } from '../js/engine/solver.js';

// Seed 1 verified: neither initial round-0 hand can go out (asserted in tests).
const SAFE_SEED = 1;

const mkConfig = (overrides = {}) => ({
  mode: 'normal',
  seed: SAFE_SEED,
  players: [{ name: 'Alpha' }, { name: 'Beta' }],
  ...overrides,
});

function assertFullDeck(state, label = '') {
  const all = [...state.hands[0], ...state.hands[1], ...state.stock, ...state.discard];
  assert.equal(all.length, 52, `52 cards total ${label}`);
  assert.equal(new Set(all).size, 52, `52 distinct cards ${label}`);
  for (const c of all) {
    assert.ok(Number.isInteger(c) && c >= 0 && c < 52, `card id in range ${label}`);
  }
}

function checkRoundStart(state) {
  const n = ROUNDS[state.roundIndex];
  assert.equal(state.handSize, n);
  assert.equal(state.wildRank, n);
  assert.equal(state.dealer, state.roundIndex % 2, 'dealer alternates, player 0 deals round 0');
  assert.equal(state.turn, 1 - state.dealer, 'non-dealer takes the first turn');
  assert.equal(state.phase, 'draw');
  assert.equal(state.wentOut, null);
  assert.equal(state.lastTurnFor, null);
  assert.equal(state.hands[0].length, n);
  assert.equal(state.hands[1].length, n);
  assert.equal(state.discard.length, 1);
  assert.equal(state.stock.length, 52 - 2 * n - 1);
  assertFullDeck(state, `(round ${state.roundIndex} start)`);
}

/* ------------------------------------------------------------------------ *
 * Dealing
 * ------------------------------------------------------------------------ */

test('createGame deals round 0 correctly', () => {
  const state = createGame(mkConfig());
  assert.equal(state.roundIndex, 0);
  checkRoundStart(state);
  assert.deepEqual(state.totals, [0, 0]);
  assert.deepEqual(state.roundResults, []);
  assert.equal(state.winner, null);
  assert.equal(state.config.players[0].name, 'Alpha');
});

/* ------------------------------------------------------------------------ *
 * Draw + discard mechanics
 * ------------------------------------------------------------------------ */

test('draw from stock then discard passes the turn', () => {
  const state = createGame(mkConfig());
  assert.ok(!canGoOut(state.hands[0], state.wildRank), 'seed precondition');
  assert.ok(!canGoOut(state.hands[1], state.wildRank), 'seed precondition');
  const p = state.turn;
  const stockTop = state.stock[state.stock.length - 1];
  const acts = legalActions(state);
  assert.deepEqual(acts, [
    { type: 'draw', player: p, source: 'stock' },
    { type: 'draw', player: p, source: 'discard' },
  ]);
  applyAction(state, { type: 'draw', player: p, source: 'stock' });
  assert.equal(state.phase, 'discard');
  assert.equal(state.hands[p].length, 4);
  assert.equal(state.hands[p][3], stockTop, 'drawn card is the stock top');
  assert.equal(state.stock.length, 44);
  assertFullDeck(state);
  const discardActs = legalActions(state);
  assert.equal(discardActs.length, 4);
  assert.ok(discardActs.every(a => a.type === 'discard' && a.player === p));
  // discard the drawn card: hand reverts to the initial (non-melding) hand
  applyAction(state, { type: 'discard', player: p, card: stockTop });
  assert.equal(state.discard[state.discard.length - 1], stockTop, 'discard goes on top');
  assert.equal(state.discard.length, 2);
  assert.equal(state.wentOut, null);
  assert.equal(state.turn, 1 - p, 'turn passes');
  assert.equal(state.phase, 'draw');
  assertFullDeck(state);
});

test('draw from discard takes the top discard', () => {
  const state = createGame(mkConfig());
  const p = state.turn;
  const top = state.discard[state.discard.length - 1];
  applyAction(state, { type: 'draw', player: p, source: 'discard' });
  assert.ok(state.hands[p].includes(top));
  assert.equal(state.discard.length, 0);
  assertFullDeck(state);
  applyAction(state, { type: 'discard', player: p, card: top });
  assert.deepEqual(state.discard, [top]);
  assert.equal(state.turn, 1 - p);
});

/* ------------------------------------------------------------------------ *
 * Illegal actions
 * ------------------------------------------------------------------------ */

test('illegal actions throw', () => {
  const state = createGame(mkConfig());
  const p = state.turn;
  // wrong player draws
  assert.throws(() => applyAction(state, { type: 'draw', player: 1 - p, source: 'stock' }), /Illegal draw/);
  // bad draw source
  assert.throws(() => applyAction(state, { type: 'draw', player: p, source: 'nowhere' }), /Illegal draw/);
  // discard during draw phase
  assert.throws(
    () => applyAction(state, { type: 'discard', player: p, card: state.hands[p][0] }),
    /Illegal discard/
  );
  // nextRound during draw phase
  assert.throws(() => applyAction(state, { type: 'nextRound' }), /Illegal nextRound/);
  // unknown action type
  assert.throws(() => applyAction(state, { type: 'meld', player: p }), /Unknown action/);
  assert.throws(() => applyAction(state, undefined), /Unknown action/);

  applyAction(state, { type: 'draw', player: p, source: 'stock' });
  // drawing twice
  assert.throws(() => applyAction(state, { type: 'draw', player: p, source: 'stock' }), /Illegal draw/);
  // wrong player discards
  assert.throws(
    () => applyAction(state, { type: 'discard', player: 1 - p, card: state.hands[p][0] }),
    /Illegal discard/
  );
  // discarding a card not in hand (a card buried in the stock)
  const notInHand = state.stock[0];
  assert.throws(() => applyAction(state, { type: 'discard', player: p, card: notInHand }), /not in hand/);
  // state was not corrupted by the failed attempts
  assertFullDeck(state);
  assert.equal(state.phase, 'discard');
});

/* ------------------------------------------------------------------------ *
 * Determinism
 * ------------------------------------------------------------------------ */

test('determinism: same seed + same action sequence -> identical states (JSON)', () => {
  const g1 = createGame(mkConfig({ mode: 'hard', seed: 777 }));
  const g2 = createGame(mkConfig({ mode: 'hard', seed: 777 }));
  const rng = mulberry32(999);
  for (let step = 0; step < 400; step++) {
    assert.equal(JSON.stringify(g1), JSON.stringify(g2), `state divergence at step ${step}`);
    const acts = legalActions(g1);
    if (acts.length === 0) break;
    const action = acts[Math.floor(rng() * acts.length)];
    applyAction(g1, JSON.parse(JSON.stringify(action)));
    applyAction(g2, JSON.parse(JSON.stringify(action)));
  }
  assert.equal(JSON.stringify(g1), JSON.stringify(g2));
});

/* ------------------------------------------------------------------------ *
 * Stock exhaustion
 * ------------------------------------------------------------------------ */

test('stock exhaustion reshuffles discard-minus-top into the stock', () => {
  const state = createGame(mkConfig());
  // Precondition for the always-restore strategy below: neither initial hand
  // melds, so drawing from stock and discarding the drawn card loops forever.
  assert.ok(!canGoOut(state.hands[0], state.wildRank));
  assert.ok(!canGoOut(state.hands[1], state.wildRank));
  let reshuffled = false;
  for (let turns = 0; turns < 60 && !reshuffled; turns++) {
    const p = state.turn;
    if (state.stock.length === 0) {
      const discardBefore = state.discard.length;
      const topBefore = state.discard[state.discard.length - 1];
      const recycled = new Set(state.discard.slice(0, -1));
      applyAction(state, { type: 'draw', player: p, source: 'stock' });
      // reshuffle happened inside this draw
      assert.deepEqual(state.discard, [topBefore], 'top discard stays as the discard pile');
      assert.equal(state.stock.length, discardBefore - 2, 'stock = old discard minus top minus drawn');
      const drawn = state.hands[p][state.hands[p].length - 1];
      assert.ok(recycled.has(drawn), 'drawn card came from the recycled discard pile');
      assertFullDeck(state, '(after reshuffle)');
      applyAction(state, { type: 'discard', player: p, card: drawn });
      assertFullDeck(state, '(after post-reshuffle discard)');
      reshuffled = true;
    } else {
      applyAction(state, { type: 'draw', player: p, source: 'stock' });
      const drawn = state.hands[p][state.hands[p].length - 1];
      applyAction(state, { type: 'discard', player: p, card: drawn });
      assert.equal(state.phase, 'draw', 'round must not end (hands never change)');
      assertFullDeck(state);
    }
  }
  assert.ok(reshuffled, 'stock exhaustion must have occurred within 60 turns');
});

/* ------------------------------------------------------------------------ *
 * Full-game playthroughs
 *
 * All actions are drawn from legalActions() and chosen with a seeded rng.
 * Discards are epsilon-greedy (mostly shed the highest-point deadwood card):
 * uniformly random discards would make going out on the big rounds
 * astronomically unlikely, so a purely uniform full game cannot terminate in
 * practice. Draw choices stay uniformly random.
 * ------------------------------------------------------------------------ */

function chooseAction(state, acts, rng) {
  if (state.phase === 'discard' && rng() >= 0.3) {
    const hand = state.hands[state.turn];
    const arr = bestArrangement(hand, state.wildRank, 'normal');
    if (arr.deadwood.length > 0) {
      let card = arr.deadwood[0];
      for (const c of arr.deadwood) {
        if (cardPoints(c, state.wildRank) > cardPoints(card, state.wildRank)) card = c;
      }
      return { type: 'discard', player: state.turn, card };
    }
  }
  return acts[Math.floor(rng() * acts.length)];
}

function verifyRoundEnd(state) {
  const res = state.roundResults[state.roundResults.length - 1];
  assert.equal(res.round, state.handSize);
  assert.equal(res.wildRank, state.wildRank);
  assert.ok(res.wentOut === 0 || res.wentOut === 1);
  assert.equal(res.scores[res.wentOut], 0, 'goer-out scores 0');
  assert.ok(canGoOut(state.hands[res.wentOut], state.wildRank), 'goer-out hand fully melds');
  assert.equal(res.arrangements[res.wentOut].points, 0, 'goer-out arrangement is all melds');
  const opp = 1 - res.wentOut;
  const expected = bestArrangement(state.hands[opp], state.wildRank, state.config.mode);
  assert.equal(res.scores[opp], expected.points, 'opponent scored via bestArrangement in configured mode');
  assert.equal(res.arrangements[opp].points, expected.points);
  assert.equal(state.hands[0].length, state.handSize);
  assert.equal(state.hands[1].length, state.handSize);
}

function playFullGame(seed, mode, policySeed) {
  const state = createGame(mkConfig({ mode, seed }));
  const rng = mulberry32(policySeed);
  let actions = 0;
  let finalCountdown = null; // tracks the opponent's exactly-one final turn
  const expectedTotals = [0, 0];
  let discards = [0, 0];      // independent per-player discard count this round
  let expectedTurns = null;   // goer-out's own discard count at go-out moment
  checkRoundStart(state);
  while (state.phase !== 'gameOver') {
    assert.ok(actions < 30000, `game must terminate (seed ${seed}, mode ${mode})`);
    const acts = legalActions(state);
    assert.ok(acts.length > 0, 'non-terminal states always have legal actions');
    const action = chooseAction(state, acts, rng);
    assert.ok(
      acts.some(a => JSON.stringify(a) === JSON.stringify(action)),
      'chosen action must be in legalActions'
    );
    const wentOutBefore = state.wentOut;
    const phaseBefore = state.phase;
    applyAction(state, action);
    actions++;
    if (action.type === 'discard') discards[action.player]++;
    if (wentOutBefore === null && state.wentOut !== null) {
      expectedTurns = discards[state.wentOut];
    }

    if (state.phase === 'draw' || state.phase === 'discard') {
      assertFullDeck(state, `(action ${actions})`);
    }

    if (finalCountdown !== null) {
      finalCountdown.count++;
      finalCountdown.players.push(action.player);
    }
    if (wentOutBefore === null && state.wentOut !== null) {
      assert.equal(state.lastTurnFor, 1 - state.wentOut, 'going out sets last turn for opponent');
      finalCountdown = { count: 0, players: [], who: state.lastTurnFor };
    }
    if (state.phase === 'roundEnd' && phaseBefore === 'discard') {
      assert.ok(finalCountdown !== null, 'round can only end after someone went out');
      assert.equal(finalCountdown.count, 2, 'opponent gets exactly one final turn (draw + discard)');
      assert.deepEqual(
        finalCountdown.players,
        [finalCountdown.who, finalCountdown.who],
        'both final actions belong to the opponent'
      );
      finalCountdown = null;
      verifyRoundEnd(state);
      const res = state.roundResults[state.roundResults.length - 1];
      assert.equal(res.turns, expectedTurns,
        "roundResults.turns is the goer-out's own discard count at going out");
      expectedTotals[0] += res.scores[0];
      expectedTotals[1] += res.scores[1];
      assert.deepEqual(state.totals, expectedTotals, 'totals accumulate round scores');
    }
    if (phaseBefore === 'roundEnd' && state.phase !== 'gameOver') {
      checkRoundStart(state);
      discards = [0, 0];
      expectedTurns = null;
    }
  }
  // Game over bookkeeping.
  assert.equal(state.roundResults.length, 10);
  assert.deepEqual(state.roundResults.map(r => r.round), ROUNDS, 'one result per round, in order');
  assert.deepEqual(state.totals, expectedTotals);
  assert.deepEqual(
    state.totals,
    [0, 1].map(p => state.roundResults.reduce((s, r) => s + r.scores[p], 0)),
    'totals = sum of round scores'
  );
  const expectedWinner =
    state.totals[0] < state.totals[1] ? 0 : state.totals[1] < state.totals[0] ? 1 : 'tie';
  assert.equal(state.winner, expectedWinner, 'lowest cumulative total wins');
  assert.deepEqual(legalActions(state), []);
  assert.throws(() => applyAction(state, { type: 'draw', player: 0, source: 'stock' }), /Illegal draw/);
  assert.throws(() => applyAction(state, { type: 'nextRound' }), /Illegal nextRound/);
  return { state, actions };
}

test('full seeded playthroughs: entire 10-round games in both modes', () => {
  const games = [
    [101, 'normal', 5001],
    [202, 'hard', 5002],
    [303, 'normal', 5003],
    [404, 'hard', 5004],
  ];
  for (const [seed, mode, policySeed] of games) {
    const { actions } = playFullGame(seed, mode, policySeed);
    console.log(`playthrough seed=${seed} mode=${mode}: completed in ${actions} actions`);
  }
});

test('full playthrough is deterministic end to end', () => {
  const a = playFullGame(9090, 'hard', 42);
  const b = playFullGame(9090, 'hard', 42);
  assert.equal(JSON.stringify(a.state), JSON.stringify(b.state));
  assert.equal(a.actions, b.actions);
});
