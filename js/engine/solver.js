/**
 * Exact hand-arrangement solver for Four Crowns.
 *
 * Meld rules (docs/RULES.md):
 * - Group (3-4 cards): all natural cards share one rank; wilds fill the rest.
 *   An all-wild meld is valid.
 * - Run (3-4 cards): naturals share one suit with distinct ranks and fit a
 *   window of consecutive ranks of the meld's size. The Ace plays LOW (A-2-3)
 *   or HIGH (Q-K-A), but a run never wraps around (K-A-2 is not a run); wilds
 *   fill the gaps.
 *
 * bestArrangement is provably minimal: it enumerates every valid meld in the
 * hand and runs a memoized DFS over the bitmask of hand indices, at each step
 * either leaving the lowest unused card as deadwood or covering it with one of
 * the melds whose lowest index it is. All partitions into disjoint melds +
 * deadwood are reachable, so the maximum melded point total (= minimum
 * deadwood) is exact. In hard mode the running (threes, fours) count must stay
 * a sub-multiset of some valid shape; that constraint is downward-closed, so
 * incremental pruning never cuts off a legal arrangement.
 */

import { rank, suit, cardPoints } from './cards.js';

const shapesCache = new Map();

/**
 * Valid shape multisets for a hand size: every way n partitions into meld
 * sizes 3 and 4, e.g. shapesFor(12) -> [[4,4,4],[3,3,3,3]].
 * @param {number} n
 * @returns {number[][]} fresh arrays (safe to mutate)
 */
export function shapesFor(n) {
  let shapes = shapesCache.get(n);
  if (!shapes) {
    shapes = [];
    for (let fours = Math.floor(n / 4); fours >= 0; fours--) {
      const rem = n - 4 * fours;
      if (rem % 3 === 0) {
        shapes.push([...new Array(fours).fill(4), ...new Array(rem / 3).fill(3)]);
      }
    }
    shapesCache.set(n, shapes);
  }
  return shapes.map(s => s.slice());
}

/**
 * Is the set of hand indices a valid meld (group or run, wilds allowed)?
 * @param {number[]} indices - 3 or 4 indices into the hand
 * @param {number[]} ranks - precomputed ranks of the hand
 * @param {number[]} suits - precomputed suits of the hand
 * @param {number} wildRank
 */
function isValidMeldIndices(indices, ranks, suits, wildRank) {
  const size = indices.length;
  let natRankSame = true;
  let natSuitSame = true;
  let firstRank = -1;
  let firstSuit = -1;
  let hasAce = false;
  const nat = [];
  for (const i of indices) {
    const r = ranks[i];
    if (r === wildRank) continue;
    if (firstRank === -1) {
      firstRank = r;
      firstSuit = suits[i];
    }
    if (r !== firstRank) natRankSame = false;
    if (suits[i] !== firstSuit) natSuitSame = false;
    if (r === 1) hasAce = true;
    nat.push(r);
  }
  if (nat.length === 0) return true; // all wilds: valid (natural book of the wild rank)
  if (natRankSame) return true; // book
  if (!natSuitSame) return false; // run needs one suit
  // Run: fit a consecutive window of `size`, with the ace low (1..K) or, if an
  // ace is present, high (A above K = 14). No wraparound — each mapping is a
  // single contiguous band, so K-A-2 fits neither.
  return fitsRun(nat, size, false) || (hasAce && fitsRun(nat, size, true));
}

/**
 * Do these natural ranks fit some consecutive window of length `size`, wilds
 * filling the gaps? `aceHigh` maps rank 1 -> 14 and shifts the legal band to
 * 2..14; otherwise the band is 1..13. Rejects duplicate ranks.
 */
function fitsRun(nat, size, aceHigh) {
  const bandLo = aceHigh ? 2 : 1;
  const bandHi = aceHigh ? 14 : 13;
  let mn = 99;
  let mx = -1;
  let seen = 0;
  for (let r of nat) {
    if (aceHigh && r === 1) r = 14;
    if (seen & (1 << r)) return false; // duplicate rank
    seen |= 1 << r;
    if (r < mn) mn = r;
    if (r > mx) mx = r;
  }
  if (mx - mn > size - 1) return false;
  const loMin = Math.max(bandLo, mx - size + 1);
  const loMax = Math.min(mn, bandHi - size + 1);
  return loMin <= loMax;
}

/**
 * Enumerate every valid meld in the hand as {mask, points, size}.
 * @param {number[]} hand
 * @param {number} wildRank
 */
function meldMasks(hand, wildRank) {
  const n = hand.length;
  const ranks = new Array(n);
  const suits = new Array(n);
  for (let i = 0; i < n; i++) {
    ranks[i] = rank(hand[i]);
    suits[i] = suit(hand[i]);
  }
  const out = [];
  const consider = indices => {
    if (isValidMeldIndices(indices, ranks, suits, wildRank)) {
      let mask = 0;
      let points = 0;
      for (const i of indices) {
        mask |= 1 << i;
        points += cardPoints(hand[i], wildRank);
      }
      out.push({ mask, points, size: indices.length });
    }
  };
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (let c = b + 1; c < n; c++) {
        consider([a, b, c]);
        for (let d = c + 1; d < n; d++) {
          consider([a, b, c, d]);
        }
      }
    }
  }
  return out;
}

/** Cards of the hand selected by a bitmask of indices. */
function maskCards(mask, hand) {
  const cards = [];
  for (let i = 0; i < hand.length; i++) {
    if (mask & (1 << i)) cards.push(hand[i]);
  }
  return cards;
}

function popcount(v) {
  let n = 0;
  while (v) {
    v &= v - 1;
    n++;
  }
  return n;
}

/** Exact solve (no caching layer). */
function solve(hand, wildRank, mode) {
  const n = hand.length;
  const full = (1 << n) - 1;
  const melds = meldMasks(hand, wildRank);
  const byMin = new Array(n);
  for (let i = 0; i < n; i++) byMin[i] = [];
  for (const m of melds) {
    const low = m.mask & -m.mask;
    byMin[31 - Math.clz32(low)].push(m);
  }

  const hard = mode === 'hard';
  let shapeCounts = null;
  if (hard) {
    shapeCounts = shapesFor(n).map(s => {
      let c3 = 0;
      let c4 = 0;
      for (const x of s) {
        if (x === 3) c3++;
        else c4++;
      }
      return [c3, c4];
    });
  }
  const allowed = (c3, c4) => {
    for (const [a, b] of shapeCounts) {
      if (c3 <= a && c4 <= b) return true;
    }
    return false;
  };

  // memo key -> { pts: max melded points from here, pick: chosen meld mask or 0 }
  const memo = new Map();
  const dfs = (mask, c3, c4) => {
    if (mask === full) return 0;
    const key = (mask << 6) | (c3 << 3) | c4;
    const hit = memo.get(key);
    if (hit !== undefined) return hit.pts;
    const free = ~mask & full;
    const lowBit = free & -free;
    const i = 31 - Math.clz32(lowBit);
    let best = dfs(mask | lowBit, c3, c4); // leave card i as deadwood
    let pick = 0;
    for (const m of byMin[i]) {
      if (m.mask & mask) continue;
      let nc3 = c3;
      let nc4 = c4;
      if (hard) {
        if (m.size === 3) nc3++;
        else nc4++;
        if (!allowed(nc3, nc4)) continue;
      }
      const v = m.points + dfs(mask | m.mask, nc3, nc4);
      if (v > best) {
        best = v;
        pick = m.mask;
      }
    }
    memo.set(key, { pts: best, pick });
    return best;
  };
  const meldedPoints = dfs(0, 0, 0);

  // Reconstruct the optimal choice sequence.
  const meldsOut = [];
  const deadwood = [];
  let mask = 0;
  let c3 = 0;
  let c4 = 0;
  while (mask !== full) {
    const { pick } = memo.get((mask << 6) | (c3 << 3) | c4);
    if (pick === 0) {
      const free = ~mask & full;
      const lowBit = free & -free;
      deadwood.push(hand[31 - Math.clz32(lowBit)]);
      mask |= lowBit;
    } else {
      meldsOut.push(maskCards(pick, hand));
      if (hard) {
        if (popcount(pick) === 3) c3++;
        else c4++;
      }
      mask |= pick;
    }
  }

  let total = 0;
  for (const c of hand) total += cardPoints(c, wildRank);
  return { melds: meldsOut, deadwood, points: total - meldedPoints };
}

function copyResult(r) {
  return {
    melds: r.melds.map(m => m.slice()),
    deadwood: r.deadwood.slice(),
    points: r.points,
  };
}

const CACHE = new Map();
const CACHE_MAX = 4096;

/**
 * Optimal arrangement of a hand.
 * @param {number[]} hand - card ids; hand.length is the round size N (3..13)
 * @param {number} wildRank
 * @param {'normal'|'hard'} mode
 * @returns {{ melds: number[][], deadwood: number[], points: number }}
 *  melds: the claimed melds; deadwood: remaining cards; points: sum of
 *  cardPoints over deadwood — MINIMAL over all legal arrangements for the
 *  given mode (hard mode: strict-shape rule, docs/RULES.md).
 */
export function bestArrangement(hand, wildRank, mode) {
  const key = mode + '|' + wildRank + '|' + hand.slice().sort((x, y) => x - y).join(',');
  const hit = CACHE.get(key);
  if (hit) return copyResult(hit);
  const result = solve(hand, wildRank, mode);
  if (CACHE.size >= CACHE_MAX) CACHE.clear();
  CACHE.set(key, copyResult(result));
  return result;
}

/**
 * Can the whole hand be arranged into valid melds (points === 0)?
 * Mode-independent: a fully-melded hand's meld sizes partition N, which is by
 * definition a complete valid shape.
 * @param {number[]} hand
 * @param {number} wildRank
 * @returns {boolean}
 */
export function canGoOut(hand, wildRank) {
  return bestArrangement(hand, wildRank, 'normal').points === 0;
}

/**
 * All distinct valid melds (3-4 card groups/runs incl. wilds) present in hand.
 * Each meld is an array of card ids. Used by the AI.
 * @param {number[]} hand
 * @param {number} wildRank
 * @returns {number[][]}
 */
export function enumerateMelds(hand, wildRank) {
  return meldMasks(hand, wildRank).map(m => maskCards(m.mask, hand));
}
