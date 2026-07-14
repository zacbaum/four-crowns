/**
 * Four Crowns — peer-to-peer transport (net layer).
 *
 * Thin, transport-only wrapper around PeerJS (vendored at
 * js/vendor/peerjs.min.js, loaded lazily as a classic script exposing
 * window.Peer). Uses the default PeerJS public cloud broker for signalling,
 * so both devices need internet access even on the same WiFi.
 *
 * Protocol (docs/ARCHITECTURE.md "Net"), JSON messages only:
 *   guest -> host: { t:'hello', name }
 *   host -> guest: { t:'start', config, guestSeat: 1 }
 *   both:          { t:'action', action }   // sender already applied locally
 *   both:          { t:'state', state }     // full-state resync payload
 *   both:          { t:'bye' }              // clean quit
 *
 * Every inbound message is shape-validated (see validateMessage); malformed
 * messages are ignored. This module does NOT hold game state — js/ui/online.js
 * owns the session logic.
 *
 * Events delivered to the onEvent callback:
 *   { type: 'connected' }               // (host only) a guest's channel opened
 *   { type: 'message', msg }            // a validated protocol message
 *   { type: 'closed' }                  // connection or peer closed / lost
 *   { type: 'error', message: string }  // non-fatal / informational error
 */

const PEER_SCRIPT_URL = './js/vendor/peerjs.min.js';
const PEER_ID_PREFIX = 'four-crowns-';
// A-Z minus the ambiguous I, O, Q (23 letters).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPRSTUVWXYZ';
const CODE_RE = /^[A-HJ-NPR-Z]{5}$/;
const OPEN_TIMEOUT_MS = 15000;

/* ------------------------------------------------------------------ */
/* PeerJS lazy loader                                                  */
/* ------------------------------------------------------------------ */

let peerLoad = null;

/** Inject the vendored PeerJS script once and resolve with window.Peer. */
function loadPeerJS() {
  if (typeof window !== 'undefined' && window.Peer) return Promise.resolve(window.Peer);
  if (!peerLoad) {
    peerLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PEER_SCRIPT_URL; // relative to index.html (subpath-safe)
      s.async = true;
      s.onload = () => {
        if (window.Peer) {
          resolve(window.Peer);
        } else {
          peerLoad = null;
          reject(new Error('The networking library loaded but is unusable.'));
        }
      };
      s.onerror = () => {
        peerLoad = null;
        s.remove();
        reject(new Error('Could not load the networking library. Check your connection and try again.'));
      };
      document.head.appendChild(s);
    });
  }
  return peerLoad;
}

/* ------------------------------------------------------------------ */
/* Room codes                                                          */
/* ------------------------------------------------------------------ */

/**
 * A random 5-letter room code (A-Z minus I, O, Q), uniform via rejection
 * sampling over crypto random bytes.
 * @returns {string}
 */
export function randomRoomCode() {
  const out = [];
  const buf = new Uint8Array(16);
  while (out.length < 5) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      // 230 = 23 * 10: reject the tail so b % 23 is uniform.
      if (out.length < 5 && b < 230) out.push(CODE_ALPHABET[b % 23]);
    }
  }
  return out.join('');
}

/**
 * Uppercase and strip anything outside the room-code alphabet.
 * @param {string} text
 * @returns {string}
 */
export function normalizeRoomCode(text) {
  return String(text || '').toUpperCase().replace(/[^A-HJ-NPR-Z]/g, '').slice(0, 5);
}

/** @param {string} code @returns {boolean} */
export function isValidRoomCode(code) {
  return CODE_RE.test(code);
}

/* ------------------------------------------------------------------ */
/* Message validation                                                  */
/* ------------------------------------------------------------------ */

function isSeat(p) {
  return p === 0 || p === 1;
}

/** Validate + sanitize an action payload. Returns a clean copy or null. */
function validAction(a) {
  if (!a || typeof a !== 'object') return null;
  if (a.type === 'draw') {
    if (!isSeat(a.player)) return null;
    if (a.source !== 'stock' && a.source !== 'discard') return null;
    return { type: 'draw', player: a.player, source: a.source };
  }
  if (a.type === 'discard') {
    if (!isSeat(a.player)) return null;
    if (!Number.isInteger(a.card) || a.card < 0 || a.card > 51) return null;
    return { type: 'discard', player: a.player, card: a.card };
  }
  if (a.type === 'nextRound') return { type: 'nextRound' };
  return null;
}

/** Validate + sanitize a game config payload. Returns a clean copy or null. */
function validConfig(c) {
  if (!c || typeof c !== 'object') return null;
  if (c.mode !== 'normal' && c.mode !== 'hard') return null;
  if (!Number.isInteger(c.seed)) return null;
  if (!Array.isArray(c.players) || c.players.length !== 2) return null;
  const players = [];
  for (const p of c.players) {
    if (!p || typeof p !== 'object' || typeof p.name !== 'string' || p.name.trim() === '') return null;
    players.push({ name: p.name.trim().slice(0, 24) });
  }
  return { mode: c.mode, seed: c.seed, players };
}

/**
 * Validate an inbound wire message. Accepts an object or a JSON string.
 * Returns a sanitized copy of the message, or null if malformed (callers
 * must ignore nulls).
 * @param {unknown} raw
 * @returns {object|null}
 */
export function validateMessage(raw) {
  let m = raw;
  if (typeof m === 'string') {
    try { m = JSON.parse(m); } catch { return null; }
  }
  if (!m || typeof m !== 'object') return null;
  switch (m.t) {
    case 'hello': {
      if (typeof m.name !== 'string' || m.name.trim() === '') return null;
      const out = { t: 'hello', name: m.name.trim().slice(0, 24) };
      // Optional resume handshake: the guest offers its saved-state fingerprint.
      if (typeof m.fp === 'string' && m.fp.length <= 40) out.fp = m.fp;
      return out;
    }
    case 'start': {
      const config = validConfig(m.config);
      if (!config) return null;
      const out = { t: 'start', config, guestSeat: 1 };
      if (m.resume === true) out.resume = true;
      return out;
    }
    case 'action': {
      const action = validAction(m.action);
      if (!action) return null;
      return { t: 'action', action };
    }
    case 'state': {
      if (!m.state || typeof m.state !== 'object') return null;
      return { t: 'state', state: m.state };
    }
    case 'bye':
      return { t: 'bye' };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Human-readable message for a PeerJS error. */
function errText(err, code) {
  const type = err && err.type;
  switch (type) {
    case 'peer-unavailable':
      return `No game found for code ${code || ''}. Double-check the code with the host.`.replace('  ', ' ');
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return 'Could not reach the connection service. Check your internet connection and try again.';
    case 'browser-incompatible':
      return 'This browser does not support peer-to-peer connections.';
    case 'unavailable-id':
      return 'That room code is already in use. Please try again.';
    default:
      return (err && err.message) || 'Connection error.';
  }
}

function friendlyError(err, code) {
  return new Error(errText(err, code));
}

/* ------------------------------------------------------------------ */
/* Peer helpers                                                        */
/* ------------------------------------------------------------------ */

/** Open a Peer (default public cloud broker) and resolve once registered. */
function openPeer(Peer, id) {
  return new Promise((resolve, reject) => {
    const peer = id === undefined ? new Peer() : new Peer(id);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { peer.destroy(); } catch { /* already dead */ }
      reject(new Error('Timed out reaching the connection service. Check your internet connection.'));
    }, OPEN_TIMEOUT_MS);
    peer.on('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(peer);
    });
    peer.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { peer.destroy(); } catch { /* already dead */ }
      reject(err); // raw PeerJS error: callers inspect err.type
    });
  });
}

/* ------------------------------------------------------------------ */
/* Host: createRoom                                                    */
/* ------------------------------------------------------------------ */

/**
 * Create a room on the public PeerJS broker and wait for a guest.
 * Retries with fresh codes if a code is already taken.
 * @param {(ev: object) => void} onEvent - receives connection events (see
 *   module docblock)
 * @returns {Promise<{code: string, send: (msg: object) => boolean,
 *   lock: () => void, close: () => void}>}
 *   - code: the 5-letter room code to share
 *   - send: send a protocol message (false if no open connection)
 *   - lock: stop accepting new guest connections (call once the game starts)
 *   - close: tear down the connection and the peer
 */
export async function createRoom(onEvent, opts = {}) {
  const Peer = await loadPeerJS();
  let lastErr = null;
  // opts.code pins the room code (resume: the guest knows this code). The old
  // peer id can linger on the broker briefly after a drop, so retry it with
  // small backoffs before giving up.
  const fixed = typeof opts.code === 'string' && opts.code ? opts.code : null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = fixed || randomRoomCode();
    let peer;
    try {
      peer = await openPeer(Peer, PEER_ID_PREFIX + code);
    } catch (err) {
      lastErr = err;
      if (err && err.type === 'unavailable-id') {
        if (!fixed) continue; // collision: new random code
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        continue; // resume: wait for the broker to release our old id
      }
      throw friendlyError(err);
    }
    return hostRoom(peer, code, onEvent);
  }
  if (fixed && lastErr && lastErr.type === 'unavailable-id') {
    throw new Error('The old room is still closing down — try Resume again in a minute.');
  }
  throw friendlyError(lastErr);
}

function hostRoom(peer, code, onEvent) {
  let conn = null;       // the single active guest connection
  let locked = false;    // once locked, reject any new connections
  let destroyed = false;

  const emit = (ev) => {
    if (!destroyed) onEvent(ev);
  };

  peer.on('connection', (c) => {
    if (destroyed || locked || conn) {
      // One guest at a time; politely drop extras.
      try { c.close(); } catch { /* ignore */ }
      return;
    }
    conn = c;
    c.on('open', () => {
      if (conn === c) emit({ type: 'connected' });
    });
    c.on('data', (data) => {
      if (conn !== c) return;
      const msg = validateMessage(data);
      if (msg) emit({ type: 'message', msg });
    });
    c.on('close', () => {
      if (conn !== c) return;
      conn = null; // allow a new guest to join (pre-game); post-lock stays shut
      emit({ type: 'closed' });
    });
    c.on('error', (err) => {
      if (conn === c) emit({ type: 'error', message: errText(err) });
    });
  });

  peer.on('error', (err) => emit({ type: 'error', message: errText(err) }));
  peer.on('disconnected', () => {
    // Lost the broker (not the data channel); try to re-register so a guest
    // can still find the room. Existing connections are unaffected.
    if (!destroyed) {
      try { peer.reconnect(); } catch { /* ignore */ }
    }
  });
  peer.on('close', () => {
    if (!destroyed) {
      destroyed = true;
      onEvent({ type: 'closed' });
    }
  });

  return {
    code,
    send(msg) {
      if (destroyed || !conn || !conn.open) return false;
      try { conn.send(msg); return true; } catch { return false; }
    },
    lock() {
      locked = true;
    },
    close() {
      if (destroyed) return;
      destroyed = true;
      try { if (conn) conn.close(); } catch { /* ignore */ }
      try { peer.destroy(); } catch { /* ignore */ }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Guest: joinRoom                                                     */
/* ------------------------------------------------------------------ */

/**
 * Join a host's room by its 5-letter code.
 * Resolves once the data channel is open; rejects with a friendly Error if
 * the room does not exist or the service is unreachable.
 * @param {string} code - room code (any case; will be normalized)
 * @param {(ev: object) => void} onEvent - receives connection events
 * @returns {Promise<{send: (msg: object) => boolean, close: () => void}>}
 */
export async function joinRoom(code, onEvent) {
  const normalized = normalizeRoomCode(code);
  if (!isValidRoomCode(normalized)) {
    throw new Error('Room codes are 5 letters, e.g. KWSTR.');
  }
  const Peer = await loadPeerJS();
  let peer;
  try {
    peer = await openPeer(Peer); // random peer id for the guest
  } catch (err) {
    throw friendlyError(err, normalized);
  }

  return new Promise((resolve, reject) => {
    let opened = false;
    let destroyed = false;
    let closedEmitted = false;

    const emit = (ev) => {
      if (!destroyed) onEvent(ev);
    };
    const emitClosed = () => {
      if (!closedEmitted && !destroyed) {
        closedEmitted = true;
        onEvent({ type: 'closed' });
      }
    };
    const fail = (err) => {
      if (opened || destroyed) return;
      destroyed = true;
      clearTimeout(timer);
      try { peer.destroy(); } catch { /* ignore */ }
      reject(friendlyError(err, normalized));
    };

    const timer = setTimeout(
      () => fail({ type: 'peer-unavailable' }),
      OPEN_TIMEOUT_MS
    );

    const conn = peer.connect(PEER_ID_PREFIX + normalized, {
      reliable: true,
      serialization: 'json',
    });

    peer.on('error', (err) => {
      if (!opened) { fail(err); return; }
      emit({ type: 'error', message: errText(err, normalized) });
    });
    peer.on('disconnected', () => {
      if (!destroyed) {
        try { peer.reconnect(); } catch { /* ignore */ }
      }
    });
    peer.on('close', () => {
      if (opened) emitClosed();
    });

    conn.on('open', () => {
      if (destroyed) return;
      opened = true;
      clearTimeout(timer);
      resolve({
        send(msg) {
          if (destroyed || !conn.open) return false;
          try { conn.send(msg); return true; } catch { return false; }
        },
        close() {
          if (destroyed) return;
          destroyed = true;
          try { conn.close(); } catch { /* ignore */ }
          try { peer.destroy(); } catch { /* ignore */ }
        },
      });
    });
    conn.on('data', (data) => {
      const msg = validateMessage(data);
      if (msg) emit({ type: 'message', msg });
    });
    conn.on('close', () => {
      if (!opened) { fail({ type: 'peer-unavailable' }); return; }
      emitClosed();
    });
    conn.on('error', (err) => {
      if (!opened) { fail(err); return; }
      emit({ type: 'error', message: errText(err, normalized) });
    });
  });
}
