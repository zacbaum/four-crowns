# Four Crowns — Architecture & Module Contracts (source of truth)

Every module below is built against these contracts. If you need something a
contract doesn't provide, extend YOUR module — do not change another module's
contract.

## Ground rules

- **Vanilla ES modules. No build step. No frameworks.** The app must run by
  serving this directory statically.
- **No external runtime dependencies** except a vendored `js/vendor/peerjs.min.js`.
- **All URLs relative** (`./js/main.js`, `./icons/icon-192.png`) — the app is
  deployed under a subpath (`https://<user>.github.io/four-crowns/`).
- Mobile-first: design for iPhone widths (~390px), scale up gracefully.
- Engine + AI + stats modules must be pure (no DOM, no localStorage) so they run
  under `node --test`. Only `js/ui/*`, `js/net/*`, `js/stats/store.js` and
  `js/main.js` may touch browser APIs.
- Plain JavaScript everywhere. JSDoc comments for public functions.

## File ownership (one owner per file)

| Area | Files |
|------|-------|
| engine | `js/engine/cards.js`, `js/engine/solver.js`, `js/engine/game.js`, `tests/solver.test.mjs`, `tests/game.test.mjs` |
| ai | `js/ai/ai.js`, `tests/ai.test.mjs` |
| ui-foundation | `index.html`, `css/app.css`, `js/ui/app.js`, `js/ui/cards-render.js`, `js/ui/home.js`, `js/ui/scorekeeper.js`, `js/main.js`, `manifest.webmanifest`, `sw.js` |
| table | `js/ui/table.js` |
| net | `js/net/sync.js`, `js/ui/online.js`, `js/vendor/peerjs.min.js` |
| stats | `js/stats/store.js`, `js/stats/analytics.js`, `js/ui/stats-ui.js`, `tests/analytics.test.mjs` |

## Card encoding

A card is an **integer 0–51**.

```js
// js/engine/cards.js
export const SUITS = ['♠', '♥', '♦', '♣'];          // suit index 0..3
export const RANK_NAMES = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
export const rank = c => (c % 13) + 1;               // 1 = A … 13 = K
export const suit = c => Math.floor(c / 13);         // 0..3
export const makeCard = (r, s) => s * 13 + (r - 1);
export const cardName = c => RANK_NAMES[rank(c) - 1] + SUITS[suit(c)];
export const isWild = (c, wildRank) => rank(c) === wildRank;
export const cardPoints = (c, wildRank) => isWild(c, wildRank) ? 25 : rank(c);
export const ROUNDS = [3, 4, 6, 7, 8, 9, 10, 11, 12, 13]; // hand size = wild rank
export function mulberry32(seed) { /* returns () => float in [0,1) */ }
export function shuffled(arr, rng) { /* Fisher-Yates copy, uses rng */ }
```

## Solver — `js/engine/solver.js`

```js
/**
 * Optimal arrangement of a hand.
 * @param {number[]} hand - card ids; hand.length is the round size N (3..13)
 * @param {number} wildRank
 * @param {'normal'|'hard'} mode
 * @returns {{ melds: number[][], deadwood: number[], points: number }}
 *  - melds: the claimed melds (each an array of card ids from hand)
 *  - deadwood: remaining card ids
 *  - points: sum of cardPoints over deadwood — MINIMAL over all legal
 *    arrangements for the given mode (hard mode: strict-shape rule, RULES.md)
 */
export function bestArrangement(hand, wildRank, mode)

/** points === 0 for the given hand? (mode-independent — see RULES.md) */
export function canGoOut(hand, wildRank)

/** All distinct valid melds (3-4 card groups/runs incl. wilds) present in hand.
 *  Used by the AI. Each meld is an array of card ids. */
export function enumerateMelds(hand, wildRank)

/** Valid shape multisets for a hand size, e.g. 12 -> [[4,4,4],[3,3,3,3]] */
export function shapesFor(n)
```

Performance: must handle N=13 with many wilds in <50ms typical. Recommended:
enumerate candidate melds, then memoized DFS over the remaining-card multiset
choosing melds, tracking the size-multiset for hard mode. Exactness matters
more than speed, but the AI calls this in loops — cache where sensible.

## Game engine — `js/engine/game.js`

Deterministic, pure, serializable state. Reducer style: every mutation is
`applyAction(state, action) -> newState` (may mutate in place and return
`state`; callers treat the return as canonical). Randomness ONLY via the seeded
rng stored in state (`rngState` advances deterministically) so host and guest
replay identically.

```js
export function createGame(config) -> state
// config = {
//   mode: 'normal' | 'hard',
//   seed: number,                     // integer
//   players: [ {name}, {name} ],      // index 0 and 1
// }

export function applyAction(state, action) -> state
// action = { type: 'draw', player: 0|1, source: 'stock'|'discard' }
//        | { type: 'discard', player: 0|1, card: number }
//        | { type: 'nextRound' }   // acknowledge round summary, deal next
// Throws Error on illegal actions (wrong player, wrong phase, card not in hand).

export function legalActions(state) -> action[]   // for AI + UI enabling
```

### State shape

```js
state = {
  config,                          // as passed to createGame
  roundIndex: 0..9,                // index into ROUNDS
  handSize, wildRank,              // = ROUNDS[roundIndex]
  dealer: 0|1,                     // roundIndex % 2 (player 0 deals round 0)
  turn: 0|1,                       // whose turn
  phase: 'draw'|'discard'|'roundEnd'|'gameOver',
  hands: [number[], number[]],
  stock: number[],                 // top = last element
  discard: number[],               // top = last element
  wentOut: null|0|1,               // who went out this round
  lastTurnFor: null|0|1,           // opponent who still gets a final turn
  roundResults: [                  // one entry per finished round
    { round, wildRank, scores: [a, b], wentOut: 0|1,
      arrangements: [{melds, deadwood, points}, {melds, deadwood, points}] }
  ],
  totals: [a, b],
  rngState: number,
  winner: null|0|1|'tie',          // set when phase === 'gameOver'
}
```

### Semantics (must match RULES.md)

- `createGame` deals round 0 immediately: shuffle 0..51, deal handSize to each
  starting with non-dealer, flip 1 to discard. `turn` = non-dealer, `phase` = 'draw'.
- `draw` from empty stock: first reshuffle discard-minus-top into stock (seeded
  rng), then draw. Drawing from an empty discard is illegal.
- After `discard`: if the discarding player's remaining hand has
  `canGoOut(...)`, set `wentOut` (only if nobody went out yet this round) and
  `lastTurnFor = opponent`. If `wentOut !== null` and the player who just
  discarded is `lastTurnFor`, the round ends: score both hands with
  `bestArrangement(hand, wildRank, config.mode)` (goer-out scores 0 — their
  arrangement will be all melds anyway), push roundResults, update totals,
  `phase = 'roundEnd'`.
- `nextRound` (only in 'roundEnd'): advance roundIndex, redeal; after round 9,
  `phase = 'gameOver'`, set `winner` (lowest total, 'tie' on equality).
- A player may draw the card they need from EITHER pile; no other restrictions.
- Full-deck invariant: hands + stock + discard always contain exactly the 52
  distinct cards outside of roundEnd/gameOver phases.

## AI — `js/ai/ai.js`

```js
/**
 * Decide the current player's next action for the state's phase
 * ('draw' -> a draw action, 'discard' -> a discard action).
 * Never returns an illegal action. Uses rng for tie-breaking.
 * @param {'easy'|'medium'|'hard'} level
 * @param {object} state    - full game state (AI may read opponent-visible
 *                            info ONLY: discard pile, counts, roundResults.
 *                            It must NOT read state.hands[opponent] except
 *                            hard level MAY track cards the opponent drew
 *                            from the discard pile via the observation log)
 * @param {() => number} rng
 */
export function chooseAction(level, state, rng) -> action
```

- easy: shallow — takes the discard only if it immediately joins a meld; discards
  the highest-point card not in a meld; no memory.
- medium: evaluates every legal (draw, discard) pair by resulting
  `bestArrangement` points plus partial-meld potential (pairs, 2-card run
  gaps); prefers keeping wilds; no card counting.
- hard: medium + card counting (cards seen in discard history are dead),
  probability-weighted potential, avoids discarding cards adjacent/equal in
  rank to cards the opponent took from the discard pile, and goes defensive
  (dump high cards) when the opponent is likely close to out.
- All levels must go out when possible... EXCEPT a level may choose to keep
  playing only if rules allow (they don't — going out is automatic on discard
  per the engine, so the AI just plays its best discard).

## Player adapters (how the table screen drives a game)

`js/ui/table.js` exports:

```js
/**
 * Mount the game screen into container and run a full game.
 * @param {object} opts
 *   opts.config      - createGame config
 *   opts.adapters    - [adapter0, adapter1]; adapter is one of:
 *       { kind: 'local' }                         // this device's human
 *       { kind: 'ai', level: 'easy'|'medium'|'hard' }
 *       { kind: 'remote',                          // player on other device
 *         onLocalAction: (action) => void,        // called for every action
 *                                                  // applied locally that the
 *                                                  // remote peer must replay
 *         registerRemoteActionHandler: (fn) => void } // table calls this once;
 *                                                  // net calls fn(action) when
 *                                                  // the peer sends an action
 *   opts.localSeat   - 0|1 (which seat is this device; AI/scorekeeper: 0)
 *   opts.onGameEnd   - (state) => void   // navigate away + persist stats
 *   opts.onQuit      - () => void
 */
export function startTable(container, opts)
```

The table owns the game loop: when `state.turn`'s adapter is 'ai' it calls
`chooseAction` (with a small thinking delay); 'local' waits for tap input;
'remote' waits for the remote action handler. EVERY applied action is reported
via `onLocalAction` on the remote adapter if present (except actions that
originated remotely).

## Net — `js/net/sync.js` + `js/ui/online.js`

- Vendored PeerJS (`js/vendor/peerjs.min.js`, classic script exposing `window.Peer`,
  loaded lazily by online.js only when entering online mode).
- Room codes: 5 uppercase letters (no ambiguous chars), peer id
  `four-crowns-<CODE>`. Host creates game (chooses seed + config), guest joins.
- Protocol (JSON messages):
  - guest -> host: `{t:'hello', name}`
  - host -> guest: `{t:'start', config, guestSeat: 1}`
  - both: `{t:'action', action}` — sender already applied it locally; receiver
    applies via `applyAction`. Determinism (same seed) keeps states identical.
  - both: `{t:'bye'}` on quit.
- Host validates guest actions with `legalActions` before applying; on
  divergence/error, host sends `{t:'state', state}` full resync.
- `js/ui/online.js` renders the host/join screen (create code, enter code,
  names) and wires remote adapters into `startTable`.

## Stats — storage schema (`js/stats/store.js`)

localStorage key `fourcrowns.v1`:

```js
{
  settings: { hardMode: bool, playerName: string },
  games: [ {
    id: string,                    // crypto.randomUUID()
    dateISO: string,
    kind: 'ai' | 'online' | 'scorekeeper',
    aiLevel: null | 'easy'|'medium'|'hard',
    hardMode: bool,
    players: [string, string],     // names; index 0 = local/first player
    rounds: [ { round: 3|4|6|...|13, scores: [a, b], wentOut: 0|1|null } ],
    totals: [a, b],
    winner: 0|1|'tie'|null,        // null = unfinished/abandoned
    finished: bool,
  } ]
}
```

API: `loadDB()`, `saveGame(game)`, `updateGame(game)`, `getGames()`,
`getSettings()`, `saveSettings(patch)`, `deleteGame(id)`, `exportJSON()`,
`importJSON(text)`.

`js/stats/analytics.js` (pure, node-testable): takes `games[]`, returns derived
metrics (win rates, head-to-head, per-round-number averages, score
trajectories, going-out rates, caught-points distribution, streaks, totals over
time). Exact shapes are the stats owner's choice — they own both producer and
consumer (`stats-ui.js`).

## UI shell — `js/ui/app.js`

Tiny hash router. Contract for other UI modules:

```js
export function registerScreen(name, { mount })  // mount(container, params)
export function navigate(name, params = {})       // sets location.hash
export function toast(message)
```

Screens: `home`, `table` (params: config+adapters via navigate params object
passed in-memory, NOT serialized to hash), `online`, `scorekeeper`, `stats`,
`rules`. `js/main.js` imports all screen modules, registers the service worker
(`./sw.js`, relative), and navigates to `home`.

## In-game stats (core, lives in table.js)

Running totals, per-round score table (both players), current round + wild
indicator, deadwood points for the local player's current best arrangement
(the hand auto-groups by the solver's melds).

## Design tokens (css/app.css)

Light + dark via `prefers-color-scheme` AND a `data-theme` override on <html>.
Chart/series colors (from the validated dataviz palette):

```css
:root {
  --surface-1: #fcfcfb; --page: #f9f9f7;
  --ink-1: #0b0b0b; --ink-2: #52514e; --ink-muted: #898781;
  --grid: #e1e0d9; --baseline: #c3c2b7;
  --series-1: #2a78d6; --series-2: #e34948;  /* player A / player B */
  --accent: #2a78d6; --good: #0ca30c; --critical: #d03b3b;
  --felt: #1e4d36;   /* card table felt (game screen bg) */
}
[data-theme="dark"], (and the media query) {
  --surface-1: #1a1a19; --page: #0d0d0d;
  --ink-1: #ffffff; --ink-2: #c3c2b7; --ink-muted: #898781;
  --grid: #2c2c2a; --baseline: #383835;
  --series-1: #3987e5; --series-2: #e66767;
  --felt: #163826;
}
```

Cards render as DOM elements (`js/ui/cards-render.js`): white card face in both
themes, red suits #d03b3b, black suits #1a1a19, rounded corners, rank+suit in
corner, large center suit glyph, gold ring/badge when wild. Standard playing
card aspect ratio 5:7. Must stay readable at 13 cards across an iPhone screen
(overlapping fan/grid — cards-render exposes a `handRow(cards, opts)` helper).

## PWA

- `manifest.webmanifest`: name "Four Crowns", short_name "4 Crowns",
  `start_url: "."`, `scope: "."`, display standalone, theme/background colors,
  icons 192+512 (+ maskable).
- `index.html`: `<link rel="apple-touch-icon" href="./icons/icon-180.png">`,
  `apple-mobile-web-app-capable`, viewport with `viewport-fit=cover`, safe-area
  insets respected in CSS.
- `sw.js`: cache-first for the app shell (all local files, RELATIVE paths),
  network-falling-back-to-cache; bump `CACHE_VERSION` string to invalidate.
  Must not break when peerjs CDN is unreachable (peerjs is vendored/local).

## Testing

- `node --test tests/` — no dependencies, plain `node:test` + `assert`.
- Engine tests must include: solver correctness vs a brute-force reference on
  randomized small hands, the RULES.md hard-mode examples verbatim, full
  AI-vs-AI and random-legal-move playthroughs asserting the full-deck
  invariant, termination, and score bookkeeping.
