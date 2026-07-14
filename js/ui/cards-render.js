/**
 * Four Crowns — playing-card DOM rendering.
 * Pure DOM + CSS (classes live in css/app.css); no canvas, no images.
 */

import { SUITS, RANK_NAMES, rank, suit, isWild } from '../engine/cards.js';

/**
 * Render one playing card as a DOM element.
 * @param {number} cardId - card id 0..51
 * @param {object} [opts]
 * @param {number} [opts.wildRank] - the round's wild rank (gold ring + badge)
 * @param {boolean} [opts.selected] - raised + accent ring
 * @param {boolean} [opts.faceDown] - render the card back
 * @returns {HTMLElement}
 */
export function card(cardId, { wildRank = 0, selected = false, faceDown = false } = {}) {
  const el = document.createElement('div');
  el.className = 'card';
  if (faceDown) {
    el.classList.add('back');
    el.setAttribute('aria-label', 'face-down card');
    return el;
  }

  const r = rank(cardId);
  const s = suit(cardId);
  const rankName = RANK_NAMES[r - 1];
  const suitGlyph = SUITS[s];
  const wild = isWild(cardId, wildRank);

  el.dataset.card = String(cardId);
  el.classList.add(s === 1 || s === 2 ? 'red' : 'black'); // ♥ ♦ red; ♠ ♣ black
  if (wild) el.classList.add('wild');
  if (selected) el.classList.add('selected');
  el.setAttribute('aria-label', rankName + suitGlyph + (wild ? ' (wild)' : ''));

  const corner = (cls) => {
    const c = document.createElement('span');
    c.className = 'cc ' + cls;
    const rn = document.createElement('span');
    rn.className = 'cc-rank';
    rn.textContent = rankName;
    const sg = document.createElement('span');
    sg.className = 'cc-suit';
    sg.textContent = suitGlyph;
    c.append(rn, sg);
    return c;
  };

  const center = document.createElement('span');
  center.className = 'center';
  center.textContent = suitGlyph;

  el.append(corner('tl'), center, corner('br'));

  if (wild) {
    const badge = document.createElement('span');
    badge.className = 'wild-badge';
    badge.textContent = '★';
    el.appendChild(badge);
  }
  return el;
}

/**
 * Lay out up to 13 cards in an overlapping row that fits a phone width.
 * Every card's top-left corner index stays visible and tappable.
 * @param {number[]} cards - card ids, left to right
 * @param {object} [opts]
 * @param {number} [opts.wildRank]
 * @param {(cardId: number) => void} [opts.onTap] - tap handler per card
 * @param {number|null} [opts.selectedId] - card id rendered as selected
 * @param {number} [opts.maxWidth] - available px width; measured from the
 *   container on the next frame when omitted
 * @returns {HTMLElement} the row container
 */
export function handRow(cards, { wildRank = 0, onTap = null, selectedId = null, maxWidth = 0 } = {}) {
  const row = document.createElement('div');
  row.className = 'hand-row';

  for (const id of cards) {
    const c = card(id, { wildRank, selected: id === selectedId });
    if (onTap) {
      c.classList.add('tappable');
      c.addEventListener('click', () => onTap(id));
    }
    row.appendChild(c);
  }

  const layout = (w) => {
    const n = cards.length;
    if (!n || !w || w <= 0) return;
    const GAP = 8;         // px between cards when there is room
    const MIN_SLICE = 24;  // px of each overlapped card that must stay visible
    const MAX_W = 84;
    const MIN_W = 44;

    // Ideal side-by-side width; fall back to overlap when it gets too small.
    let cardW = Math.floor((w - GAP * (n - 1)) / n);
    let overlap; // margin-left applied to every card after the first
    if (cardW >= 56 || n === 1) {
      cardW = Math.min(MAX_W, Math.max(MIN_W, cardW));
      overlap = GAP;
    } else {
      cardW = Math.min(MAX_W, Math.max(MIN_W, Math.floor(w - MIN_SLICE * (n - 1))));
      const slice = (w - cardW) / (n - 1);
      overlap = slice >= cardW ? GAP : -(cardW - Math.floor(slice));
    }
    row.style.setProperty('--card-w', cardW + 'px');
    row.style.setProperty('--hand-overlap', overlap + 'px');
  };

  if (maxWidth > 0) {
    layout(maxWidth);
  } else {
    requestAnimationFrame(() => layout(row.clientWidth || window.innerWidth - 32));
  }
  return row;
}
