import test from 'node:test';
import assert from 'node:assert/strict';
import { bestArrangement, canGoOut, enumerateMelds, shapesFor } from '../js/engine/solver.js';
import { rank, suit, makeCard, cardPoints, mulberry32 } from '../js/engine/cards.js';

// Suit indices for readable hand construction.
const SP = 0, HE = 1, DI = 2, CL = 3;
const C = (r, s) => makeCard(r, s);

/* ------------------------------------------------------------------------ *
 * Brute-force REFERENCE solver — deliberately structured differently from
 * the real one: it enumerates every subset of the hand as candidate deadwood
 * in ascending point order and returns the first whose complement partitions
 * into valid melds satisfying the mode constraint.
 * ------------------------------------------------------------------------ */

/** Shapes as [threes, fours] count pairs, iterating threes ascending. */
function refShapes(n) {
  const shapes = [];
  for (let threes = 0; threes * 3 <= n; threes++) {
    const rem = n - threes * 3;
    if (rem % 4 === 0) shapes.push([threes, rem / 4]);
  }
  return shapes;
}

/** Meld validity by explicit window scan (different formulation on purpose). */
function refIsValidMeld(cards, wildRank) {
  const size = cards.length;
  if (size !== 3 && size !== 4) return false;
  const nat = cards.filter(c => rank(c) !== wildRank);
  // group: some rank matches every natural (vacuously true when all wild)
  for (let r = 1; r <= 13; r++) {
    if (nat.every(c => rank(c) === r)) return true;
  }
  // run: some suit + some window of `size` consecutive ranks fits all naturals.
  // The ace plays low (band 1..13) or, when present, high (ace -> 14, band
  // 2..14). No wraparound — each band is one contiguous window scan.
  for (let s = 0; s < 4; s++) {
    if (!nat.every(c => suit(c) === s)) continue;
    const rs = nat.map(c => rank(c));
    if (new Set(rs).size !== rs.length) continue;
    const fits = (mapped, bandLo, bandHi) => {
      for (let lo = bandLo; lo + size - 1 <= bandHi; lo++) {
        const hi = lo + size - 1;
        if (mapped.every(r => r >= lo && r <= hi)) return true;
      }
      return false;
    };
    if (fits(rs, 1, 13)) return true;
    if (rs.includes(1) && fits(rs.map(r => (r === 1 ? 14 : r)), 2, 14)) return true;
  }
  return false;
}

function* combinations(arr, k) {
  if (k === 0) {
    yield [];
    return;
  }
  for (let i = 0; i + k <= arr.length; i++) {
    for (const rest of combinations(arr.slice(i + 1), k - 1)) {
      yield [arr[i], ...rest];
    }
  }
}

/** Can `cards` be fully partitioned into valid melds with finalOk(c3, c4)? */
function refCanPartition(cards, wildRank, c3, c4, finalOk) {
  if (cards.length === 0) return finalOk(c3, c4);
  const [first, ...rest] = cards;
  for (const size of [3, 4]) {
    if (cards.length < size) continue;
    for (const combo of combinations(rest, size - 1)) {
      const meld = [first, ...combo];
      if (!refIsValidMeld(meld, wildRank)) continue;
      const used = new Set(combo);
      const remaining = rest.filter(c => !used.has(c));
      const n3 = c3 + (size === 3 ? 1 : 0);
      const n4 = c4 + (size === 4 ? 1 : 0);
      if (refCanPartition(remaining, wildRank, n3, n4, finalOk)) return true;
    }
  }
  return false;
}

function refBestPoints(hand, wildRank, mode) {
  const n = hand.length;
  const shapes = refShapes(n);
  const finalOk = (c3, c4) => {
    if (c3 === 0 && c4 === 0) return true; // claiming no melds is always legal
    if (mode !== 'hard') return true;
    return shapes.some(([s3, s4]) => c3 <= s3 && c4 <= s4);
  };
  const candidates = [];
  for (let m = 0; m < 1 << n; m++) {
    let pts = 0;
    const rest = [];
    for (let i = 0; i < n; i++) {
      if ((m >> i) & 1) pts += cardPoints(hand[i], wildRank);
      else rest.push(hand[i]);
    }
    candidates.push({ pts, rest });
  }
  candidates.sort((a, b) => a.pts - b.pts);
  for (const { pts, rest } of candidates) {
    if (refCanPartition(rest, wildRank, 0, 0, finalOk)) return pts;
  }
  throw new Error('unreachable: the all-deadwood candidate always partitions');
}

/* ------------------------------------------------------------------------ *
 * Consistency checks on the arrangement object itself.
 * ------------------------------------------------------------------------ */

function checkArrangement(hand, wildRank, mode, res) {
  const all = [...res.deadwood, ...res.melds.flat()];
  assert.equal(all.length, hand.length, 'melds + deadwood must cover the hand');
  assert.deepEqual(
    [...all].sort((a, b) => a - b),
    [...hand].sort((a, b) => a - b),
    'melds + deadwood must be exactly the hand'
  );
  for (const m of res.melds) {
    assert.ok(refIsValidMeld(m, wildRank), `invalid meld claimed: ${JSON.stringify(m)}`);
  }
  const pts = res.deadwood.reduce((s, c) => s + cardPoints(c, wildRank), 0);
  assert.equal(res.points, pts, 'points must equal sum of deadwood card points');
  if (mode === 'hard' && res.melds.length > 0) {
    const c3 = res.melds.filter(m => m.length === 3).length;
    const c4 = res.melds.filter(m => m.length === 4).length;
    assert.ok(
      refShapes(hand.length).some(([s3, s4]) => c3 <= s3 && c4 <= s4),
      `hard-mode meld sizes {3:${c3}, 4:${c4}} not a sub-multiset of any shape of ${hand.length}`
    );
  }
}

/* ------------------------------------------------------------------------ *
 * shapesFor
 * ------------------------------------------------------------------------ */

test('shapesFor matches the RULES.md table', () => {
  const norm = shapes => shapes.map(s => [...s].sort()).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const expect = {
    3: [[3]],
    4: [[4]],
    6: [[3, 3]],
    7: [[3, 4]],
    8: [[4, 4]],
    9: [[3, 3, 3]],
    10: [[3, 3, 4]],
    11: [[3, 4, 4]],
    12: [[4, 4, 4], [3, 3, 3, 3]],
    13: [[3, 3, 3, 4]],
  };
  for (const [n, shapes] of Object.entries(expect)) {
    assert.deepEqual(norm(shapesFor(Number(n))), norm(shapes), `shapesFor(${n})`);
  }
  assert.deepEqual(shapesFor(5), [], 'no valid shape for 5 cards');
  assert.deepEqual(shapesFor(12), [[4, 4, 4], [3, 3, 3, 3]], 'contract example for 12');
});

/* ------------------------------------------------------------------------ *
 * Randomized comparison vs the reference
 * ------------------------------------------------------------------------ */

function randomHand(rng, size, wildRank) {
  const wildSuits = [0, 1, 2, 3];
  // shuffle suits
  for (let i = 3; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [wildSuits[i], wildSuits[j]] = [wildSuits[j], wildSuits[i]];
  }
  const k = Math.floor(rng() * (Math.min(4, size) + 1)); // forced wild count 0..min(4,size)
  const hand = wildSuits.slice(0, k).map(s => makeCard(wildRank, s));
  const chosen = new Set(hand);
  while (hand.length < size) {
    const c = Math.floor(rng() * 52);
    if (!chosen.has(c)) {
      chosen.add(c);
      hand.push(c); // may add extra wilds by chance — wild count varies
    }
  }
  return hand;
}

test('bestArrangement matches brute-force reference on 350 random hands, both modes', () => {
  const rng = mulberry32(123456);
  const sizes = [3, 4, 6, 7, 8];
  const wildRanks = [3, 4, 6, 7, 8, 9, 10, 11, 12, 13];
  let hands = 0;
  for (let trial = 0; trial < 350; trial++) {
    const size = sizes[trial % sizes.length];
    const wildRank = wildRanks[Math.floor(rng() * wildRanks.length)];
    const hand = randomHand(rng, size, wildRank);
    const refNormal = refBestPoints(hand, wildRank, 'normal');
    const refHard = refBestPoints(hand, wildRank, 'hard');
    for (const [mode, refPts] of [['normal', refNormal], ['hard', refHard]]) {
      const res = bestArrangement(hand, wildRank, mode);
      assert.equal(
        res.points,
        refPts,
        `points mismatch: hand=[${hand}] wildRank=${wildRank} mode=${mode}`
      );
      checkArrangement(hand, wildRank, mode, res);
    }
    assert.equal(
      canGoOut(hand, wildRank),
      refNormal === 0,
      `canGoOut mismatch: hand=[${hand}] wildRank=${wildRank}`
    );
    hands++;
  }
  assert.ok(hands >= 300, 'must cover at least 300 random hands');
});

/* ------------------------------------------------------------------------ *
 * RULES.md hard-mode examples, verbatim
 * ------------------------------------------------------------------------ */

test('RULES example — round 8 (shape {4,4}): 3-meld does not count', () => {
  // 4-run 9♠10♠J♠Q♠, 3-group 2♥2♦2♣, loose K♥; wild rank 8.
  const hand = [C(9, SP), C(10, SP), C(11, SP), C(12, SP), C(2, HE), C(2, DI), C(2, CL), C(13, HE)];
  const hard = bestArrangement(hand, 8, 'hard');
  // Score the 4 cards outside the 4-meld (2+2+2+13), not just the loose K.
  assert.equal(hard.points, 19);
  assert.equal(hard.melds.length, 1);
  assert.equal(hard.melds[0].length, 4);
  const normal = bestArrangement(hand, 8, 'normal');
  assert.equal(normal.points, 13); // in normal mode only the loose K counts
});

test('RULES example — round 10 (shape {3,3,4}): only one 4-meld counts, scores 6', () => {
  // 4-group A♠A♥A♦A♣, 4-run 6♠7♠8♠9♠, loose 2♥ 3♦; wild rank 10.
  const hand = [
    C(1, SP), C(1, HE), C(1, DI), C(1, CL),
    C(6, SP), C(7, SP), C(8, SP), C(9, SP),
    C(2, HE), C(3, DI),
  ];
  const hard = bestArrangement(hand, 10, 'hard');
  // {4,4} extends to no shape of 10; best legal is {4,3}: keep one 4-meld
  // whole and shrink the other to 3 cards -> deadwood A + 2 + 3 = 6.
  assert.equal(hard.points, 6);
  checkArrangement(hand, 10, 'hard', hard);
  const normal = bestArrangement(hand, 10, 'normal');
  assert.equal(normal.points, 5); // both 4-melds count in normal mode
});

test('RULES example — round 12: {4,4} is legal (extends to {4,4,4})', () => {
  // Two 4-melds + 4 loose cards that form nothing; wild rank 12 (Q).
  const hand = [
    C(1, SP), C(2, SP), C(3, SP), C(4, SP),          // 4-run
    C(7, HE), C(7, DI), C(7, CL), C(7, SP),          // 4-group
    C(9, HE), C(11, DI), C(13, DI), C(13, HE),       // loose: 9, J, K, K
  ];
  const hard = bestArrangement(hand, 12, 'hard');
  assert.equal(hard.points, 9 + 11 + 13 + 13); // 46: both 4-melds claimed
  assert.equal(hard.melds.length, 2);
  assert.ok(hard.melds.every(m => m.length === 4));
});

test('RULES example — round 12: {3,4} is illegal (no shape of 12 contains both)', () => {
  // One 4-run + one 3-group + 5 junk cards; wild rank 12 (Q).
  const hand = [
    C(1, SP), C(2, SP), C(3, SP), C(4, SP),           // 4-run A-4♠
    C(13, HE), C(13, DI), C(13, CL),                  // 3-group of Ks
    C(9, HE), C(11, DI), C(6, HE), C(8, DI), C(10, CL), // junk: 9,J,6,8,10 = 44
  ];
  const normal = bestArrangement(hand, 12, 'normal');
  assert.equal(normal.points, 44); // {4,3} fine in normal mode: junk only
  const hard = bestArrangement(hand, 12, 'hard');
  // {3,4} illegal; best legal is {3,3} (sub of {3,3,3,3}): 2♠3♠4♠ + Ks,
  // deadwood A♠ + junk = 45.
  assert.equal(hard.points, 45);
  checkArrangement(hand, 12, 'hard', hard);
});

/* ------------------------------------------------------------------------ *
 * Wild handling
 * ------------------------------------------------------------------------ */

test('unmelded wild scores 25', () => {
  // wild rank 3: 3♠ is wild, and nothing melds.
  const hand = [C(3, SP), C(13, HE), C(9, DI)];
  const res = bestArrangement(hand, 3, 'normal');
  assert.equal(res.points, 25 + 13 + 9);
  assert.equal(res.melds.length, 0);
  assert.equal(res.deadwood.length, 3);
});

test('wild completes a run and a group', () => {
  // run: 5♠ 6♠ + wild 7♥ stands in for 4♠ or 7♠
  assert.equal(bestArrangement([C(5, SP), C(6, SP), C(7, HE)], 7, 'normal').points, 0);
  assert.ok(canGoOut([C(5, SP), C(6, SP), C(7, HE)], 7));
  // group: 9♠ 9♥ + wild 7♣
  assert.equal(bestArrangement([C(9, SP), C(9, HE), C(7, CL)], 7, 'normal').points, 0);
  // gap run: 5♦ + wild + 7♦ (wild fills the 6)
  assert.equal(bestArrangement([C(5, DI), C(7, CL), C(7, DI)], 7, 'normal').points, 0);
});

test('all-wild meld is valid', () => {
  const hand = [C(3, SP), C(3, HE), C(3, DI)];
  assert.ok(canGoOut(hand, 3));
  assert.equal(bestArrangement(hand, 3, 'hard').points, 0);
});

test('ace plays low or high but never wraps around', () => {
  // Low: A-2-3 and A-2-3-4.
  assert.equal(bestArrangement([C(1, SP), C(2, SP), C(3, SP)], 13, 'normal').points, 0);
  assert.equal(bestArrangement([C(1, SP), C(2, SP), C(3, SP), C(4, SP)], 13, 'normal').points, 0);
  // High: Q-K-A and J-Q-K-A.
  assert.equal(bestArrangement([C(12, SP), C(13, SP), C(1, SP)], 6, 'normal').points, 0);
  assert.equal(bestArrangement([C(11, SP), C(12, SP), C(13, SP), C(1, SP)], 6, 'normal').points, 0);
  // No wraparound: K-A-2 spans neither band, so nothing melds.
  const kA2 = bestArrangement([C(13, SP), C(1, SP), C(2, SP)], 6, 'normal');
  assert.equal(kA2.points, 13 + 1 + 2);
});

test('5+ card same-suit sequences only meld as multiple 3-4 melds', () => {
  // 6-card sequence: melds as two 3-runs -> can go out.
  const six = [C(3, SP), C(4, SP), C(5, SP), C(6, SP), C(7, SP), C(8, SP)];
  assert.ok(canGoOut(six, 9));
  const res6 = bestArrangement(six, 9, 'hard');
  assert.equal(res6.points, 0);
  assert.deepEqual(res6.melds.map(m => m.length).sort(), [3, 3]);
  // enumerateMelds never yields melds of size other than 3/4:
  const melds = enumerateMelds(six, 9);
  assert.ok(melds.every(m => m.length === 3 || m.length === 4));
  // 3-runs: 345,456,567,678; 4-runs: 3456,4567,5678 -> 7 total
  assert.equal(melds.length, 7);

  // 5-card sequence + junk: a 5-run is NOT a meld, so 2 cards stay loose.
  const five = [C(3, SP), C(4, SP), C(5, SP), C(6, SP), C(7, SP), C(13, HE)];
  const res5 = bestArrangement(five, 9, 'normal');
  assert.equal(res5.points, 3 + 13); // meld 4♠5♠6♠7♠, deadwood 3♠ + K♥
});

test('enumerateMelds finds the single wild-completed meld', () => {
  const hand = [C(5, SP), C(6, SP), C(9, HE)]; // 9♥ wild
  const melds = enumerateMelds(hand, 9);
  assert.equal(melds.length, 1);
  assert.deepEqual([...melds[0]].sort((a, b) => a - b), [...hand].sort((a, b) => a - b));
});

test('bestArrangement does not mutate its input hand', () => {
  const hand = [C(9, SP), C(10, SP), C(11, SP), C(2, HE), C(2, DI), C(13, CL)];
  const copy = hand.slice();
  bestArrangement(hand, 6, 'hard');
  bestArrangement(hand, 6, 'normal');
  assert.deepEqual(hand, copy);
});

/* ------------------------------------------------------------------------ *
 * Performance
 * ------------------------------------------------------------------------ */

test('performance: 13-card hands with 4 wilds solve well under 50ms', () => {
  const rng = mulberry32(20240713);
  const wildRank = 13;
  const wilds = [C(13, SP), C(13, HE), C(13, DI), C(13, CL)];
  const nonWilds = [];
  for (let c = 0; c < 52; c++) if (rank(c) !== 13) nonWilds.push(c);
  const seen = new Set();
  const mkHand = () => {
    // 4 wilds + 9 distinct random non-wilds; distinct hands defeat the cache.
    let hand;
    do {
      const pool = nonWilds.slice();
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      hand = [...wilds, ...pool.slice(0, 9)];
    } while (seen.has([...hand].sort((a, b) => a - b).join(',')));
    seen.add([...hand].sort((a, b) => a - b).join(','));
    return hand;
  };
  // warmup
  for (let i = 0; i < 5; i++) {
    const h = mkHand();
    bestArrangement(h, wildRank, 'hard');
    bestArrangement(h, wildRank, 'normal');
  }
  // adversarial fixed hand: 4 wilds + three A-2-3 runs (dense meld space)
  const adversarial = [
    ...wilds,
    C(1, SP), C(2, SP), C(3, SP),
    C(1, HE), C(2, HE), C(3, HE),
    C(1, DI), C(2, DI), C(3, DI),
  ];
  const iters = 30;
  let maxMs = 0;
  let totalMs = 0;
  for (let i = 0; i < iters; i++) {
    const hand = i === 0 ? adversarial : mkHand();
    const t0 = performance.now();
    bestArrangement(hand, wildRank, 'hard');
    bestArrangement(hand, wildRank, 'normal');
    const dt = performance.now() - t0;
    maxMs = Math.max(maxMs, dt);
    totalMs += dt;
  }
  console.log(
    `solver perf: ${iters} distinct 13-card 4-wild hands (hard+normal solve each): ` +
      `avg ${(totalMs / iters).toFixed(2)}ms, max ${maxMs.toFixed(2)}ms`
  );
  assert.ok(maxMs < 50, `slowest hard+normal solve pair took ${maxMs.toFixed(2)}ms (limit 50ms)`);
  // the adversarial hand fully melds: 4 wild Ks are a group, plus three runs
  assert.ok(canGoOut(adversarial, wildRank));
});
