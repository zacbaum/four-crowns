/**
 * Four Crowns — stats storage.
 *
 * Owns the `fourcrowns.v1` localStorage key (schema: docs/ARCHITECTURE.md,
 * "Stats — storage schema"). This is the only stats module allowed to touch
 * browser APIs; all computation lives in js/stats/analytics.js (pure).
 *
 * Loading is defensive: corrupt JSON or a mangled shape yields a fresh DB
 * (invalid individual game records are dropped, valid ones kept) — load never
 * throws. `importJSON` validates the incoming shape and MERGES games by id;
 * it never wipes existing games.
 */

const KEY = 'fourcrowns.v1';
const KINDS = ['ai', 'online', 'scorekeeper'];
const AI_LEVELS = ['easy', 'medium', 'hard'];
const ROUND_NUMBERS = new Set([3, 4, 6, 7, 8, 9, 10, 11, 12, 13]);

function freshDB() {
  return { settings: { hardMode: false, playerName: 'You' }, games: [] };
}

/**
 * Validate a round's optional meld data: [playerMelds0, playerMelds1], each an
 * array of melds, each meld 3-4 card ids (0-51). A soft field — anything
 * malformed returns null and the round is kept without melds (real-card /
 * pre-update games never have it).
 * @param {unknown} m
 * @returns {number[][][]|null}
 */
function normalizeMelds(m) {
  if (!Array.isArray(m) || m.length !== 2) return null;
  const out = [];
  for (const playerMelds of m) {
    if (!Array.isArray(playerMelds)) return null;
    const melds = [];
    for (const meld of playerMelds) {
      if (!Array.isArray(meld) || meld.length < 3 || meld.length > 4) return null;
      if (!meld.every((c) => Number.isInteger(c) && c >= 0 && c < 52)) return null;
      melds.push([...meld]);
    }
    out.push(melds);
  }
  return out;
}

/**
 * Validate + normalize one game record.
 * Returns a normalized copy, or null if the record is unusable.
 * Hard requirements: id, dateISO, kind, players[2], rounds[], totals[2].
 * Soft fields (aiLevel, wentOut, winner, finished, hardMode) are coerced to
 * schema values rather than rejecting the whole game.
 * @param {object} g
 * @returns {object|null}
 */
function normalizeGame(g) {
  if (!g || typeof g !== 'object') return null;
  if (typeof g.id !== 'string' || g.id === '') return null;
  if (typeof g.dateISO !== 'string' || g.dateISO === '') return null;
  if (!KINDS.includes(g.kind)) return null;
  if (!Array.isArray(g.players) || g.players.length !== 2
    || !g.players.every((p) => typeof p === 'string')) return null;
  if (!Array.isArray(g.rounds)) return null;
  if (!Array.isArray(g.totals) || g.totals.length !== 2
    || !g.totals.every(Number.isFinite)) return null;
  const rounds = [];
  for (const r of g.rounds) {
    if (!r || typeof r !== 'object' || !ROUND_NUMBERS.has(r.round)) return null;
    if (!Array.isArray(r.scores) || r.scores.length !== 2
      || !r.scores.every(Number.isFinite)) return null;
    const melds = normalizeMelds(r.melds);
    // turns: soft field — how many turns the going-out player needed.
    const turns = (Number.isInteger(r.turns) && r.turns >= 1) ? r.turns : null;
    rounds.push({
      round: r.round,
      scores: [r.scores[0], r.scores[1]],
      wentOut: (r.wentOut === 0 || r.wentOut === 1) ? r.wentOut : null,
      ...(turns !== null ? { turns } : {}),
      ...(melds ? { melds } : {}),
    });
  }
  return {
    id: g.id,
    dateISO: g.dateISO,
    kind: g.kind,
    aiLevel: AI_LEVELS.includes(g.aiLevel) ? g.aiLevel : null,
    hardMode: g.hardMode === true,
    players: [g.players[0], g.players[1]],
    rounds,
    totals: [g.totals[0], g.totals[1]],
    winner: (g.winner === 0 || g.winner === 1 || g.winner === 'tie') ? g.winner : null,
    finished: g.finished === true,
  };
}

/**
 * Load the whole stats DB. Never throws: missing/corrupt storage yields a
 * fresh DB; individually invalid game records are dropped.
 * @returns {{settings: {hardMode: boolean, playerName: string}, games: object[]}}
 */
export function loadDB() {
  let raw = null;
  try { raw = localStorage.getItem(KEY); } catch { return freshDB(); }
  if (!raw) return freshDB();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return freshDB(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return freshDB();
  const db = freshDB();
  if (parsed.settings && typeof parsed.settings === 'object') {
    if (typeof parsed.settings.hardMode === 'boolean') db.settings.hardMode = parsed.settings.hardMode;
    if (typeof parsed.settings.playerName === 'string' && parsed.settings.playerName !== '') {
      db.settings.playerName = parsed.settings.playerName;
    }
  }
  if (Array.isArray(parsed.games)) {
    db.games = parsed.games.map(normalizeGame).filter((g) => g !== null);
  }
  return db;
}

function persist(db) {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch (err) {
    // Quota exceeded / private-mode restrictions: keep the app alive.
    console.warn('four-crowns: failed to persist stats', err);
  }
}

/**
 * Add a game record (replaces an existing record with the same id, so a
 * double-save at game end is harmless).
 * @param {object} game - per the storage schema
 * @returns {object} the normalized stored record
 */
export function saveGame(game) {
  const norm = normalizeGame(game);
  if (!norm) throw new TypeError('saveGame: invalid game record');
  const db = loadDB();
  const idx = db.games.findIndex((g) => g.id === norm.id);
  if (idx >= 0) db.games[idx] = norm; else db.games.push(norm);
  persist(db);
  return norm;
}

/**
 * Update a game record in place by id (adds it if not present).
 * @param {object} game
 * @returns {object} the normalized stored record
 */
export function updateGame(game) {
  return saveGame(game);
}

/** @returns {object[]} all stored games (fresh copies; mutating is safe). */
export function getGames() {
  return loadDB().games;
}

/** @returns {{hardMode: boolean, playerName: string}} */
export function getSettings() {
  return loadDB().settings;
}

/**
 * Merge a partial settings patch. Unknown keys are ignored.
 * @param {{hardMode?: boolean, playerName?: string}} patch
 * @returns {{hardMode: boolean, playerName: string}} the stored settings
 */
export function saveSettings(patch) {
  const db = loadDB();
  if (patch && typeof patch === 'object') {
    if (typeof patch.hardMode === 'boolean') db.settings.hardMode = patch.hardMode;
    if (typeof patch.playerName === 'string' && patch.playerName.trim() !== '') {
      db.settings.playerName = patch.playerName.trim();
    }
  }
  persist(db);
  return db.settings;
}

/**
 * Delete one game by id.
 * @param {string} id
 * @returns {boolean} true if a game was removed
 */
export function deleteGame(id) {
  const db = loadDB();
  const before = db.games.length;
  db.games = db.games.filter((g) => g.id !== id);
  if (db.games.length === before) return false;
  persist(db);
  return true;
}

/** @returns {string} pretty-printed JSON of the whole DB, for backup files. */
export function exportJSON() {
  return JSON.stringify(loadDB(), null, 2);
}

/**
 * Import a backup produced by exportJSON (or any object with a `games`
 * array in the storage schema). Validates the shape and merges by game id:
 * unknown ids are added, matching ids are replaced by the imported copy,
 * invalid records are skipped. Existing games are NEVER wiped. Settings are
 * left untouched.
 * @param {string} text - raw JSON text
 * @returns {{added: number, updated: number, skipped: number, total: number}}
 * @throws {Error} if the text is not JSON or has no games array
 */
export function importJSON(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    throw new Error('Import failed: file is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.games)) {
    throw new Error('Import failed: expected a backup with a "games" list.');
  }
  const db = loadDB();
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const raw of parsed.games) {
    const norm = normalizeGame(raw);
    if (!norm) { skipped++; continue; }
    const idx = db.games.findIndex((g) => g.id === norm.id);
    if (idx >= 0) { db.games[idx] = norm; updated++; } else { db.games.push(norm); added++; }
  }
  persist(db);
  return { added, updated, skipped, total: db.games.length };
}
