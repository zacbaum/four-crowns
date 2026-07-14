# Four Crowns — Official Rules (source of truth)

A 2-player rummy variant of Five Crowns played with one standard 52-card deck.
This document is the **single source of truth** for the game engine, the AI, and
all tests. If code disagrees with this file, the code is wrong.

## Deck

- One standard 52-card deck: ranks A, 2, 3, …, 10, J, Q, K in four suits
  (♠ ♥ ♦ ♣). **No jokers.**
- Rank order for runs: A is LOW only (A-2-3 is a run start; Q-K-A and K-A-2 are
  NOT runs — no wraparound).

## Rounds

Ten rounds. Hand size equals the round number. **The 5-card round is skipped**
(a 5-card hand cannot be partitioned into melds of size 3 and 4).

| # | Round | Hand size | Wild rank |
|---|-------|-----------|-----------|
| 1 | 3s    | 3         | 3         |
| 2 | 4s    | 4         | 4         |
| 3 | 6s    | 6         | 6         |
| 4 | 7s    | 7         | 7         |
| 5 | 8s    | 8         | 8         |
| 6 | 9s    | 9         | 9         |
| 7 | 10s   | 10        | 10        |
| 8 | Js    | 11        | 11 (J)    |
| 9 | Qs    | 12        | 12 (Q)    |
| 10| Ks    | 13        | 13 (K)    |

Aces, 2s and 5s are never wild.

## Wild cards

- In each round, all four cards of the wild rank are wild.
- A wild card may substitute for **any** card in a group or a run.
- A wild may also be played as its natural self (e.g. in round 7, 7♠ 7♥ 7♦ is
  simply a group of 7s — note that because all wilds share one rank, a set of
  3–4 wilds is always also a natural group, so this never creates ambiguity).
- An unmelded wild scores **25 points**.

## Melds

Only two meld shapes exist, and **every meld is exactly 3 or 4 cards**:

1. **Group**: 3 or 4 cards of the same rank (suits irrelevant). Wilds may fill
   any slots; the natural (non-wild) cards must all share one rank.
2. **Run**: 3 or 4 consecutive ranks in a **single suit** (e.g. 8♦ 9♦ 10♦).
   Wilds may fill any slots; the naturals must all be the same suit and must fit
   a window of consecutive ranks of the meld's size within A..K (A low, no
   wraparound). Runs of 5 or more are NOT melds (a 6-card same-suit sequence
   melds only as two runs of 3, etc.).

A card can belong to at most one meld.

## Card points (unmelded cards only)

| Card | Points |
|------|--------|
| Wild (round rank) | 25 |
| A | 1 |
| 2–10 | face value |
| J | 11 |
| Q | 12 |
| K | 13 |

Melded cards score 0.

## Play

1. Deal: hand-size cards to each player. The dealer alternates every round
   (player 0 deals round 1). The **non-dealer takes the first turn**.
2. After dealing, flip one card face-up to start the discard pile; the rest is
   the face-down stock.
3. On your turn: **draw** one card (top of stock OR top of discard pile), then
   **discard** one card face-up onto the discard pile.
4. **Stock exhaustion**: if the stock is empty when a player must draw, take the
   discard pile except its top card, shuffle it, and it becomes the new stock
   (the top discard stays as the discard pile).

## Going out and ending a round

- After discarding, if **every** card remaining in your hand can be arranged
  into valid melds, you **go out**: reveal your melds and score **0** for the
  round. (Because every meld is size 3 or 4, a fully-melded hand automatically
  satisfies the round's hard-mode shape, so going out is identical in both
  modes.)
- Your opponent then gets **exactly one final turn** (draw + discard), after
  which the round ends and they score their hand (0 if they also fully meld —
  no bonus either way).
- Scoring a caught hand: arrange it to **minimize** points; melded cards score
  0 and every other card scores its point value (wilds 25). The engine always
  computes the optimal arrangement for the player.

## Hard mode (strict shape)

Hard mode changes only how a **caught** (non-going-out) hand is scored.

Each round's hand size N has a set of valid **shapes** — the ways N partitions
into meld sizes 3 and 4:

| N | Valid shapes |
|---|--------------|
| 3 | {3} |
| 4 | {4} |
| 6 | {3,3} |
| 7 | {3,4} |
| 8 | {4,4} |
| 9 | {3,3,3} |
| 10 | {3,3,4} |
| 11 | {3,4,4} |
| 12 | {4,4,4} and {3,3,3,3} |
| 13 | {3,3,3,4} |

**Strict-shape rule**: a set of claimed melds is legal only if the multiset of
their sizes can be **extended to a complete valid shape** for that round (i.e.
it is a sub-multiset of some valid shape of N).

Examples:
- Round 8 (shape {4,4}): holding a 3-meld and a 4-meld, the 3-meld does NOT
  count ({3} extends to no shape of 8). You score the 4 cards outside the
  4-meld — not just the 1 loose card.
- Round 10 (shape {3,3,4}): holding two 4-melds and 2 loose cards, only ONE
  4-meld counts ({4,4} extends to no shape of 10). You score 6.
- Round 12: {4,4} is legal (extends to {4,4,4}); {3,4} is NOT (neither shape of
  12 contains both a 3 and a 4).

Scoring in hard mode = the minimum points over all legal claimed-meld sets.

## Game end

After the Ks round, the player with the **lowest cumulative total wins**. Ties
stand as ties.
