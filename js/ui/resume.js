/**
 * Four Crowns — in-progress game persistence (one slot).
 *
 * The full engine state is plain serializable data, so an interrupted game
 * (closed tab, crash, accidental quit) can be picked up exactly where it
 * stopped. AI games save themselves from the table screen after every
 * action; online games are saved by the online module alongside its room
 * code so both peers can reconnect and continue.
 *
 * Shape: {
 *   kind: 'ai' | 'online',
 *   state: <engine state>,          // authoritative, phase !== 'gameOver'
 *   gameId: string,                 // stats record id (upsert on finish)
 *   handOrder: number[],            // local player's arrangement
 *   orderRound: number,
 *   aiLevel?: 'easy'|'medium'|'hard',
 *   seat?: 0|1, roomCode?: string,  // online only
 *   playerName?: string,            // online only (rejoin hello)
 *   dateISO: string,
 * }
 */

const KEY = 'fourcrowns.resume.v1';

/** Persist the in-progress game (best effort — quota errors are swallowed). */
export function saveResume(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...data, dateISO: new Date().toISOString() }));
  } catch (err) { /* private mode / quota: resume is a convenience, not critical */ }
}

/** @returns {object|null} the saved in-progress game, if it looks usable */
export function loadResume() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') return null;
    if (d.kind !== 'ai' && d.kind !== 'online') return null;
    const s = d.state;
    if (!s || typeof s !== 'object' || !s.config || !Array.isArray(s.hands)) return null;
    if (s.phase === 'gameOver') return null;
    if (typeof d.gameId !== 'string' || d.gameId === '') return null;
    return d;
  } catch (err) {
    return null;
  }
}

export function clearResume() {
  try { localStorage.removeItem(KEY); } catch (err) { /* ignore */ }
}

/**
 * Cheap deterministic fingerprint of an engine state (djb2 over its JSON) —
 * used by online resume to confirm both peers hold the same game.
 * @param {object} state
 * @returns {string}
 */
export function stateFingerprint(state) {
  const s = JSON.stringify(state);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36) + ':' + s.length;
}
