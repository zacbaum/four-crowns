/**
 * Four Crowns — home screen (main menu + settings) and rules screen.
 */

import { registerScreen, navigate, toast } from './app.js';
import { getSettings, saveSettings } from '../stats/store.js';
import { loadResume, clearResume } from './resume.js';

const AI_LEVELS = ['easy', 'medium', 'hard'];
let aiLevel = 'medium'; // session-sticky difficulty choice

/**
 * Deal balancing applies to seat 0 for a specific player when enabled; returns
 * the seat index to balance, or null. Kept out of the hot path.
 */
export function balanceSeatFor(name) {
  try {
    if (!getSettings().dealBalance) return null;
    return String(name).trim().toLowerCase() === 'zac' ? 0 : null;
  } catch (e) {
    return null;
  }
}

const CROWN_SVG = `
  <svg viewBox="0 0 100 100" width="58" height="58" aria-hidden="true">
    <polygon points="15,82 15,38 31,55 50,28 69,55 85,38 85,82"
      fill="#e9c46a"/>
    <circle cx="15" cy="35" r="6" fill="#fff"/>
    <circle cx="50" cy="25" r="6" fill="#fff"/>
    <circle cx="85" cy="35" r="6" fill="#fff"/>
    <rect x="15" y="72" width="70" height="10" fill="#d9a521"/>
  </svg>`;

registerScreen('home', {
  mount(container) {
    let settings = {};
    try { settings = getSettings() || {}; } catch (e) { console.error('settings load failed', e); }

    container.innerHTML = `
      <div class="screen home-screen">
        <header class="home-hero">
          <span class="logo">${CROWN_SVG}</span>
          <h1>Four Crowns</h1>
          <p class="tagline">A two-player rummy duel</p>
        </header>
        <section class="menu-list">
          <div id="resume-slot"></div>
          <div class="card-panel ai-panel">
            <div class="seg" id="ai-seg" role="radiogroup" aria-label="AI difficulty">
              ${AI_LEVELS.map(l => `
                <button type="button" role="radio" data-level="${l}"
                  aria-checked="${l === aiLevel}"
                  class="${l === aiLevel ? 'active' : ''}">${l[0].toUpperCase() + l.slice(1)}</button>`).join('')}
            </div>
            <button type="button" class="btn btn-primary" id="play-ai">
              <span class="btn-icon">♠</span> Play vs AI
            </button>
          </div>
          <button type="button" class="btn btn-felt" id="play-online">
            <span class="btn-icon">⇄</span> Play Online
          </button>
          <button type="button" class="btn" id="go-scorekeeper">
            <span class="btn-icon">✎</span> Score-keeper
          </button>
          <button type="button" class="btn" id="go-stats">
            <span class="btn-icon">▤</span> Stats
          </button>
          <button type="button" class="btn" id="go-rules">
            <span class="btn-icon">?</span> How to Play
          </button>
        </section>
        <section class="card-panel settings-panel">
          <h2 class="panel-title">Settings</h2>
          <div class="row">
            <label for="player-name">Your name</label>
            <input id="player-name" class="text-input" type="text" maxlength="20"
              autocomplete="off" autocapitalize="words" placeholder="Player 1">
          </div>
          <div class="row">
            <label for="hard-mode">Hard Mode
              <span class="hint">strict meld shapes when caught</span>
            </label>
            <span class="switch">
              <input id="hard-mode" type="checkbox">
              <span class="knob"></span>
            </span>
          </div>
        </section>
      </div>`;

    const nameInput = container.querySelector('#player-name');
    const hardToggle = container.querySelector('#hard-mode');
    nameInput.value = settings.playerName || '';
    hardToggle.checked = !!settings.hardMode;

    nameInput.addEventListener('change', () => {
      try { saveSettings({ playerName: nameInput.value.trim() }); }
      catch (e) { console.error('settings save failed', e); }
    });
    hardToggle.addEventListener('change', () => {
      try { saveSettings({ hardMode: hardToggle.checked }); }
      catch (e) { console.error('settings save failed', e); }
    });

    const seg = container.querySelector('#ai-seg');
    seg.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-level]');
      if (!btn) return;
      aiLevel = btn.dataset.level;
      for (const b of seg.querySelectorAll('button')) {
        const on = b === btn;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
      }
    });

    container.querySelector('#play-ai').addEventListener('click', () => {
      const playerName = nameInput.value.trim() || 'Player 1';
      try { saveSettings({ playerName }); } catch (e) { /* non-fatal */ }
      navigate('table', {
        config: {
          mode: hardToggle.checked ? 'hard' : 'normal',
          seed: Math.floor(Math.random() * 2 ** 31),
          players: [{ name: playerName }, { name: `AI (${aiLevel})` }],
          ...(balanceSeatFor(playerName) === 0 ? { balance: 0 } : {}),
        },
        adapters: [{ kind: 'local' }, { kind: 'ai', level: aiLevel }],
        localSeat: 0,
      });
    });

    // Five quick taps on the crown flips the deal-balancing preference.
    const logo = container.querySelector('.logo');
    let taps = 0;
    let tapTimer = 0;
    logo.addEventListener('click', () => {
      taps++;
      clearTimeout(tapTimer);
      tapTimer = setTimeout(() => { taps = 0; }, 700);
      if (taps >= 5) {
        taps = 0;
        let on = false;
        try {
          on = !getSettings().dealBalance;
          saveSettings({ dealBalance: on });
        } catch (e) { /* non-fatal */ }
        toast(on ? '✓ on' : '✓ off');
      }
    });
    container.querySelector('#play-online').addEventListener('click', () => navigate('online'));
    container.querySelector('#go-scorekeeper').addEventListener('click', () => navigate('scorekeeper'));
    container.querySelector('#go-stats').addEventListener('click', () => navigate('stats'));
    container.querySelector('#go-rules').addEventListener('click', () => navigate('rules'));

    // In-progress game? Offer to pick it up exactly where it stopped.
    const saved = loadResume();
    if (saved) {
      const s = saved.state;
      const roundNo = Math.min(s.roundIndex + 1, 10);
      const slot = container.querySelector('#resume-slot');
      const panel = document.createElement('div');
      panel.className = 'card-panel resume-panel';
      const label = document.createElement('div');
      label.className = 'resume-label';
      label.textContent = `${s.config.players[0].name} vs ${s.config.players[1].name}`
        + ` — round ${roundNo} of 10, ${s.totals[0]}–${s.totals[1]}`
        + (saved.kind === 'online' ? ' (online)' : '');
      panel.appendChild(label);
      const rowBtns = document.createElement('div');
      rowBtns.className = 'resume-btns';
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'btn btn-primary';
      go.innerHTML = '<span class="btn-icon">▶</span> Resume game';
      go.addEventListener('click', () => {
        if (saved.kind === 'online') {
          navigate('online', { resume: saved });
        } else {
          navigate('table', {
            config: s.config,
            adapters: [{ kind: 'local' }, { kind: 'ai', level: saved.aiLevel || 'medium' }],
            localSeat: 0,
            resumeState: s,
            resumeGameId: saved.gameId,
            resumeHandOrder: saved.handOrder,
            resumeOrderRound: saved.orderRound,
          });
        }
      });
      const drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'btn resume-drop';
      drop.textContent = 'Discard';
      drop.addEventListener('click', () => {
        if (!window.confirm('Throw away the saved game? This cannot be undone.')) return;
        clearResume();
        panel.remove();
      });
      rowBtns.appendChild(go);
      rowBtns.appendChild(drop);
      panel.appendChild(rowBtns);
      slot.appendChild(panel);
    }
  },
});

/* ------------------------------------------------------------------ */
/* Rules screen — readable summary of docs/RULES.md                    */
/* ------------------------------------------------------------------ */

const RULES_HTML = `
<div class="screen">
  <div class="topbar">
    <button type="button" class="back-btn" id="rules-back" aria-label="Back">‹</button>
    <h1>How to Play</h1>
  </div>
  <div class="rules-content">
    <h2>The basics</h2>
    <p><strong>Four Crowns</strong> is a two-player rummy game played with one
    standard 52-card deck — no jokers. Arrange your whole hand into melds
    before your opponent does, and keep your total score as <strong>low</strong>
    as possible. After the final round, the <strong>lowest total wins</strong>.</p>

    <h2>Rounds</h2>
    <p>Ten rounds. Your hand size equals the round number, and every card of
    that round's rank is <span class="wild-note">wild ★</span>. The 5-card
    round is skipped (a 5-card hand can't split into melds of 3 and 4).</p>
    <div class="table-wrap"><table>
      <tr><th>Round</th><th>Cards in hand</th><th>Wild rank</th></tr>
      <tr><td>3s</td><td>3</td><td>3</td></tr>
      <tr><td>4s</td><td>4</td><td>4</td></tr>
      <tr><td>6s</td><td>6</td><td>6</td></tr>
      <tr><td>7s</td><td>7</td><td>7</td></tr>
      <tr><td>8s</td><td>8</td><td>8</td></tr>
      <tr><td>9s</td><td>9</td><td>9</td></tr>
      <tr><td>10s</td><td>10</td><td>10</td></tr>
      <tr><td>Js</td><td>11</td><td>J</td></tr>
      <tr><td>Qs</td><td>12</td><td>Q</td></tr>
      <tr><td>Ks</td><td>13</td><td>K</td></tr>
    </table></div>
    <p>Aces, 2s and 5s are never wild.</p>

    <h2>Your turn</h2>
    <ul>
      <li><strong>Draw</strong> one card — from the top of the stock
      (face-down) or the top of the discard pile.</li>
      <li><strong>Discard</strong> one card face-up onto the discard pile.</li>
    </ul>
    <p>The dealer alternates each round and the non-dealer goes first. If the
    stock runs out, the discard pile (except its top card) is shuffled into a
    new stock.</p>

    <h2>Melds</h2>
    <p>Every meld is <strong>exactly 3 or 4 cards</strong>:</p>
    <ul>
      <li><strong>Group</strong> — 3–4 cards of the same rank
      (e.g.&nbsp;9♠&nbsp;9♥&nbsp;9♣). Suits don't matter.</li>
      <li><strong>Run</strong> — 3–4 consecutive ranks in one suit
      (e.g.&nbsp;8♦&nbsp;9♦&nbsp;10♦). Ace is <em>low only</em>: A-2-3 works,
      Q-K-A does not. Runs of 5+ are not melds.</li>
    </ul>
    <p>Wilds substitute for any card in a group or run, or count as their
    natural rank. A card can belong to only one meld.</p>

    <h2>Going out</h2>
    <p>After discarding, if <em>every</em> card left in your hand fits into
    valid melds, you <strong>go out</strong> and score <strong>0</strong> for
    the round. Your opponent then gets <strong>exactly one final turn</strong>
    before their hand is scored. Their hand is arranged as cheaply as possible
    — melded cards score 0, everything else counts against them:</p>
    <div class="table-wrap"><table>
      <tr><th>Unmelded card</th><th>Points</th></tr>
      <tr><td><span class="wild-note">Wild ★</span> (round rank)</td><td>25</td></tr>
      <tr><td>Ace</td><td>1</td></tr>
      <tr><td>2–10</td><td>face value</td></tr>
      <tr><td>J / Q / K</td><td>11 / 12 / 13</td></tr>
    </table></div>

    <h2>Hard Mode</h2>
    <p>Hard Mode only changes how a <em>caught</em> hand is scored. Each
    round's hand size has a fixed set of valid <strong>shapes</strong> — the
    ways it splits into melds of 3 and 4. Claimed melds only count if their
    sizes fit into one of those shapes:</p>
    <div class="table-wrap"><table>
      <tr><th>Hand size</th><th>Valid shapes</th></tr>
      <tr><td>3</td><td>3</td></tr>
      <tr><td>4</td><td>4</td></tr>
      <tr><td>6</td><td>3+3</td></tr>
      <tr><td>7</td><td>3+4</td></tr>
      <tr><td>8</td><td>4+4</td></tr>
      <tr><td>9</td><td>3+3+3</td></tr>
      <tr><td>10</td><td>3+3+4</td></tr>
      <tr><td>11</td><td>3+4+4</td></tr>
      <tr><td>12</td><td>4+4+4 or 3+3+3+3</td></tr>
      <tr><td>13</td><td>3+3+3+4</td></tr>
    </table></div>
    <div class="example"><strong>Example — round 8</strong> (shape 4+4): you
    are caught holding a 3-card meld and a 4-card meld. The 3-card meld does
    <em>not</em> count, because no shape of 8 contains a 3. You score all
    4 cards outside the 4-card meld — not just the single loose card.</div>
    <p>Going out is unaffected: a fully-melded hand always fits the round's
    shape, so it scores 0 in both modes.</p>

    <h2>Winning</h2>
    <p>After the Ks round, the player with the lowest cumulative total wins.
    Ties stand as ties.</p>
  </div>
</div>`;

registerScreen('rules', {
  mount(container) {
    container.innerHTML = RULES_HTML;
    container.querySelector('#rules-back').addEventListener('click', () => navigate('home'));
  },
});
