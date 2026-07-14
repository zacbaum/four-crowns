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
  singleRoundRecords, eloRatings, totalsOverTime, streaks,
  meldStats, classifyMeld, roundLengthStats,
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

test('goingOutStats: score-based — share of rounds scored 0', () => {
  const go = goingOutStats(GAMES);
  const zac = go.find((p) => p.name === 'Zac');
  assert.equal(zac.rounds, 13);  // every recorded Zac round counts
  assert.equal(zac.wentOut, 7);  // zeros: g1 r3+r6, g3 r4, g4 r3, g7 r3, g8 r3+r4
  approx(zac.rate, 7 / 13);
  const bot = go.find((p) => p.name === 'Bot');
  assert.equal(bot.rounds, 9);
  assert.equal(bot.wentOut, 4);  // zeros: g1 r4, g2 r3+r4, g3 r4
  approx(bot.rate, 4 / 9);
  const maya = go.find((p) => p.name === 'Maya');
  assert.equal(maya.rounds, 4);
  assert.equal(maya.wentOut, 2); // zeros: g4 r4, g5 r3
  approx(maya.rate, 0.5);
  const alice = go.find((p) => p.name === 'Alice');
  assert.equal(alice.wentOut, 0);
  approx(alice.rate, 0);
  const bob = go.find((p) => p.name === 'Bob');
  assert.equal(bob.wentOut, 2);  // scored 0 both g6 rounds
  approx(bob.rate, 1);
  assert.deepEqual(goingOutStats([]), []);
  // the wentOut marker is irrelevant: a null-marker round still counts
  const only = goingOutStats([mkGame({ rounds: [{ round: 3, scores: [0, 2], wentOut: null }] })]);
  assert.deepEqual(only.map((e) => [e.name, e.rounds, e.wentOut]), [['Bot', 1, 0], ['Zac', 1, 1]]);
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

test('caughtDistribution: per-player filter + includeZero adds a "0" bar', () => {
  // Zac's rounds across the fixture: 13 total, 6 nonzero (5,10,25,6,3,8), 7 zeros.
  const nz = caughtDistribution(GAMES, 5, 'Zac');
  assert.equal(nz.total, 6);
  assert.deepEqual(nz.buckets.map((b) => b.count), [2, 3, 0, 0, 1]); // 1-5:{5,3} 6-10:{10,6,8} 21-25:{25}
  const withZero = caughtDistribution(GAMES, 5, 'Zac', true);
  assert.equal(withZero.total, 13);
  assert.equal(withZero.buckets[0].label, '0');
  assert.deepEqual(withZero.buckets.map((b) => b.count), [7, 2, 3, 0, 0, 1]);
  // includeZero with only zero rounds still shows the 0 bar
  const onlyZero = caughtDistribution([mkGame({ rounds: [{ round: 3, scores: [0, 0], wentOut: 0 }] })], 5, null, true);
  assert.equal(onlyZero.total, 2);
  assert.deepEqual(onlyZero.buckets.map((b) => [b.label, b.count]), [['0', 2]]);
});

test('singleRoundRecords: worst hand, went-out share, biggest hit', () => {
  const zac = singleRoundRecords(GAMES, 'Zac');
  // score-based going out: 7 zeros out of Zac's 13 recorded rounds
  assert.equal(zac.cleanRounds, 7);
  assert.equal(zac.totalRounds, 13);
  const bot = singleRoundRecords(GAMES, 'Bot');
  assert.equal(bot.cleanRounds, 4);
  assert.equal(bot.totalRounds, 9);
  assert.equal(zac.worstHand.score, 25); // g2 round 4
  assert.equal(zac.worstHand.gameId, 'g2');
  assert.equal(zac.worstHand.round, 4);
  assert.equal(zac.worstHand.opponent, 'Bot');
  assert.equal(zac.biggestHit.score, 25); // opponent Maya caught for 25 in g7
  assert.equal(zac.biggestHit.gameId, 'g7');
  assert.equal(zac.biggestHit.opponent, 'Maya');
  // player not in any game -> empty records
  const nobody = singleRoundRecords(GAMES, 'Nobody');
  assert.equal(nobody.cleanRounds, 0);
  assert.equal(nobody.totalRounds, 0);
  assert.equal(nobody.worstHand, null);
  assert.equal(nobody.biggestHit, null);
  // Alice: only g6, never scored 0, opponent Bob always scored 0
  const alice = singleRoundRecords(GAMES, 'Alice');
  assert.equal(alice.cleanRounds, 0);
  assert.equal(alice.totalRounds, 2);
  assert.equal(alice.worstHand.score, 20);
  assert.equal(alice.biggestHit.score, 0);
});

test('eloRatings: exact one-game update, zero-sum, records, ordering', () => {
  // Zac beats Bot from 1500/1500, k=32 -> +/-16.
  const one = eloRatings([g1]);
  const zac1 = one.ratings.find((r) => r.name === 'Zac');
  const bot1 = one.ratings.find((r) => r.name === 'Bot');
  assert.equal(zac1.rating, 1516);
  assert.equal(bot1.rating, 1484);
  assert.deepEqual([zac1.wins, zac1.losses, zac1.ties], [1, 0, 0]);
  // k override
  assert.equal(eloRatings([g1], { k: 24 }).ratings.find((r) => r.name === 'Zac').rating, 1512);
  // a tie leaves equal starters unchanged
  const tie = eloRatings([g3]);
  assert.ok(tie.ratings.every((r) => r.rating === 1500));

  // full fixture: finished decided/tied games only (g5 excluded)
  const elo = eloRatings(GAMES);
  assert.deepEqual(elo.ratings.map((r) => r.name).sort(), ['Alice', 'Bob', 'Bot', 'Maya', 'Zac']);
  const by = Object.fromEntries(elo.ratings.map((r) => [r.name, r]));
  assert.deepEqual([by.Zac.wins, by.Zac.losses, by.Zac.ties], [4, 1, 1]);
  assert.deepEqual([by.Bot.wins, by.Bot.losses, by.Bot.ties], [1, 2, 1]);
  assert.deepEqual([by.Maya.games, by.Maya.losses], [2, 2]); // g5 unfinished not counted
  assert.deepEqual([by.Bob.wins, by.Alice.losses], [1, 1]);
  // net winners rise above base, net losers fall below
  assert.ok(by.Zac.rating > 1500 && by.Bob.rating > 1500);
  assert.ok(by.Maya.rating < 1500 && by.Alice.rating < 1500);
  // Elo is zero-sum: total rating conserved (within per-player rounding)
  const sum = elo.ratings.reduce((a, r) => a + r.rating, 0);
  assert.ok(Math.abs(sum - 1500 * 5) <= 5, `rating sum ${sum} not ~7500`);
  // ratings sorted descending
  for (let i = 1; i < elo.ratings.length; i++) {
    assert.ok(elo.ratings[i - 1].rating >= elo.ratings[i].rating);
  }
  // series: start point at base, one point per game played
  const zSeries = elo.series.find((s) => s.name === 'Zac');
  assert.equal(zSeries.points[0].rating, 1500);
  assert.equal(zSeries.points[0].gameId, null);
  assert.equal(zSeries.points.length, 1 + by.Zac.games);

  assert.deepEqual(eloRatings([]).ratings, []);
  assert.deepEqual(eloRatings([]).series, []);
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

test('classifyMeld: groups, runs, wild handling', () => {
  // Card ids: id = suit*13 + (rank-1); suits ♠0 ♥1 ♦2 ♣3.
  // Plain group: 5♠ 5♥ 5♦ (+5♣) with 3s wild
  assert.deepEqual(classifyMeld([4, 17, 30], 3), { kind: 'group', rank: 5, wilds: 0 });
  assert.deepEqual(classifyMeld([4, 17, 30, 43], 3), { kind: 'group', rank: 5, wilds: 0 });
  // Plain run: 3♠ 4♠ 5♠ with 7s wild
  assert.deepEqual(classifyMeld([2, 3, 4], 7), { kind: 'run', suit: 0, wilds: 0 });
  // Run using a wild: 9♥ 10♥ + 7♠ (round of 7s)
  assert.deepEqual(classifyMeld([21, 22, 6], 7), { kind: 'run', suit: 1, wilds: 1 });
  // All wild-rank cards are just a natural group of that rank: 6♠ 6♥ 6♦ in 6s
  assert.deepEqual(classifyMeld([5, 18, 31], 6), { kind: 'group', rank: 6, wilds: 0 });
  // Single natural + wilds counts as a group of the natural: 9♦ + 4♠ 4♥ in 4s
  assert.deepEqual(classifyMeld([34, 3, 16], 4), { kind: 'group', rank: 9, wilds: 2 });
});

test('meldStats: aggregates per player over rounds with meld data', () => {
  const gm = mkGame({
    id: 'm1', dateISO: '2026-02-01T12:00:00.000Z', kind: 'ai', players: ['Zac', 'Bot'],
    rounds: [
      // Zac: group of 5s; Bot: no melds (still a recorded meld round)
      { round: 3, scores: [0, 7], wentOut: 0, melds: [[[4, 17, 30]], []] },
      // Zac: ♥ run with one wild + group of Qs; Bot: ♠ run
      { round: 7, scores: [0, 10], wentOut: 0,
        melds: [[[21, 22, 6], [11, 24, 37]], [[2, 3, 4]]] },
      // No meld data recorded this round -> ignored entirely
      { round: 8, scores: [4, 0], wentOut: 1 },
    ],
    totals: [4, 17], winner: 0,
  });
  const all = [...GAMES, gm]; // legacy fixture games have no melds
  const zac = meldStats(all, 'Zac');
  assert.equal(zac.rounds, 2);
  assert.equal(zac.melds, 3);
  assert.equal(zac.groups, 2);
  assert.equal(zac.runs, 1);
  assert.equal(zac.groupsByRank[5 - 1].count, 1);  // the 5s group
  assert.equal(zac.groupsByRank[12 - 1].count, 1); // the Qs group
  assert.equal(zac.runsBySuit[1].count, 1);        // the ♥ run
  assert.equal(zac.meldsWithWilds, 1);
  assert.equal(zac.wildsUsed, 1);
  approx(zac.avgWildsPerRound, 0.5);
  approx(zac.wildMeldShare, 1 / 3);
  const bot = meldStats(all, 'Bot');
  assert.equal(bot.rounds, 2);
  assert.equal(bot.melds, 1);
  assert.equal(bot.runs, 1);
  assert.equal(bot.runsBySuit[0].count, 1); // the ♠ run
  const nobody = meldStats(all, 'Nobody');
  assert.equal(nobody.rounds, 0);
  assert.equal(nobody.avgWildsPerRound, null);
  assert.equal(nobody.wildMeldShare, null);
  assert.deepEqual(meldStats([], 'Zac').melds, 0);
});

test('roundLengthStats: distribution of turns to go out', () => {
  const gl = mkGame({
    id: 'l1', kind: 'ai',
    rounds: [
      { round: 3, scores: [0, 7], wentOut: 0, turns: 2 },
      { round: 4, scores: [5, 0], wentOut: 1, turns: 6 },
      { round: 6, scores: [0, 12], wentOut: 0, turns: 6 },
      { round: 7, scores: [3, 0], wentOut: 1, turns: 25 }, // overflow bin
      { round: 8, scores: [1, 0], wentOut: 1 },            // no turns recorded
    ],
    totals: [9, 19], winner: 0,
  });
  const rl = roundLengthStats([...GAMES, gl]); // legacy fixture has no turns
  assert.equal(rl.rounds, 4);
  approx(rl.avgTurns, (2 + 6 + 6 + 25) / 4);
  assert.equal(rl.minTurns, 2);
  assert.equal(rl.maxTurns, 25);
  assert.equal(rl.histogram.length, 20); // 1..19 + '20+'
  assert.equal(rl.histogram[1].count, 1);  // turns=2
  assert.equal(rl.histogram[5].count, 2);  // turns=6 twice
  assert.equal(rl.histogram[19].label, '20+');
  assert.equal(rl.histogram[19].count, 1); // turns=25
  // no data at all
  const empty = roundLengthStats(GAMES);
  assert.equal(empty.rounds, 0);
  assert.equal(empty.avgTurns, null);
  assert.deepEqual(empty.histogram, []);
  // no overflow bin when everything fits
  const small = roundLengthStats([mkGame({ rounds: [{ round: 3, scores: [0, 5], wentOut: 0, turns: 4 }] })]);
  assert.equal(small.histogram.length, 4);
  assert.equal(small.histogram[3].label, '4');
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
