/**
 * Card primitives for Four Crowns.
 *
 * A card is an integer 0..51: suit = floor(c / 13) (index into SUITS),
 * rank = (c % 13) + 1 (1 = A … 13 = K).
 */

export const SUITS = ['♠', '♥', '♦', '♣'];
export const RANK_NAMES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/** Rank of a card, 1 = A … 13 = K. */
export const rank = c => (c % 13) + 1;

/** Suit index of a card, 0..3 (index into SUITS). */
export const suit = c => Math.floor(c / 13);

/** Card id for a rank (1..13) and suit index (0..3). */
export const makeCard = (r, s) => s * 13 + (r - 1);

/** Human-readable name, e.g. "10♥". */
export const cardName = c => RANK_NAMES[rank(c) - 1] + SUITS[suit(c)];

/** Is the card wild for the given wild rank? */
export const isWild = (c, wildRank) => rank(c) === wildRank;

/** Point value of an unmelded card: wilds 25, A 1, 2-10 face, J 11, Q 12, K 13. */
export const cardPoints = (c, wildRank) => (isWild(c, wildRank) ? 25 : rank(c));

/** Hand size per round; hand size = wild rank (the 5-card round is skipped). */
export const ROUNDS = [3, 4, 6, 7, 8, 9, 10, 11, 12, 13];

/**
 * Mulberry32 seeded PRNG.
 * @param {number} seed - integer seed
 * @returns {() => number} function returning floats in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = t ^ (t + Math.imul(t ^ (t >>> 7), t | 61));
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher-Yates shuffled copy of an array (input is not modified).
 * @param {Array} arr
 * @param {() => number} rng - returns floats in [0, 1)
 * @returns {Array} new shuffled array
 */
export function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}
