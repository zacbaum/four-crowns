/**
 * Four Crowns — online play screen ('online').
 *
 * Host flow:  Create game -> share 5-letter code -> guest hello arrives ->
 *             Start game -> {t:'start', config} -> table (seat 0).
 * Guest flow: Join game -> enter code -> {t:'hello'} -> wait ->
 *             {t:'start'} received -> table (seat 1).
 *
 * Determinism: both devices run the same engine with the same seed; only
 * actions cross the wire and are replayed in order. A local "shadow" copy of
 * the game state is kept here to (a) silently drop duplicate actions (e.g.
 * both players tapping "next round") and (b) save unfinished games on
 * disconnect/quit. The table screen owns the real game state.
 */

import { registerScreen, navigate, toast } from './app.js';
import { getSettings, saveSettings, saveGame } from '../stats/store.js';
import { createRoom, joinRoom, normalizeRoomCode, isValidRoomCode } from '../net/sync.js';
import { createGame, applyAction } from '../engine/game.js';

/* ------------------------------------------------------------------ */
/* Styles (injected once; "on-" prefix; reuses app.css tokens)         */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'on-style';
const CSS = `
.on-actions { display: grid; gap: 12px; margin-top: 16px; }
.on-note {
  color: var(--ink-muted); font-size: 13px; text-align: center;
  margin-top: 14px; line-height: 1.45;
}
.on-code-panel { text-align: center; padding: 22px 16px; display: grid; gap: 8px; }
.on-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: clamp(44px, 15vw, 64px); font-weight: 800;
  letter-spacing: .14em; line-height: 1.1; color: var(--ink-1);
  user-select: all; -webkit-user-select: all;
}
.on-hint { color: var(--ink-muted); font-size: 14px; }
.on-status {
  display: flex; align-items: center; justify-content: center; gap: 10px;
  margin: 18px 0; color: var(--ink-2); font-weight: 600; min-height: 24px;
  text-align: center;
}
.on-status .on-guest { color: var(--good); }
.on-spinner {
  width: 18px; height: 18px; flex: 0 0 auto; border-radius: 50%;
  border: 3px solid var(--grid); border-top-color: var(--accent);
  animation: on-spin .9s linear infinite;
}
@keyframes on-spin { to { transform: rotate(360deg); } }
.on-code-input {
  width: 100%; max-width: none; box-sizing: border-box;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 34px; font-weight: 700; text-align: center;
  text-transform: uppercase; letter-spacing: .22em; padding: 12px 8px;
}
.on-mode-line { text-align: center; color: var(--ink-muted); font-size: 13px; margin-top: 10px; }
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** Escape text for safe interpolation into innerHTML. */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

/** Random positive 31-bit integer for the game seed. */
function randomSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
}

const topbarHTML = (title) => `
  <div class="topbar">
    <button type="button" class="back-btn" id="on-back" aria-label="Back">‹</button>
    <h1>${esc(title)}</h1>
  </div>`;

/* ------------------------------------------------------------------ */
/* Screen                                                              */
/* ------------------------------------------------------------------ */

registerScreen('online', {
  mount(container) {
    injectStyle();

    let settings = { playerName: 'You', hardMode: false };
    try { settings = getSettings(); } catch (e) { console.error('settings load failed', e); }
    let myName = (settings.playerName || 'Player').trim() || 'Player';
    let hardMode = !!settings.hardMode;

    /** @type {null | {code?: string, send: Function, close: Function, lock?: Function}} */
    let room = null;
    let onNetEvent = () => {};        // swapped per phase (lobby vs game)
    let handedOff = false;            // true once we navigate to the table
    let disposed = false;             // true once this mount is torn down
    let seq = 0;                      // cancels stale async continuations
    const dispatch = (ev) => onNetEvent(ev);

    const hostState = { guestName: null, connected: false };

    function closeRoom(sendBye) {
      if (!room) return;
      if (sendBye) room.send({ t: 'bye' });
      try { room.close(); } catch (e) { /* already dead */ }
      room = null;
    }

    /* ------------------------- landing ------------------------- */

    function renderLanding() {
      if (disposed) return;
      seq++;
      onNetEvent = () => {};
      hostState.guestName = null;
      hostState.connected = false;
      container.innerHTML = `
        <div class="screen">
          ${topbarHTML('Play Online')}
          <section class="card-panel">
            <div class="row">
              <label for="on-name">Your name</label>
              <input id="on-name" class="text-input" type="text" maxlength="20"
                autocomplete="off" autocapitalize="words" placeholder="Player 1">
            </div>
            <div class="row">
              <label for="on-hard">Hard Mode
                <span class="hint">host sets the rules</span>
              </label>
              <span class="switch">
                <input id="on-hard" type="checkbox">
                <span class="knob"></span>
              </span>
            </div>
          </section>
          <section class="on-actions">
            <button type="button" class="btn btn-primary" id="on-create">
              <span class="btn-icon">♛</span> Create game
            </button>
            <button type="button" class="btn btn-felt" id="on-join">
              <span class="btn-icon">⇢</span> Join game
            </button>
          </section>
          <p class="on-note">Play against a friend on their own phone.
          Both devices need an internet connection.</p>
        </div>`;

      const nameInput = container.querySelector('#on-name');
      const hardToggle = container.querySelector('#on-hard');
      nameInput.value = myName;
      hardToggle.checked = hardMode;

      nameInput.addEventListener('change', () => {
        myName = nameInput.value.trim() || 'Player';
        try { saveSettings({ playerName: myName }); } catch (e) { /* non-fatal */ }
      });
      hardToggle.addEventListener('change', () => {
        hardMode = hardToggle.checked;
        try { saveSettings({ hardMode }); } catch (e) { /* non-fatal */ }
      });
      container.querySelector('#on-back').addEventListener('click', () => navigate('home'));
      container.querySelector('#on-create').addEventListener('click', () => {
        myName = nameInput.value.trim() || 'Player';
        try { saveSettings({ playerName: myName }); } catch (e) { /* non-fatal */ }
        startHosting();
      });
      container.querySelector('#on-join').addEventListener('click', () => {
        myName = nameInput.value.trim() || 'Player';
        try { saveSettings({ playerName: myName }); } catch (e) { /* non-fatal */ }
        renderJoin('');
      });
    }

    /* -------------------- shared status view ------------------- */

    function renderStatus(title, message, onCancel) {
      if (disposed) return;
      container.innerHTML = `
        <div class="screen">
          ${topbarHTML(title)}
          <div class="on-status"><span class="on-spinner"></span><span>${esc(message)}</span></div>
        </div>`;
      container.querySelector('#on-back').addEventListener('click', onCancel);
    }

    /* -------------------------- host --------------------------- */

    async function startHosting() {
      const my = ++seq;
      hostState.guestName = null;
      hostState.connected = false;
      onNetEvent = hostLobbyEvent;
      renderStatus('Create Game', 'Creating room…', () => {
        seq++;
        renderLanding();
      });
      let created;
      try {
        created = await createRoom(dispatch);
      } catch (err) {
        if (disposed || my !== seq) return;
        toast(err.message || 'Could not create a room.');
        renderLanding();
        return;
      }
      if (disposed || my !== seq) {
        try { created.close(); } catch (e) { /* ignore */ }
        return;
      }
      room = created;
      renderHosting();
    }

    function hostLobbyEvent(ev) {
      if (ev.type === 'message' && ev.msg.t === 'hello') {
        hostState.guestName = ev.msg.name;
        renderHosting();
      } else if (ev.type === 'message' && ev.msg.t === 'bye') {
        if (hostState.guestName) toast(`${hostState.guestName} left.`);
        hostState.guestName = null;
        hostState.connected = false;
        renderHosting();
      } else if (ev.type === 'connected') {
        hostState.connected = true;
        renderHosting();
      } else if (ev.type === 'closed') {
        if (hostState.guestName) toast(`${hostState.guestName} disconnected.`);
        hostState.guestName = null;
        hostState.connected = false;
        renderHosting();
      } else if (ev.type === 'error') {
        toast(ev.message);
      }
    }

    function renderHosting() {
      if (disposed || !room) return;
      let statusHTML;
      if (hostState.guestName) {
        statusHTML = `<span><span class="on-guest">${esc(hostState.guestName)}</span> joined — ready to play</span>`;
      } else if (hostState.connected) {
        statusHTML = '<span class="on-spinner"></span><span>Opponent connecting…</span>';
      } else {
        statusHTML = '<span class="on-spinner"></span><span>Waiting for opponent…</span>';
      }
      container.innerHTML = `
        <div class="screen">
          ${topbarHTML('Create Game')}
          <section class="card-panel on-code-panel">
            <div class="on-hint">Room code</div>
            <div class="on-code">${esc(room.code)}</div>
            <div class="on-hint">Share this code with your opponent</div>
          </section>
          <div class="on-status">${statusHTML}</div>
          <section class="on-actions">
            ${hostState.guestName
              ? '<button type="button" class="btn btn-primary" id="on-start">Start game</button>'
              : ''}
          </section>
          <div class="on-mode-line">Hard mode: ${hardMode ? 'on' : 'off'}</div>
        </div>`;
      container.querySelector('#on-back').addEventListener('click', () => {
        closeRoom(true);
        renderLanding();
      });
      const startBtn = container.querySelector('#on-start');
      if (startBtn) startBtn.addEventListener('click', hostStartGame);
    }

    function hostStartGame() {
      if (!room || !hostState.guestName) return;
      const config = {
        mode: hardMode ? 'hard' : 'normal',
        seed: randomSeed(),
        players: [{ name: myName }, { name: hostState.guestName }],
      };
      room.lock(); // no new connections once the game is underway
      if (!room.send({ t: 'start', config, guestSeat: 1 })) {
        toast('Could not reach your opponent. Ask them to rejoin.');
        hostState.guestName = null;
        hostState.connected = false;
        renderHosting();
        return;
      }
      enterGame(config, 0);
    }

    /* -------------------------- guest -------------------------- */

    function renderJoin(prefill) {
      if (disposed) return;
      seq++;
      onNetEvent = () => {};
      container.innerHTML = `
        <div class="screen">
          ${topbarHTML('Join Game')}
          <section class="card-panel on-code-panel">
            <label class="on-hint" for="on-code-input">Enter the host's room code</label>
            <input id="on-code-input" class="text-input on-code-input" type="text"
              maxlength="5" autocomplete="off" autocapitalize="characters"
              autocorrect="off" spellcheck="false" placeholder="ABCDE">
          </section>
          <section class="on-actions">
            <button type="button" class="btn btn-primary" id="on-do-join" disabled>Join</button>
          </section>
        </div>`;

      const input = container.querySelector('#on-code-input');
      const joinBtn = container.querySelector('#on-do-join');
      input.value = normalizeRoomCode(prefill);
      joinBtn.disabled = !isValidRoomCode(input.value);

      input.addEventListener('input', () => {
        const clean = normalizeRoomCode(input.value);
        if (input.value !== clean) input.value = clean;
        joinBtn.disabled = !isValidRoomCode(clean);
      });
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !joinBtn.disabled) joinBtn.click();
      });
      joinBtn.addEventListener('click', () => startJoining(input.value));
      container.querySelector('#on-back').addEventListener('click', () => renderLanding());
      input.focus();
    }

    async function startJoining(code) {
      const my = ++seq;
      onNetEvent = guestLobbyEvent;
      renderStatus('Join Game', `Joining ${code}…`, () => {
        seq++;
        renderJoin(code);
      });
      let joined;
      try {
        joined = await joinRoom(code, dispatch);
      } catch (err) {
        if (disposed || my !== seq) return;
        toast(err.message || 'Could not join the game.');
        renderJoin(code);
        return;
      }
      if (disposed || my !== seq) {
        try { joined.close(); } catch (e) { /* ignore */ }
        return;
      }
      room = joined;
      room.send({ t: 'hello', name: myName });
      renderGuestWaiting(code);
    }

    function guestLobbyEvent(ev) {
      if (ev.type === 'message' && ev.msg.t === 'start') {
        enterGame(ev.msg.config, 1);
      } else if ((ev.type === 'message' && ev.msg.t === 'bye') || ev.type === 'closed') {
        toast('The host left the game.');
        closeRoom(false);
        renderLanding();
      } else if (ev.type === 'error') {
        toast(ev.message);
      }
    }

    function renderGuestWaiting(code) {
      if (disposed) return;
      container.innerHTML = `
        <div class="screen">
          ${topbarHTML('Join Game')}
          <section class="card-panel on-code-panel">
            <div class="on-hint">Room code</div>
            <div class="on-code">${esc(normalizeRoomCode(code))}</div>
          </section>
          <div class="on-status">
            <span class="on-spinner"></span>
            <span>Connected — waiting for the host to start…</span>
          </div>
        </div>`;
      container.querySelector('#on-back').addEventListener('click', () => {
        closeRoom(true);
        renderLanding();
      });
    }

    /* ------------------------ game session --------------------- */

    /**
     * Hand the connection over to a live game: build the remote adapter,
     * keep a shadow engine state for dedupe + unfinished saves, and
     * navigate to the table screen.
     * @param {object} config - createGame config (host-built or received)
     * @param {0|1} seat - this device's seat
     */
    function enterGame(config, seat) {
      handedOff = true;
      seq++;
      const gameRoom = room;
      room = null;
      const gameId = crypto.randomUUID();
      // Shadow copy: replays every action so we can drop duplicates and
      // save partial results. The table owns the authoritative state.
      const shadow = createGame(JSON.parse(JSON.stringify(config)));
      let remoteHandler = null;
      const queuedRemote = []; // actions that arrive before the table mounts
      let over = false;

      function saveRecord(roundResults, totals, winner, finished) {
        try {
          saveGame({
            id: gameId,
            dateISO: new Date().toISOString(),
            kind: 'online',
            aiLevel: null,
            hardMode: config.mode === 'hard',
            players: [config.players[0].name, config.players[1].name],
            rounds: roundResults.map((r) => ({
              round: r.round,
              scores: [r.scores[0], r.scores[1]],
              wentOut: r.wentOut,
            })),
            totals: [totals[0], totals[1]],
            winner,
            finished,
          });
        } catch (err) {
          console.error('four-crowns: failed to save online game', err);
        }
      }
      const saveUnfinished = () =>
        saveRecord(shadow.roundResults, shadow.totals, null, false);

      function peerGone(message) {
        if (over) return;
        over = true;
        try { gameRoom.close(); } catch (err) { /* already dead */ }
        toast(message);
        const save = window.confirm(
          `${message}\n\nSave this game as unfinished and go home?`
        );
        if (save) {
          saveUnfinished();
          navigate('home');
        }
        // Otherwise stay on the table (view-only); quitting there still works.
      }

      onNetEvent = (ev) => {
        if (over) return;
        if (ev.type === 'message') {
          const msg = ev.msg;
          if (msg.t === 'action') {
            try {
              applyAction(shadow, msg.action);
            } catch (err) {
              // Illegal because already applied locally (e.g. both players
              // tapped "next round") — drop it silently per the protocol.
              return;
            }
            if (remoteHandler) {
              try { remoteHandler(msg.action); } catch (err) { console.error('remote action failed', err); }
            } else {
              queuedRemote.push(msg.action);
            }
          } else if (msg.t === 'bye') {
            peerGone('Your opponent left the game.');
          }
          // {t:'state'} resyncs are unused: same seed + same actions keeps
          // both devices identical.
        } else if (ev.type === 'closed') {
          peerGone('Connection to your opponent was lost.');
        } else if (ev.type === 'error') {
          console.warn('four-crowns net:', ev.message);
        }
      };

      const remoteAdapter = {
        kind: 'remote',
        onLocalAction(action) {
          try {
            applyAction(shadow, action);
          } catch (err) {
            console.error('four-crowns: shadow state diverged', err);
          }
          gameRoom.send({ t: 'action', action });
        },
        registerRemoteActionHandler(fn) {
          remoteHandler = fn;
          while (queuedRemote.length > 0) {
            const a = queuedRemote.shift();
            try { fn(a); } catch (err) { console.error('remote action failed', err); }
          }
        },
      };

      navigate('table', {
        config,
        adapters: seat === 0
          ? [{ kind: 'local' }, remoteAdapter]
          : [remoteAdapter, { kind: 'local' }],
        localSeat: seat,
        // The table screen is the single owner of stats persistence (it saves
        // via buildGameRecord on both the finish and quit paths, deriving
        // kind:'online' from the remote adapter). We must NOT save again here
        // or every online game would be double-counted. Our job on these hooks
        // is only network teardown + navigation.
        onGameEnd() {
          over = true;
          gameRoom.send({ t: 'bye' });
          try { gameRoom.close(); } catch (err) { /* already dead */ }
          navigate('stats');
        },
        onQuit() {
          over = true;
          gameRoom.send({ t: 'bye' });
          try { gameRoom.close(); } catch (err) { /* already dead */ }
          navigate('home');
        },
      });
    }

    /* ----------------------------- go --------------------------- */

    renderLanding();

    return () => {
      disposed = true;
      // Once a game has started the connection belongs to the game session
      // (the table screen drives it via the adapter callbacks).
      if (!handedOff) closeRoom(true);
    };
  },
});
