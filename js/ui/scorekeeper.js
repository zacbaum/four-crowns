/**
 * Four Crowns — score-keeper screen for games played with a real deck.
 * Two names, a 10-row score grid (one row per round), live totals,
 * "went out" markers, autosaved draft, save to the stats store.
 */

import { registerScreen, navigate, toast } from './app.js';
import { saveGame, getSettings } from '../stats/store.js';

const DRAFT_KEY = 'fourcrowns.scorekeeper.draft';

const SK_ROUNDS = [
  { round: 3, label: '3' },
  { round: 4, label: '4' },
  { round: 6, label: '6' },
  { round: 7, label: '7' },
  { round: 8, label: '8' },
  { round: 9, label: '9' },
  { round: 10, label: '10' },
  { round: 11, label: 'J' },
  { round: 12, label: 'Q' },
  { round: 13, label: 'K' },
];

function emptyDraft() {
  return {
    names: ['', ''],
    rows: SK_ROUNDS.map(() => ({ a: '', b: '', out: null })),
  };
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.rows) || d.rows.length !== SK_ROUNDS.length) return null;
    return d;
  } catch (e) {
    return null;
  }
}

function saveDraft(draft) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch (e) { /* storage full */ }
}

function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* ignore */ }
}

/** '' -> NaN; digits-only string -> int */
function parseScore(v) {
  return /^\d{1,3}$/.test(v) ? parseInt(v, 10) : NaN;
}

registerScreen('scorekeeper', {
  mount(container) {
    const draft = loadDraft() || emptyDraft();
    if (!draft.names[0]) {
      try { draft.names[0] = (getSettings() || {}).playerName || ''; } catch (e) { /* ignore */ }
    }

    const rowsHtml = SK_ROUNDS.map((r, i) => `
      <div class="sk-round-label">${r.label}</div>
      <div class="sk-cell">
        <button type="button" class="out-btn" data-row="${i}" data-p="0"
          aria-label="Player 1 went out round ${r.label}" title="went out">★</button>
        <input class="sk-input" data-row="${i}" data-p="0" type="text"
          inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off">
      </div>
      <div class="sk-cell">
        <input class="sk-input" data-row="${i}" data-p="1" type="text"
          inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off">
        <button type="button" class="out-btn" data-row="${i}" data-p="1"
          aria-label="Player 2 went out round ${r.label}" title="went out">★</button>
      </div>`).join('');

    container.innerHTML = `
      <div class="screen">
        <div class="topbar">
          <button type="button" class="back-btn" id="sk-back" aria-label="Back">‹</button>
          <h1>Score-keeper</h1>
        </div>
        <div class="sk-names">
          <input class="text-input p1" id="sk-name-0" type="text" maxlength="20"
            placeholder="Player 1" autocomplete="off" autocapitalize="words">
          <input class="text-input p2" id="sk-name-1" type="text" maxlength="20"
            placeholder="Player 2" autocomplete="off" autocapitalize="words">
        </div>
        <div class="sk-grid">
          <div class="sk-head">Rd</div>
          <div class="sk-head" id="sk-head-0">Player 1</div>
          <div class="sk-head" id="sk-head-1">Player 2</div>
          ${rowsHtml}
        </div>
        <div class="sk-totals">
          <div class="sk-round-label">Total</div>
          <div class="sk-total p1" id="sk-total-0">0</div>
          <div class="sk-total p2" id="sk-total-1">0</div>
        </div>
        <p class="sk-legend">Tap ★ next to a score to mark who went out
          (their score becomes 0, but stays editable).</p>
        <div class="sk-actions">
          <button type="button" class="btn btn-primary" id="sk-finish">Finish Game</button>
          <button type="button" class="btn" id="sk-save-unfinished">Save Unfinished</button>
        </div>
      </div>`;

    const nameInputs = [container.querySelector('#sk-name-0'), container.querySelector('#sk-name-1')];
    const heads = [container.querySelector('#sk-head-0'), container.querySelector('#sk-head-1')];
    const totalsEls = [container.querySelector('#sk-total-0'), container.querySelector('#sk-total-1')];
    const scoreInputs = Array.from(container.querySelectorAll('.sk-input'));
    const outBtns = Array.from(container.querySelectorAll('.out-btn'));

    const inputAt = (row, p) =>
      scoreInputs.find(el => +el.dataset.row === row && +el.dataset.p === p);
    const outBtnAt = (row, p) =>
      outBtns.find(el => +el.dataset.row === row && +el.dataset.p === p);

    function playerName(p) {
      return nameInputs[p].value.trim() || `Player ${p + 1}`;
    }

    function refreshHeads() {
      heads[0].textContent = playerName(0);
      heads[1].textContent = playerName(1);
    }

    function totals() {
      const t = [0, 0];
      for (const row of draft.rows) {
        const a = parseScore(row.a);
        const b = parseScore(row.b);
        if (!Number.isNaN(a)) t[0] += a;
        if (!Number.isNaN(b)) t[1] += b;
      }
      return t;
    }

    function refreshTotals() {
      const t = totals();
      totalsEls[0].textContent = String(t[0]);
      totalsEls[1].textContent = String(t[1]);
    }

    function refreshOutButtons(row) {
      for (const p of [0, 1]) {
        outBtnAt(row, p).classList.toggle('active', draft.rows[row].out === p);
      }
    }

    // ---- restore draft into the DOM ----
    nameInputs[0].value = draft.names[0] || '';
    nameInputs[1].value = draft.names[1] || '';
    draft.rows.forEach((row, i) => {
      inputAt(i, 0).value = row.a;
      inputAt(i, 1).value = row.b;
      refreshOutButtons(i);
    });
    refreshHeads();
    refreshTotals();

    // ---- events ----
    nameInputs.forEach((el, p) => {
      el.addEventListener('input', () => {
        draft.names[p] = el.value;
        refreshHeads();
        saveDraft(draft);
      });
    });

    scoreInputs.forEach((el) => {
      el.addEventListener('input', () => {
        const clean = el.value.replace(/\D/g, '').slice(0, 3);
        if (clean !== el.value) el.value = clean;
        const row = +el.dataset.row;
        const p = +el.dataset.p;
        draft.rows[row][p === 0 ? 'a' : 'b'] = clean;
        el.classList.remove('missing');
        refreshTotals();
        saveDraft(draft);
      });
    });

    outBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = +btn.dataset.row;
        const p = +btn.dataset.p;
        const r = draft.rows[row];
        if (r.out === p) {
          r.out = null; // tap again to unset
        } else {
          r.out = p;
          const key = p === 0 ? 'a' : 'b';
          if (r[key] === '') {
            r[key] = '0';
            inputAt(row, p).value = '0';
          }
        }
        refreshOutButtons(row);
        refreshTotals();
        saveDraft(draft);
      });
    });

    function buildGame(finished) {
      const t = totals();
      const rounds = [];
      draft.rows.forEach((row, i) => {
        const a = parseScore(row.a);
        const b = parseScore(row.b);
        if (!Number.isNaN(a) && !Number.isNaN(b)) {
          rounds.push({ round: SK_ROUNDS[i].round, scores: [a, b], wentOut: row.out });
        }
      });
      let hardMode = false;
      try { hardMode = !!(getSettings() || {}).hardMode; } catch (e) { /* ignore */ }
      return {
        id: crypto.randomUUID(),
        dateISO: new Date().toISOString(),
        kind: 'scorekeeper',
        aiLevel: null,
        hardMode,
        players: [playerName(0), playerName(1)],
        rounds,
        totals: t,
        winner: finished ? (t[0] < t[1] ? 0 : t[1] < t[0] ? 1 : 'tie') : null,
        finished,
      };
    }

    container.querySelector('#sk-finish').addEventListener('click', () => {
      // validate: every round needs both scores
      let firstMissing = null;
      draft.rows.forEach((row, i) => {
        for (const p of [0, 1]) {
          const v = p === 0 ? row.a : row.b;
          if (Number.isNaN(parseScore(v))) {
            const el = inputAt(i, p);
            el.classList.add('missing');
            if (!firstMissing) firstMissing = { el, label: SK_ROUNDS[i].label };
          }
        }
      });
      if (firstMissing) {
        toast(`Missing score in the ${firstMissing.label}s round`);
        firstMissing.el.focus();
        return;
      }
      const game = buildGame(true);
      try {
        saveGame(game);
      } catch (e) {
        console.error('saveGame failed', e);
        toast('Could not save the game');
        return;
      }
      clearDraft();
      if (game.winner === 'tie') {
        toast(`It's a tie — ${game.totals[0]} each!`);
      } else {
        toast(`${game.players[game.winner]} wins ${game.totals[game.winner]}–${game.totals[1 - game.winner]}!`);
      }
      navigate('stats');
    });

    container.querySelector('#sk-save-unfinished').addEventListener('click', () => {
      const game = buildGame(false);
      try {
        saveGame(game);
      } catch (e) {
        console.error('saveGame failed', e);
        toast('Could not save the game');
        return;
      }
      clearDraft();
      toast('Saved as unfinished');
      navigate('stats');
    });

    container.querySelector('#sk-back').addEventListener('click', () => navigate('home'));
  },
});
