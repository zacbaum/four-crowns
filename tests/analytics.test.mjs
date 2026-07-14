/**
 * node --test coverage for js/stats/analytics.js.
 *
 * Fixture: 8 varied games — all three kinds, all AI levels, hard/normal,
 * a tie, an unfinished game, and rounds with missing wentOut. Games use
 * short round lists on purpose (analytics must not assume 10 rounds).
 * Every expected number below is hand-computed from the fixture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUND_ORDER, roundLabel, filterGames, playerAggregates, headToHead,
  averageScores, roundStats, trajectory, goingOutStats, caughtDistribution,
  bestWorstRounds, totalsOverTime, streaks,
} from '../js/stats/analytics.js';

const approx = (actual, expected, msg) => {
  assert.ok(Math.abs(actual - expected) < 1e-9, msg ?? `${actual} !== ~${expected}`);
};

function mkGame(over) {
  return {
    id: 'g?',
    dateISO: '2026-01-01T12:00:00.000Z',
    kind: 'ai',
    aiLevel: null,
    hardMode: false,
    players: ['Zac', 'Bot'],
    rounds: [],
    totals: [0, 0],
    winner: null,
    finished: true,
    ...over,
  };
}

const g1 = mkGame({
  id: 'g1', dateISO: '2026-01-01T12:00:00.000Z', kind: 'ai', aiLevel: 'easy',
  rounds: [
    { round: 3, scores: [0, 7], wentOut: 0 },
    { round: 4, scores: [5, 0], wentOut: 1 },
    { round: 6, scores: [0, 12], wentOut: 0 },
  ],
  totals: [5, 19], winner: 0,
});
const g2 = mkGame({
  id: 'g2', dateISO: '2026-01-02T12:00:00.000Z', kind: 'ai', aiLevel: 'medium', hardMode: true,
  rounds: [
    { round: 3, scores: [10, 0], wentOut: 1 },
    { round: 4, scores: [25, 0], wentOut: 1 },
  ],
  totals: [35, 0], winner: 1,
});
const g3 = mkGame({
  id: 'g3', dateISO: '2026-01-03T12:00:00.000Z', kind: 'ai', aiLevel: 'hard', hardMode: true,
  rounds: [
    { round: 3, scores: [6, 6], wentOut: null }, // missing wentOut
    { round: 4, scores: [0, 0], wentOut: 0 },
  ],
  totals: [6, 6], winner: 'tie',
});
const g4 = mkGame({
  id: 'g4', dateISO: '2026-01-04T12:00:00.000Z', kind: 'online', players: ['Zac', 'Maya'],
  rounds: [
    { round: 3, scores: [0, 9], wentOut: 0 },
    { round: 4, scores: [3, 0], wentOut: null }, // missing wentOut
  ],
  totals: [3, 9], winner: 0,
});
const g5 = mkGame({ // unfinished / abandoned
  id: 'g5', dateISO: '2026-01-05T12:00:00.000Z', kind: 'online', players: ['Zac', 'Maya'],
  rounds: [
    { round: 3, scores: [8, 0], wentOut: 1 },
  ],
  totals: [8, 0], winner: null, finished: false,
});
const g6 = mkGame({
  id: 'g6', dateISO: '2026-01-06T12:00:00.000Z', kind: 'scorekeeper', players: ['Alice', 'Bob'],
  rounds: [
    { round: 3, scores: [15, 0], wentOut: 1 },
    { round: 4, scores: [20, 0], wentOut: 1 },
  ],
  totals: [35, 0], winner: 1,
});
const g7 = mkGame({
  id: 'g7', dateISO: '2026-01-07T12:00:00.000Z', kind: 'scorekeeper', players: ['Zac', 'Maya'], hardMode: true,
  rounds: [
    { round: 3, scores: [0, 25], wentOut: 0 },
  ],
  totals: [0, 25], winner: 0,
});
const g8 = mkGame({
  id: 'g8', dateISO: '2026-01-08T12:00:00.000Z', kind: 'ai', aiLevel: 'easy',
  rounds: [
    { round: 3, scores: [0, 4], wentOut: 0 },
    { round: 4, scores: [0, 11], wentOut: 0 },
  ],
  totals: [0, 15], winner: 0,
});

const GAMES = [g1, g2, g3, g4, g5, g6, g7, g8];

test('roundLabel maps face rounds', () => {
  assert.equal(roundLabel(3), '3');
  assert.equal(roundLabel(10), '10');
  assert.equal(roundLabel(11), 'J');
  assert.equal(roundLabel(12), 'Q');
  assert.equal(roundLabel(13), 'K');
  assert.deepEqual(ROUND_ORDER, [3, 4, 6, 7, 8, 9, 10, 11, 12, 13]);
});

test('filterGames: kind / hardMode / aiLevel / combined / none', () => {
  assert.deepEqual(filterGames(GAMES, { kind: 'ai' }).map((g) => g.id), ['g1', 'g2', 'g3', 'g8']);
  assert.deepEqual(filterGames(GAMES, { kind: 'online' }).map((g) => g.id), ['g4', 'g5']);
  assert.deepEqual(filterGames(GAMES, { kind: 'scorekeeper' }).map((g) => g.id), ['g6', 'g7']);
  assert.deepEqual(filterGames(GAMES, { hardMode: true }).map((g) => g.id), ['g2', 'g3', 'g7']);
  assert.deepEqual(filterGames(GAMES, { hardMode: false }).map((g) => g.id), ['g1', 'g4', 'g5', 'g6', 'g8']);
  assert.deepEqual(filterGames(GAMES, { aiLevel: 'easy' }).map((g) => g.id), ['g1', 'g8']);
  assert.deepEqual(filterGames(GAMES, { kind: 'ai', hardMode: true }).map((g) => g.id), ['g2', 'g3']);
  assert.equal(filterGames(GAMES).length, 8);
  assert.equal(filterGames(GAMES, { kind: null, hardMode: null, aiLevel: null }).length, 8);
  assert.deepEqual(filterGames([], { kind: 'ai' }), []);
});

test('playerAggregates: full fixture', () => {
  const agg = playerAggregates(GAMES);
  // Sorted by games desc, then name: Zac(7), Bot(4), Maya(3), Alice(1), Bob(1)
  assert.deepEqual(agg.map((a) => a.name), ['Zac', 'Bot', 'Maya', 'Alice', 'Bob']);
  const zac = agg[0];
  assert.equal(zac.games, 7);
  assert.equal(zac.finished, 6);
  assert.equal(zac.wins, 4);       // g1, g4, g7, g8
  assert.equal(zac.losses, 1);     // g2
  assert.equal(zac.ties, 1);       // g3
  approx(zac.winRate, 4 / 6);
  const bot = agg[1];
  assert.equal(bot.games, 4);
  assert.equal(bot.finished, 4);
  assert.equal(bot.wins, 1);
  assert.equal(bot.losses, 2);
  assert.equal(bot.ties, 1);
  approx(bot.winRate, 0.25);
  const maya = agg[2];
  assert.equal(maya.games, 3);     // g4, g5, g7
  assert.equal(maya.finished, 2);  // g5 unfinished
  assert.equal(maya.wins, 0);
  assert.equal(maya.losses, 2);
  approx(maya.winRate, 0);
  const alice = agg[3];
  assert.equal(alice.games, 1);
  assert.equal(alice.losses, 1);
  const bob = agg[4];
  assert.equal(bob.wins, 1);
  approx(bob.winRate, 1);
});

test('playerAggregates: empty and single game', () => {
  assert.deepEqual(playerAggregates([]), []);
  const agg = playerAggregates([g1]);
  assert.equal(agg.length, 2);
  const zac = agg.find((a) => a.name === 'Zac');
  assert.equal(zac.games, 1);
  assert.equal(zac.wins, 1);
  approx(zac.winRate, 1);
  // unfinished-only: winRate null
  const only = playerAggregates([g5]).find((a) => a.name === 'Zac');
  assert.equal(only.finished, 0);
  assert.equal(only.winRate, null);
});

test('headToHead: pairs, finished games only, sorted by games', () => {
  const h2h = headToHead(GAMES);
  assert.equal(h2h.length, 3);
  const [botZac, mayaZac, aliceBob] = h2h;
  assert.deepEqual(botZac.players, ['Bot', 'Zac']);
  assert.equal(botZac.games, 4);
  assert.deepEqual(botZac.wins, [1, 2]); // Bot won g2; Zac won g1, g8
  assert.equal(botZac.ties, 1);          // g3
  assert.deepEqual(mayaZac.players, ['Maya', 'Zac']);
  assert.equal(mayaZac.games, 2);        // g5 unfinished, excluded
  assert.deepEqual(mayaZac.wins, [0, 2]);
  assert.equal(mayaZac.ties, 0);
  assert.deepEqual(aliceBob.players, ['Alice', 'Bob']);
  assert.deepEqual(aliceBob.wins, [0, 1]);
  assert.deepEqual(headToHead([]), []);
  assert.deepEqual(headToHead([g5]), []); // only an unfinished game
});

test('averageScores: overall and per player', () => {
  const avg = averageScores(GAMES);
  approx(avg.overall.avgTotal, 158 / 14);    // finished totals only
  approx(avg.overall.avgPerRound, 166 / 30); // every recorded round score
  assert.equal(avg.overall.finishedGames, 7);
  assert.equal(avg.overall.rounds, 15);
  const zac = avg.perPlayer.find((p) => p.name === 'Zac');
  approx(zac.avgTotal, 49 / 6);
  approx(zac.avgPerRound, 57 / 13);
  assert.equal(zac.finishedGames, 6);
  assert.equal(zac.rounds, 13);
  // Maya's unfinished total (g5) must NOT be averaged in
  const maya = avg.perPlayer.find((p) => p.name === 'Maya');
  approx(maya.avgTotal, (9 + 25) / 2);
  assert.equal(maya.rounds, 4); // g4 x2, g5 x1, g7 x1
});

test('averageScores: empty games', () => {
  const avg = averageScores([]);
  assert.equal(avg.overall.avgTotal, null);
  assert.equal(avg.overall.avgPerRound, null);
  assert.deepEqual(avg.perPlayer, []);
});

test('roundStats: all 10 rounds, means where data exists, null elsewhere', () => {
  const rs = roundStats(GAMES);
  assert.equal(rs.length, 10);
  assert.deepEqual(rs.map((r) => r.round), ROUND_ORDER);
  const r3 = rs[0];
  assert.equal(r3.count, 16);
  approx(r3.mean, 90 / 16);
  const zac3 = r3.perPlayer.find((p) => p.name === 'Zac');
  approx(zac3.mean, 24 / 7); // 0,10,6,0,8,0,0
  assert.equal(zac3.count, 7);
  const r4 = rs[1];
  assert.equal(r4.count, 12);
  approx(r4.mean, 64 / 12);
  const r6 = rs[2];
  assert.equal(r6.count, 2);
  approx(r6.mean, 6); // g1 only: 0 and 12
  for (const r of rs.slice(3)) { // rounds 7..K: no data
    assert.equal(r.count, 0);
    assert.equal(r.mean, null);
    assert.deepEqual(r.perPlayer, []);
  }
  assert.equal(rs[7].label, 'J');
  assert.equal(rs[8].label, 'Q');
  assert.equal(rs[9].label, 'K');
});

test('roundStats: empty games array', () => {
  const rs = roundStats([]);
  assert.equal(rs.length, 10);
  assert.ok(rs.every((r) => r.count === 0 && r.mean === null));
});

test('trajectory: cumulative totals by round', () => {
  const t = trajectory(g1);
  assert.deepEqual(t, [
    { round: 3, label: '3', scores: [0, 7], cumulative: [0, 7] },
    { round: 4, label: '4', scores: [5, 0], cumulative: [5, 7] },
    { round: 6, label: '6', scores: [0, 12], cumulative: [5, 19] },
  ]);
  assert.equal(t[t.length - 1].cumulative[0], g1.totals[0]);
  assert.equal(t[t.length - 1].cumulative[1], g1.totals[1]);
  assert.deepEqual(trajectory(mkGame({ rounds: [] })), []);
});

test('goingOutStats: only rounds with wentOut recorded', () => {
  const go = goingOutStats(GAMES);
  const zac = go.find((p) => p.name === 'Zac');
  assert.equal(zac.rounds, 11);  // g3 r3 and g4 r4 excluded (wentOut null)
  assert.equal(zac.wentOut, 7);
  approx(zac.rate, 7 / 11);
  const bot = go.find((p) => p.name === 'Bot');
  assert.equal(bot.rounds, 8);
  assert.equal(bot.wentOut, 3);
  approx(bot.rate, 3 / 8);
  const maya = go.find((p) => p.name === 'Maya');
  assert.equal(maya.rounds, 3);
  assert.equal(maya.wentOut, 1); // g5 r3
  approx(maya.rate, 1 / 3);
  const alice = go.find((p) => p.name === 'Alice');
  assert.equal(alice.wentOut, 0);
  approx(alice.rate, 0);
  assert.deepEqual(goingOutStats([]), []);
  // game whose rounds all lack wentOut contributes nothing
  assert.deepEqual(goingOutStats([mkGame({ rounds: [{ round: 3, scores: [1, 2], wentOut: null }] })]), []);
});

test('caughtDistribution: nonzero scores bucketed', () => {
  const d = caughtDistribution(GAMES, 5);
  assert.equal(d.total, 15);
  assert.equal(d.buckets.length, 5); // max value 25
  assert.deepEqual(d.buckets.map((b) => b.count), [3, 6, 3, 1, 2]);
  assert.deepEqual(d.buckets.map((b) => [b.min, b.max]),
    [[1, 5], [6, 10], [11, 15], [16, 20], [21, 25]]);
  assert.equal(d.buckets[0].label, '1–5');
  // bucket edges: a score exactly on a boundary lands in the lower bucket
  const edge = caughtDistribution([mkGame({ rounds: [{ round: 3, scores: [5, 6], wentOut: null }] })], 5);
  assert.deepEqual(edge.buckets.map((b) => b.count), [1, 1]);
  const empty = caughtDistribution([], 5);
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.buckets, []);
  // all-zero rounds -> empty histogram
  const zeros = caughtDistribution([mkGame({ rounds: [{ round: 3, scores: [0, 0], wentOut: 0 }] })]);
  assert.equal(zeros.total, 0);
});

test('bestWorstRounds: min/max single rounds per player', () => {
  const bw = bestWorstRounds(GAMES);
  const zac = bw.find((p) => p.name === 'Zac');
  assert.equal(zac.best.score, 0);
  assert.equal(zac.worst.score, 25);
  assert.equal(zac.worst.gameId, 'g2');
  assert.equal(zac.worst.round, 4);
  const bot = bw.find((p) => p.name === 'Bot');
  assert.equal(bot.best.score, 0);
  assert.equal(bot.worst.score, 12);
  assert.equal(bot.worst.gameId, 'g1');
  assert.equal(bot.worst.round, 6);
  const alice = bw.find((p) => p.name === 'Alice');
  assert.equal(alice.best.score, 15);
  assert.equal(alice.worst.score, 20);
  assert.deepEqual(bestWorstRounds([]), []);
});

test('totalsOverTime: finished games in date order per player', () => {
  const tot = totalsOverTime(GAMES);
  assert.equal(tot[0].name, 'Zac'); // most points first
  assert.deepEqual(tot[0].points.map((p) => p.gameId), ['g1', 'g2', 'g3', 'g4', 'g7', 'g8']);
  assert.deepEqual(tot[0].points.map((p) => p.total), [5, 35, 6, 3, 0, 0]);
  const maya = tot.find((p) => p.name === 'Maya');
  assert.deepEqual(maya.points.map((p) => p.gameId), ['g4', 'g7']); // g5 unfinished
  assert.deepEqual(totalsOverTime([]), []);
});

test('streaks: ties and losses break; current counts from most recent', () => {
  // Zac by date: g1 W, g2 L, g3 T, g4 W, g7 W, g8 W
  assert.deepEqual(streaks(GAMES, 'Zac'), { current: 3, longest: 3 });
  // Bot: g1 L, g2 W, g3 T, g8 L
  assert.deepEqual(streaks(GAMES, 'Bot'), { current: 0, longest: 1 });
  assert.deepEqual(streaks(GAMES, 'Maya'), { current: 0, longest: 0 });
  assert.deepEqual(streaks(GAMES, 'Bob'), { current: 1, longest: 1 });
  assert.deepEqual(streaks(GAMES, 'Nobody'), { current: 0, longest: 0 });
  assert.deepEqual(streaks([], 'Zac'), { current: 0, longest: 0 });
  // unfinished games are ignored entirely
  assert.deepEqual(streaks([g5], 'Zac'), { current: 0, longest: 0 });
});

test('metrics compose with filterGames (charts always agree with the filter row)', () => {
  const ai = filterGames(GAMES, { kind: 'ai' });
  const agg = playerAggregates(ai);
  const zac = agg.find((a) => a.name === 'Zac');
  assert.equal(zac.games, 4);
  assert.equal(zac.wins, 2); // g1, g8
  assert.equal(zac.losses, 1);
  assert.equal(zac.ties, 1);
  const hard = filterGames(GAMES, { hardMode: true });
  const d = caughtDistribution(hard, 5);
  // hard games g2,g3,g7 nonzero scores: 10,25,6,6,25
  assert.equal(d.total, 5);
  assert.deepEqual(streaks(hard, 'Zac'), { current: 1, longest: 1 }); // L, T, W
});
