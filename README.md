# Four Crowns

A two-player rummy duel — a variant of *Five Crowns* played with a single
standard 52-card deck. Installable web app (PWA): play against an AI, play a
friend on two phones, or use it as a smart scorepad for a real-card game, with
running scores and a full analytics tab.

**Play it:** https://zacbaum.github.io/four-crowns/ — open on your iPhone in
Safari, then **Share → Add to Home Screen** for a full-screen, offline-capable
app.

## The game

Ten rounds. The hand size is the round number and that rank is **wild**
(the 5-card round is skipped, since five cards can't be split into sets of 3
and 4):

| Round | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|-------|---|---|---|---|---|---|---|---|---|----|
| Cards / wild | 3 | 4 | 6 | 7 | 8 | 9 | 10 | J | Q | K |

On your turn, draw one card (from the stock or the discard pile) and discard
one. Arrange your hand into **sets** — every set is exactly 3 or 4 cards:

- **Book** — 3–4 cards of the same rank.
- **Run** — 3–4 consecutive cards of one suit (Ace is low; no wrap-around).

Wild cards (the round's rank) stand in for any card. When your whole hand forms sets,
you **go out** and score 0; your opponent gets one last turn, then scores the
cards they're caught holding: A = 1, 2–10 = face value, J/Q/K = 11/12/13, and a
wild = 25. Lowest cumulative total after the K round wins.

**Hard Mode** changes only how a caught hand scores: your sets count only if
their sizes can still complete a valid shape for the round (e.g. in the 8-card
round the only shape is 4+4, so a 3-card set doesn't count). Full rules are in
[docs/RULES.md](docs/RULES.md) and on the app's *How to Play* screen.

## Three ways to play

- **vs AI** — three difficulty levels (Easy / Medium / Hard) to practice against.
- **Online** — one player taps *Create game* and shares the 5-letter room code;
  the other taps *Join* and enters it. The two phones play in real time,
  peer-to-peer (both need an internet connection). *(Both devices live at once —
  this is real-time, not correspondence play.)*
- **Score-keeper** — playing with a physical deck? Enter each round's scores and
  the app keeps totals, decides the winner, and feeds the analytics.

## Stats

Everything is stored locally on your device (no account, no server). The in-game
view shows running scores and the per-round table; the **Stats** tab adds score
trajectories, average points by round, totals over time, caught-points
distributions, going-out rates and head-to-head records. Use **Export / Import**
(JSON) in the Stats tab to back up or move your history between devices.

## Difficulty levels

All three levels share one strong point-minimizing strategy; difficulty is how
reliably it's played. **Easy** slips often (beatable by a casual player),
**Medium** occasionally, and **Hard** plays optimally with correct end-game
scoring and light card-counting defense. (Ordering validated by seat-balanced
self-play — see `tests/ai.test.mjs`.)

## Develop locally

No build step — it's vanilla ES modules. Serve the folder statically:

```sh
npm run serve      # http://127.0.0.1:8123
npm test           # engine, solver, analytics and AI test suites
```

## How it's built

- `js/engine/` — pure, deterministic game engine: card math, an exact set
  solver (optimal hand arrangement in both modes), and the turn state machine.
- `js/ai/` — the AI opponents.
- `js/ui/` — screens (home, game table, scorekeeper, stats, online) and a tiny
  hash router. `js/stats/` — local storage + analytics. `js/net/` — WebRTC
  peer-to-peer sync (PeerJS).
- Same seeded engine runs on both online devices, so they only exchange moves
  and stay perfectly in sync.
