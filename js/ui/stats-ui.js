/**
 * Four Crowns — analytics screen ("stats").
 *
 * Registers the 'stats' screen with the app shell. Reads games via
 * js/stats/store.js, computes everything via js/stats/analytics.js (pure),
 * and renders hand-rolled inline-SVG charts.
 *
 * Chart design follows the dataviz method: 2px round-capped lines, bars
 * <= 24px with rounded data ends and square baselines, hairline solid grid,
 * surface rings on markers, a legend whenever two series show, sparing
 * direct labels, a crosshair tooltip on line charts and per-mark tooltips on
 * bars, and a <details> table twin under every chart so no value is gated
 * behind hover. Chart colors use only the design tokens (--series-1/2 for
 * marks, --ink-* for all text, --grid/--baseline/--surface-1 for chrome).
 */

import { registerScreen, navigate, toast } from './app.js';
import {
  getGames, getSettings, deleteGame, exportJSON, importJSON,
} from '../stats/store.js';
import {
  filterGames, playerAggregates, headToHead, averageScores, roundStats,
  trajectory, goingOutStats, caughtDistribution, singleRoundRecords,
  eloRatings, totalsOverTime, streaks,
} from '../stats/analytics.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SERIES = ['var(--series-1)', 'var(--series-2)'];
const KIND_LABELS = { ai: 'vs AI', online: 'Online', scorekeeper: 'Real cards' };
const VBW = 400; // shared viewBox width; svgs scale to container width

/* ------------------------------------------------------------------ state */

const view = {
  kind: null,        // null | 'ai' | 'online' | 'scorekeeper'
  hardOnly: false,   // hard-mode chip
  trajIndex: 0,      // 0 = most recent game (trajectory chart selector)
  expandedId: null,  // expanded row in the recent-games list
  showAllGames: false, // recent-games list starts collapsed to the last 3
};
let root = null;

/* ------------------------------------------------------------------ style */

const CSS = `
.st-root { max-width: 640px; margin: 0 auto; padding: 12px 14px 32px;
  color: var(--ink-1, #0b0b0b); }
.st-root svg text { font-family: inherit; }
.st-h { margin: 4px 0 12px; font-size: 20px; }
.st-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  margin-bottom: 14px; }
.st-chip { border: 1px solid var(--grid, #e1e0d9); border-radius: 999px;
  background: var(--surface-1, #fcfcfb); color: var(--ink-2, #52514e);
  padding: 6px 12px; font: inherit; font-size: 13px; line-height: 1;
  cursor: pointer; }
.st-chip[aria-pressed="true"] { background: var(--accent, #2a78d6);
  border-color: var(--accent, #2a78d6); color: #fff; }
.st-chip-hard { margin-left: auto; }
.st-tiles { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px;
  margin-bottom: 14px; }
@media (min-width: 560px) { .st-tiles { grid-template-columns: repeat(4, 1fr); } }
.st-tile { background: var(--surface-1, #fcfcfb);
  border: 1px solid var(--grid, #e1e0d9); border-radius: 10px;
  padding: 10px 12px; min-width: 0; }
.st-tile-label { font-size: 12px; color: var(--ink-muted, #898781); }
.st-tile-value { font-size: 24px; font-weight: 600; line-height: 1.25;
  color: var(--ink-1, #0b0b0b); overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.st-tile-sub { font-size: 12px; color: var(--ink-2, #52514e);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-card { background: var(--surface-1, #fcfcfb);
  border: 1px solid var(--grid, #e1e0d9); border-radius: 10px;
  padding: 12px; margin-bottom: 14px; }
.st-card h3 { margin: 0; font-size: 14px; color: var(--ink-1, #0b0b0b); }
.st-card-sub { margin: 1px 0 8px; font-size: 12px;
  color: var(--ink-muted, #898781); }
.st-note { font-size: 13px; color: var(--ink-muted, #898781);
  padding: 10px 2px; }
.st-legend { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 2px 0 6px;
  font-size: 12px; color: var(--ink-2, #52514e); }
.st-legend > span { display: inline-flex; align-items: center; gap: 6px;
  min-width: 0; }
.st-key-line { width: 14px; height: 3px; border-radius: 2px; flex: none; }
.st-key-rect { width: 10px; height: 10px; border-radius: 2px; flex: none; }
.st-chartwrap { position: relative; }
.st-chartwrap svg { display: block; width: 100%; height: auto; }
.st-chartwrap svg:focus-visible, .st-hit:focus-visible {
  outline: 2px solid var(--accent, #2a78d6); outline-offset: 2px; }
.st-hit { outline: none; }
.st-tip { position: absolute; display: none; pointer-events: none; z-index: 5;
  background: var(--surface-1, #fcfcfb);
  border: 1px solid var(--grid, #e1e0d9); border-radius: 8px;
  padding: 6px 9px; font-size: 12px; box-shadow: 0 2px 10px rgba(0,0,0,.14);
  max-width: 220px; }
.st-tip-title { font-size: 11px; color: var(--ink-muted, #898781);
  margin-bottom: 2px; white-space: nowrap; }
.st-tip-row { display: flex; align-items: center; gap: 6px;
  white-space: nowrap; }
.st-tip-val { font-weight: 600; color: var(--ink-1, #0b0b0b); }
.st-tip-name { color: var(--ink-2, #52514e); }
.st-details { margin-top: 8px; font-size: 12px; color: var(--ink-2, #52514e); }
.st-details summary { cursor: pointer; color: var(--ink-muted, #898781); }
.st-details table { border-collapse: collapse; width: 100%; margin-top: 6px; }
.st-details th, .st-details td { text-align: right; padding: 3px 6px;
  border-bottom: 1px solid var(--grid, #e1e0d9);
  font-variant-numeric: tabular-nums; font-weight: 400; }
.st-details th:first-child, .st-details td:first-child { text-align: left; }
.st-details thead th { color: var(--ink-muted, #898781); }
.st-selector { display: flex; align-items: center; gap: 6px; margin: 2px 0 6px; }
.st-selector-label { flex: 1; text-align: center; font-size: 12px;
  color: var(--ink-2, #52514e); overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.st-arrow { border: 1px solid var(--grid, #e1e0d9); border-radius: 8px;
  background: var(--surface-1, #fcfcfb); color: var(--ink-2, #52514e);
  font: inherit; font-size: 15px; line-height: 1; padding: 4px 11px;
  cursor: pointer; }
.st-arrow:disabled { opacity: .35; cursor: default; }
.st-extremes { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.st-extreme { border: 1px solid var(--grid, #e1e0d9); border-radius: 8px;
  padding: 8px 10px; min-width: 0; }
.st-extreme-label { font-size: 12px; color: var(--ink-muted, #898781); }
.st-extreme-value { font-size: 20px; font-weight: 600;
  color: var(--ink-1, #0b0b0b); }
.st-extreme-sub { font-size: 12px; color: var(--ink-2, #52514e);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-records { grid-template-columns: repeat(3, 1fr); }
.st-elo { border-collapse: collapse; width: 100%; margin-top: 4px;
  font-size: 14px; font-variant-numeric: tabular-nums; }
.st-elo th, .st-elo td { text-align: right; padding: 6px 8px;
  border-bottom: 1px solid var(--grid, #e1e0d9); }
.st-elo th { font-size: 12px; font-weight: 500; color: var(--ink-muted, #898781); }
.st-elo td { color: var(--ink-2, #52514e); }
.st-elo th:nth-child(2), .st-elo td.st-elo-name { text-align: left;
  color: var(--ink-1, #0b0b0b); overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; max-width: 42vw; }
.st-elo-you td { font-weight: 700; color: var(--ink-1, #0b0b0b); }
.st-elo-you td.st-elo-name::after { content: ' (you)';
  color: var(--ink-muted, #898781); font-weight: 400; font-size: 12px; }
.st-elo-chart { margin-top: 10px; }
.st-game { border-top: 1px solid var(--grid, #e1e0d9); }
.st-game:first-of-type { border-top: 0; }
.st-game-head { display: block; width: 100%; border: 0; background: none;
  font: inherit; text-align: left; padding: 10px 2px; cursor: pointer;
  color: var(--ink-1, #0b0b0b); }
.st-game-l1 { display: flex; align-items: center; gap: 8px; font-size: 12px;
  color: var(--ink-muted, #898781); margin-bottom: 3px; }
.st-badge { border: 1px solid var(--grid, #e1e0d9); border-radius: 6px;
  padding: 1px 6px; font-size: 11px; color: var(--ink-2, #52514e); }
.st-game-l2 { display: flex; align-items: baseline; gap: 10px; }
.st-game-players { flex: 1; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
.st-game-score { font-variant-numeric: tabular-nums; font-weight: 600;
  font-size: 14px; }
.st-game-result { font-size: 12px; min-width: 44px; text-align: right; }
.st-result-win { color: var(--good, #0ca30c); }
.st-result-loss { color: var(--critical, #d03b3b); }
.st-result-other { color: var(--ink-muted, #898781); }
.st-game-detail { padding: 0 2px 12px; }
.st-game-detail table { border-collapse: collapse; width: 100%;
  font-size: 12px; color: var(--ink-2, #52514e); }
.st-game-detail th, .st-game-detail td { text-align: right; padding: 3px 6px;
  border-bottom: 1px solid var(--grid, #e1e0d9);
  font-variant-numeric: tabular-nums; font-weight: 400; }
.st-game-detail th:first-child, .st-game-detail td:first-child {
  text-align: left; }
.st-game-detail thead th { color: var(--ink-muted, #898781); }
.st-game-detail tfoot td { font-weight: 600; color: var(--ink-1, #0b0b0b); }
.st-btn { border: 1px solid var(--grid, #e1e0d9); border-radius: 8px;
  background: var(--surface-1, #fcfcfb); color: var(--ink-1, #0b0b0b);
  font: inherit; font-size: 13px; padding: 8px 14px; cursor: pointer; }
.st-btn-wide { display: block; width: 100%; margin-top: 8px; text-align: center; }
.st-btn-primary { background: var(--accent, #2a78d6);
  border-color: var(--accent, #2a78d6); color: #fff; }
.st-btn-danger { color: var(--critical, #d03b3b);
  border-color: var(--critical, #d03b3b); background: none; }
.st-btn-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.st-empty { text-align: center; padding: 40px 16px; }
.st-empty h3 { margin: 0 0 6px; font-size: 17px; }
.st-empty p { margin: 0 0 16px; font-size: 14px; color: var(--ink-2, #52514e); }
.st-empty .st-btn-row { justify-content: center; }
.st-io-note { margin: 8px 0 0; font-size: 12px;
  color: var(--ink-muted, #898781); }
`;

function injectStyles() {
  if (document.getElementById('st-styles')) return;
  const s = document.createElement('style');
  s.id = 'st-styles';
  s.textContent = CSS;
  document.head.appendChild(s);
}

/* ------------------------------------------------------------- dom helpers */

function h(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

function svgEl(tag, attrs = {}) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function fmtNum(v, dec = 1) {
  if (v == null || Number.isNaN(v)) return '—';
  const r = Math.round(v * 10 ** dec) / 10 ** dec;
  return Number.isInteger(r) ? String(r) : r.toFixed(dec);
}

function fmtPct(v) {
  return v == null ? '—' : `${Math.round(v * 100)}%`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Nice axis step: 1/2/5 x 10^k. */
function niceStep(x) {
  if (x <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(x));
  const f = x / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

/** Ticks 0..top covering rawMax with a clean step. */
function yTicks(rawMax, intervals = 4) {
  const step = niceStep((rawMax || 1) / intervals);
  const top = step * Math.ceil((rawMax || 1) / step);
  const out = [];
  for (let v = 0; v <= top + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

/**
 * Ticks fitted to [dataMin, dataMax] with ~10% padding and a clean step —
 * for series that live far from zero (e.g. Elo around 1500), where a 0-based
 * axis would flatten the line into noise.
 */
function fittedTicks(dataMin, dataMax, intervals = 4) {
  const span = Math.max(dataMax - dataMin, 1);
  const pad = span * 0.1;
  const step = niceStep((span + 2 * pad) / intervals);
  const lo = step * Math.floor((dataMin - pad) / step);
  const hi = step * Math.ceil((dataMax + pad) / step);
  const out = [];
  for (let v = lo; v <= hi + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

/* ---------------------------------------------------------------- tooltip */

function makeTip(wrap) {
  const tip = h('div', 'st-tip');
  wrap.appendChild(tip);
  return tip;
}

/**
 * Show the shared tooltip. rows: [{color, key: 'line'|'rect', value, name}].
 * Values lead (strong), names follow; series keyed by a short stroke.
 * All text set via textContent — labels are untrusted data.
 */
function showTip(wrap, tip, title, rows, xPx, yPx) {
  tip.textContent = '';
  if (title) tip.appendChild(h('div', 'st-tip-title', title));
  for (const r of rows) {
    const row = h('div', 'st-tip-row');
    if (r.color) {
      const k = h('span', r.key === 'rect' ? 'st-key-rect' : 'st-key-line');
      k.style.background = r.color;
      row.appendChild(k);
    }
    row.appendChild(h('span', 'st-tip-val', r.value));
    if (r.name) row.appendChild(h('span', 'st-tip-name', r.name));
    tip.appendChild(row);
  }
  tip.style.display = 'block';
  const ww = wrap.clientWidth;
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = xPx + 12;
  if (left + tw > ww - 4) left = xPx - tw - 12;
  if (left < 4) left = 4;
  let top = yPx - th - 10;
  if (top < 2) top = yPx + 14;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideTip(tip) {
  tip.style.display = 'none';
}

/* ------------------------------------------------------------ chart chrome */

function chartCard(title, subtitle) {
  const card = h('section', 'st-card');
  card.appendChild(h('h3', null, title));
  if (subtitle) card.appendChild(h('p', 'st-card-sub', subtitle));
  return card;
}

function legendRow(entries, key) {
  const row = h('div', 'st-legend');
  for (const e of entries) {
    const item = h('span');
    const swatch = h('span', key === 'rect' ? 'st-key-rect' : 'st-key-line');
    swatch.style.background = e.color;
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(e.name));
    row.appendChild(item);
  }
  return row;
}

/** <details> table twin — the no-hover, screen-reader-clean view. */
function dataTable(headers, rows) {
  const details = h('details', 'st-details');
  details.appendChild(h('summary', null, 'View as table'));
  const table = h('table');
  const thead = h('thead');
  const hr = h('tr');
  for (const head of headers) hr.appendChild(h('th', null, head));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = h('tbody');
  for (const row of rows) {
    const tr = h('tr');
    for (const cell of row) tr.appendChild(h('td', null, cell));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  details.appendChild(table);
  return details;
}

function gridAndAxis(svg, m, plotW, ticks, y, fmt) {
  for (const t of ticks) {
    const yy = y(t);
    svg.appendChild(svgEl('line', {
      x1: m.l, x2: m.l + plotW, y1: yy, y2: yy, 'stroke-width': 1,
      stroke: t === 0 ? 'var(--baseline)' : 'var(--grid)',
    }));
    const lbl = svgEl('text', {
      x: m.l - 5, y: yy + 3, 'text-anchor': 'end', 'font-size': 9,
      fill: 'var(--ink-muted)',
    });
    lbl.textContent = fmt(t);
    svg.appendChild(lbl);
  }
}

/* --------------------------------------------------------------- line chart */

/**
 * Multi-series line chart with crosshair tooltip + keyboard support.
 * series: [{name, color, values: (number|null)[]}] aligned to xLabels.
 * fitDomain: fit the y-axis to the data (padded) instead of starting at 0 —
 * for series far from zero, like Elo ratings.
 */
function renderLineChart(card, { series, xLabels, tipTitle, ariaLabel, fitDomain = false }) {
  if (series.length >= 2) card.appendChild(legendRow(series, 'line'));
  const wrap = h('div', 'st-chartwrap');
  card.appendChild(wrap);

  const n = xLabels.length;
  const H = 200;
  const m = { t: 12, r: 54, b: 22, l: fitDomain ? 40 : 32 };
  const plotW = VBW - m.l - m.r;
  const plotH = H - m.t - m.b;
  const all = series.flatMap((s) => s.values).filter((v) => v != null);
  const ticks = fitDomain && all.length
    ? fittedTicks(Math.min(...all), Math.max(...all))
    : yTicks(Math.max(...all, 0));
  const lo = ticks[0];
  const top = ticks[ticks.length - 1];
  const y = (v) => m.t + plotH * (1 - (v - lo) / (top - lo || 1));
  const xs = Array.from({ length: n }, (_, i) => (n === 1
    ? m.l + plotW / 2 : m.l + (plotW * i) / (n - 1)));

  const svg = svgEl('svg', {
    viewBox: `0 0 ${VBW} ${H}`, role: 'img', tabindex: '0',
    'aria-label': ariaLabel,
  });
  wrap.appendChild(svg);
  gridAndAxis(svg, m, plotW, ticks, y, (t) => fmtNum(t, 1));

  // x labels — first, last, and a sparse middle
  const stepI = Math.max(1, Math.ceil((n - 1) / 5));
  for (let i = 0; i < n; i++) {
    if (i !== 0 && i !== n - 1 && i % stepI !== 0) continue;
    const lbl = svgEl('text', {
      x: xs[i], y: H - 8, 'font-size': 9, fill: 'var(--ink-muted)',
      'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle',
    });
    lbl.textContent = xLabels[i];
    svg.appendChild(lbl);
  }

  // crosshair (hidden until hover/focus)
  const cross = svgEl('line', {
    y1: m.t, y2: m.t + plotH, stroke: 'var(--ink-muted)',
    'stroke-width': 1, visibility: 'hidden',
  });
  svg.appendChild(cross);

  const ends = [];
  series.forEach((s) => {
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${xs[i].toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    if (d) {
      svg.appendChild(svgEl('path', {
        d, fill: 'none', stroke: s.color, 'stroke-width': 2,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }));
    }
    // isolated points (null neighbours) get their own dot so they are visible
    s.values.forEach((v, i) => {
      if (v == null) return;
      const alone = (i === 0 || s.values[i - 1] == null)
        && (i === n - 1 || s.values[i + 1] == null);
      if (alone && !(i === lastIdx(s.values))) {
        svg.appendChild(svgEl('circle', {
          cx: xs[i], cy: y(v), r: 4, fill: s.color,
          stroke: 'var(--surface-1)', 'stroke-width': 2,
        }));
      }
    });
    const li = lastIdx(s.values);
    if (li >= 0) {
      // end marker with a 2px surface ring
      svg.appendChild(svgEl('circle', {
        cx: xs[li], cy: y(s.values[li]), r: 4.5, fill: s.color,
        stroke: 'var(--surface-1)', 'stroke-width': 2,
      }));
      ends.push({ name: s.name, x: xs[li], y: y(s.values[li]) });
    }
  });

  // direct end labels (names) — skipped when they'd collide (legend carries it)
  if (ends.length < 2 || Math.abs(ends[0].y - ends[1].y) >= 12) {
    for (const e of ends) {
      const lbl = svgEl('text', {
        x: e.x + 8, y: e.y + 3, 'font-size': 10, fill: 'var(--ink-2)',
      });
      lbl.textContent = truncate(e.name, 8);
      svg.appendChild(lbl);
    }
  }

  // interaction: crosshair snaps to the nearest x; one tooltip, every series
  const tip = makeTip(wrap);
  const showAt = (i) => {
    cross.setAttribute('x1', xs[i]);
    cross.setAttribute('x2', xs[i]);
    cross.setAttribute('visibility', 'visible');
    const rows = series
      .filter((s) => s.values[i] != null)
      .map((s) => ({ color: s.color, key: 'line', value: fmtNum(s.values[i]), name: s.name }));
    const k = wrap.clientWidth / VBW;
    showTip(wrap, tip, tipTitle(i), rows, xs[i] * k, m.t * k + 8);
  };
  const hide = () => {
    cross.setAttribute('visibility', 'hidden');
    hideTip(tip);
  };
  let focusIdx = n - 1;
  svg.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) * VBW) / rect.width;
    let best = 0;
    for (let i = 1; i < n; i++) if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i;
    focusIdx = best;
    showAt(best);
  });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('focus', () => showAt(focusIdx));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') focusIdx = Math.max(0, focusIdx - 1);
    else if (e.key === 'ArrowRight') focusIdx = Math.min(n - 1, focusIdx + 1);
    else if (e.key === 'Home') focusIdx = 0;
    else if (e.key === 'End') focusIdx = n - 1;
    else return;
    e.preventDefault();
    showAt(focusIdx);
  });

  // table twin
  card.appendChild(dataTable(
    ['', ...series.map((s) => s.name)],
    xLabels.map((xl, i) => [xl, ...series.map((s) => fmtNum(s.values[i]))]),
  ));
}

function lastIdx(values) {
  for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return i;
  return -1;
}

/** Rounded-data-end bar path (square at the baseline). */
function barPath(x, yTop, w, hgt, r) {
  if (hgt <= 0) return '';
  const rr = Math.min(r, w / 2, hgt);
  return `M${x} ${yTop + hgt} L${x} ${yTop + rr} Q${x} ${yTop} ${x + rr} ${yTop} `
    + `L${x + w - rr} ${yTop} Q${x + w} ${yTop} ${x + w} ${yTop + rr} `
    + `L${x + w} ${yTop + hgt} Z`;
}

/* -------------------------------------------------------------- bar charts */

/**
 * Vertical bars: 1 series (histogram) or 2 series (paired per group).
 * groups: [{label, values: (number|null)[]}], seriesNames.length = values.length.
 */
function renderBars(card, {
  groups, seriesNames, colors, valueFmt = (v) => fmtNum(v), tipTitle,
  ariaLabel, labelMax = false,
}) {
  const two = seriesNames.length >= 2;
  if (two) card.appendChild(legendRow(seriesNames.map((name, i) => ({ name, color: colors[i] })), 'rect'));
  const wrap = h('div', 'st-chartwrap');
  card.appendChild(wrap);

  const n = groups.length;
  const H = 190;
  const m = { t: 14, r: 8, b: 22, l: 32 };
  const plotW = VBW - m.l - m.r;
  const plotH = H - m.t - m.b;
  const all = groups.flatMap((g) => g.values).filter((v) => v != null);
  const ticks = yTicks(Math.max(...all, 0));
  const top = ticks[ticks.length - 1];
  const y = (v) => m.t + plotH * (1 - v / top);
  const band = plotW / n;
  const gap = 2; // surface gap between paired bars
  const barW = Math.min(two ? 14 : 24, two ? (band - gap - 8) / 2 : band - 8);

  const svg = svgEl('svg', {
    viewBox: `0 0 ${VBW} ${H}`, role: 'img', 'aria-label': ariaLabel,
  });
  wrap.appendChild(svg);
  gridAndAxis(svg, m, plotW, ticks, y, (t) => fmtNum(t, 1));

  const tip = makeTip(wrap);
  const maxVal = Math.max(...all, 0);
  let labeledMax = false;

  groups.forEach((g, gi) => {
    const cx = m.l + band * gi + band / 2;
    const barEls = [];
    g.values.forEach((v, si) => {
      if (v == null || v <= 0) return;
      const x = two
        ? cx - (si === 0 ? barW + gap / 2 : -gap / 2)
        : cx - barW / 2;
      const bar = svgEl('path', {
        d: barPath(x, y(v), barW, y(0) - y(v), 3),
        fill: colors[si], 'fill-opacity': 0.92,
      });
      svg.appendChild(bar);
      barEls.push(bar);
      // direct label on the tallest bar only — the rest live in tooltip/table
      if (labelMax && !labeledMax && v === maxVal) {
        labeledMax = true;
        const lbl = svgEl('text', {
          x: x + barW / 2, y: y(v) - 4, 'text-anchor': 'middle',
          'font-size': 9, 'font-weight': '600', fill: 'var(--ink-2)',
        });
        lbl.textContent = valueFmt(v);
        svg.appendChild(lbl);
      }
    });
    // x label
    const xl = svgEl('text', {
      x: cx, y: H - 8, 'text-anchor': 'middle', 'font-size': 9,
      fill: 'var(--ink-muted)',
    });
    xl.textContent = g.label;
    svg.appendChild(xl);

    // group hit target (full column, >= 24px effective) + focus/hover tooltip
    const rows = g.values
      .map((v, si) => ({ v, si }))
      .filter((e) => e.v != null)
      .map((e) => ({
        color: colors[e.si], key: 'rect', value: valueFmt(e.v),
        name: two ? seriesNames[e.si] : undefined,
      }));
    const aria = `${tipTitle(gi)}: ${g.values.map((v, si) => (v == null ? null
      : `${two ? `${seriesNames[si]} ` : ''}${valueFmt(v)}`)).filter(Boolean).join(', ') || 'no data'}`;
    const hit = svgEl('rect', {
      x: m.l + band * gi, y: m.t, width: band, height: plotH,
      fill: 'transparent', tabindex: '0', role: 'img', 'aria-label': aria,
      class: 'st-hit',
    });
    const lift = (on) => barEls.forEach((b) => b.setAttribute('fill-opacity', on ? 1 : 0.92));
    const show = () => {
      lift(true);
      if (rows.length === 0) return;
      const k = wrap.clientWidth / VBW;
      const topV = Math.max(...g.values.filter((v) => v != null), 0);
      showTip(wrap, tip, tipTitle(gi), rows, cx * k, y(topV) * k);
    };
    const hide = () => { lift(false); hideTip(tip); };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', show);
    hit.addEventListener('blur', hide);
    svg.appendChild(hit);
  });

  card.appendChild(dataTable(
    [' ', ...(two ? seriesNames : ['Value'])],
    groups.map((g, gi) => [tipTitle(gi), ...g.values.map((v) => valueFmt(v == null ? null : v))]),
  ));
}

/**
 * Horizontal rate bars (going-out): one row per player, direct % label at
 * the bar end, baseline at 0.
 */
function renderHBars(card, { rows, colors, ariaLabel }) {
  const wrap = h('div', 'st-chartwrap');
  card.appendChild(wrap);
  const rowH = 32;
  const m = { t: 8, r: 46, b: 8, l: 86 };
  const H = m.t + rows.length * rowH + m.b;
  const plotW = VBW - m.l - m.r;

  const svg = svgEl('svg', {
    viewBox: `0 0 ${VBW} ${H}`, role: 'img', 'aria-label': ariaLabel,
  });
  wrap.appendChild(svg);
  svg.appendChild(svgEl('line', {
    x1: m.l, x2: m.l, y1: m.t, y2: H - m.b,
    stroke: 'var(--baseline)', 'stroke-width': 1,
  }));

  const tip = makeTip(wrap);
  rows.forEach((r, i) => {
    const cy = m.t + rowH * i + rowH / 2;
    const w = Math.max(plotW * r.rate, 0);
    const name = svgEl('text', {
      x: m.l - 8, y: cy + 3, 'text-anchor': 'end', 'font-size': 11,
      fill: 'var(--ink-2)',
    });
    name.textContent = truncate(r.name, 11);
    svg.appendChild(name);
    if (w > 0) {
      // horizontal bar: rounded at the data end, square at the baseline
      const bh = 12;
      const rr = Math.min(4, w / 2);
      svg.appendChild(svgEl('path', {
        d: `M${m.l} ${cy - bh / 2} L${m.l + w - rr} ${cy - bh / 2} `
          + `Q${m.l + w} ${cy - bh / 2} ${m.l + w} ${cy - bh / 2 + rr} `
          + `L${m.l + w} ${cy + bh / 2 - rr} `
          + `Q${m.l + w} ${cy + bh / 2} ${m.l + w - rr} ${cy + bh / 2} `
          + `L${m.l} ${cy + bh / 2} Z`,
        fill: colors[i % colors.length], 'fill-opacity': 0.92,
      }));
    }
    const val = svgEl('text', {
      x: m.l + w + 6, y: cy + 3, 'font-size': 11, 'font-weight': '600',
      fill: 'var(--ink-1)',
    });
    val.textContent = fmtPct(r.rate);
    svg.appendChild(val);

    const hit = svgEl('rect', {
      x: 0, y: m.t + rowH * i, width: VBW, height: rowH, fill: 'transparent',
      tabindex: '0', role: 'img', class: 'st-hit',
      'aria-label': `${r.name}: went out in ${r.wentOut} of ${r.rounds} rounds (${fmtPct(r.rate)})`,
    });
    const show = () => {
      const k = wrap.clientWidth / VBW;
      showTip(wrap, tip, r.name, [{
        color: colors[i % colors.length], key: 'rect',
        value: fmtPct(r.rate), name: `${r.wentOut} of ${r.rounds} rounds`,
      }], (m.l + w) * k, (cy - 8) * k);
    };
    const hide = () => hideTip(tip);
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', show);
    hit.addEventListener('blur', hide);
    svg.appendChild(hit);
  });

  card.appendChild(dataTable(
    ['Player', 'Went out', 'Rounds', 'Rate'],
    rows.map((r) => [r.name, String(r.wentOut), String(r.rounds), fmtPct(r.rate)]),
  ));
}

/* ------------------------------------------------------------------ pieces */

function filterRow() {
  const row = h('div', 'st-filters');
  const kinds = [[null, 'All'], ['ai', 'vs AI'], ['online', 'Online'], ['scorekeeper', 'Real cards']];
  for (const [value, label] of kinds) {
    const chip = h('button', 'st-chip', label);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(view.kind === value));
    chip.addEventListener('click', () => {
      view.kind = value;
      view.trajIndex = 0;
      render();
    });
    row.appendChild(chip);
  }
  const hard = h('button', 'st-chip st-chip-hard', 'Hard mode');
  hard.type = 'button';
  hard.setAttribute('aria-pressed', String(view.hardOnly));
  hard.title = 'Show hard-mode games only';
  hard.addEventListener('click', () => {
    view.hardOnly = !view.hardOnly;
    view.trajIndex = 0;
    render();
  });
  row.appendChild(hard);
  return row;
}

/** The two names that get the two series colors, "you" first when present. */
function namePair(games, youName) {
  const agg = playerAggregates(games);
  const names = agg.map((a) => a.name);
  const pair = [];
  if (names.includes(youName)) pair.push(youName);
  for (const n of names) {
    if (pair.length >= 2) break;
    if (!pair.includes(n)) pair.push(n);
  }
  return pair;
}

function tile(label, value, sub) {
  const t = h('div', 'st-tile');
  t.appendChild(h('div', 'st-tile-label', label));
  t.appendChild(h('div', 'st-tile-value', value));
  if (sub) t.appendChild(h('div', 'st-tile-sub', sub));
  return t;
}

function overviewTiles(games, youName) {
  const tiles = h('div', 'st-tiles');
  const agg = playerAggregates(games);
  const you = agg.find((a) => a.name === youName) || agg[0] || null;
  const finished = games.filter((g) => g.finished).length;
  tiles.appendChild(tile('Games played', String(games.length),
    finished === games.length ? undefined : `${finished} finished`));

  if (you) {
    const st = streaks(games, you.name);
    tiles.appendChild(tile(`Win rate — ${you.name}`, fmtPct(you.winRate),
      `${you.wins}W ${you.losses}L ${you.ties}T${st.current > 1 ? ` · streak ${st.current}` : ''}`));
  } else {
    tiles.appendChild(tile('Win rate', '—'));
  }

  const h2h = you ? headToHead(games).find((p) => p.players.includes(you.name)) : null;
  if (h2h && you) {
    const yi = h2h.players.indexOf(you.name);
    const opp = h2h.players[1 - yi];
    tiles.appendChild(tile(`vs ${opp}`, `${h2h.wins[yi]}–${h2h.wins[1 - yi]}`,
      h2h.ties > 0 ? `${h2h.ties} tied` : `${h2h.games} games`));
  } else {
    tiles.appendChild(tile('Head to head', '—'));
  }

  const avg = averageScores(games);
  const yourAvg = you ? avg.perPlayer.find((p) => p.name === you.name) : null;
  tiles.appendChild(tile('Avg score', fmtNum(yourAvg ? yourAvg.avgTotal : avg.overall.avgTotal),
    you ? 'per finished game' : undefined));
  return tiles;
}

/* ------------------------------------------------------------------ charts */

function trajectoryCard(games) {
  const card = chartCard('Score trajectory', 'Cumulative score by round — lower is better');
  const withRounds = games.filter((g) => g.rounds.length > 0)
    .slice()
    .sort((a, b) => b.dateISO.localeCompare(a.dateISO));
  if (withRounds.length === 0) {
    card.appendChild(h('p', 'st-note', 'No round-by-round data yet.'));
    return card;
  }
  view.trajIndex = Math.min(Math.max(view.trajIndex, 0), withRounds.length - 1);
  const game = withRounds[view.trajIndex];

  const sel = h('div', 'st-selector');
  const older = h('button', 'st-arrow', '‹');
  older.type = 'button';
  older.setAttribute('aria-label', 'Older game');
  older.disabled = view.trajIndex >= withRounds.length - 1;
  older.addEventListener('click', () => { view.trajIndex++; render(); });
  const newer = h('button', 'st-arrow', '›');
  newer.type = 'button';
  newer.setAttribute('aria-label', 'Newer game');
  newer.disabled = view.trajIndex <= 0;
  newer.addEventListener('click', () => { view.trajIndex--; render(); });
  const label = h('span', 'st-selector-label',
    `${fmtDate(game.dateISO)} · ${game.players[0]} vs ${game.players[1]}`);
  sel.appendChild(older);
  sel.appendChild(label);
  sel.appendChild(newer);
  card.appendChild(sel);

  const traj = trajectory(game);
  renderLineChart(card, {
    // seat colors per contract: series-1 = player 0, series-2 = player 1
    series: game.players.map((name, i) => ({
      name, color: SERIES[i], values: traj.map((t) => t.cumulative[i]),
    })),
    xLabels: traj.map((t) => t.label),
    tipTitle: (i) => `Round of ${traj[i].label}s`,
    ariaLabel: `Cumulative score by round for ${game.players[0]} and ${game.players[1]}`,
  });
  return card;
}

function roundAveragesCard(games, pair) {
  const card = chartCard('Average points by round', 'Which rounds hurt the most');
  const rs = roundStats(games);
  if (rs.every((r) => r.count === 0)) {
    card.appendChild(h('p', 'st-note', 'No round data yet.'));
    return card;
  }
  const groups = rs.map((r) => ({
    label: r.label,
    values: pair.map((name) => {
      const p = r.perPlayer.find((e) => e.name === name);
      return p ? p.mean : null;
    }),
  }));
  renderBars(card, {
    groups,
    seriesNames: pair,
    colors: SERIES,
    tipTitle: (gi) => `Round of ${rs[gi].label}s`,
    ariaLabel: `Average points per round for ${pair.join(' and ')}`,
  });
  return card;
}

function totalsOverTimeCard(games, pair) {
  const card = chartCard('Total score over time', 'Final score of each finished game — lower is better');
  const finished = games.filter((g) => g.finished)
    .slice()
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO));
  if (finished.length === 0) {
    card.appendChild(h('p', 'st-note', 'No finished games yet.'));
    return card;
  }
  const idxById = new Map(finished.map((g, i) => [g.id, i]));
  const tot = totalsOverTime(games).filter((e) => pair.includes(e.name));
  const series = tot.map((e) => {
    const values = new Array(finished.length).fill(null);
    for (const p of e.points) values[idxById.get(p.gameId)] = p.total;
    return { name: e.name, color: SERIES[pair.indexOf(e.name)], values };
  });
  renderLineChart(card, {
    series,
    xLabels: finished.map((g) => fmtDate(g.dateISO)),
    tipTitle: (i) => fmtDate(finished[i].dateISO),
    ariaLabel: `Total score per game over time for ${series.map((s) => s.name).join(' and ')}`,
  });
  return card;
}

function distributionCard(games, youName) {
  const card = chartCard('Points per round', `${youName}'s per-round scores — the "0" bar is clean/went-out rounds`);
  const dist = caughtDistribution(games, 5, youName, true);
  if (dist.total === 0) {
    card.appendChild(h('p', 'st-note', `No rounds recorded for ${youName} in these games.`));
    return card;
  }
  renderBars(card, {
    groups: dist.buckets.map((b) => ({ label: b.label, values: [b.count] })),
    seriesNames: ['Rounds'],
    colors: [SERIES[0]],
    valueFmt: (v) => (v == null ? '—' : String(v)),
    tipTitle: (gi) => `${dist.buckets[gi].label} points`,
    ariaLabel: `Histogram of ${youName}'s per-round scores, ${dist.total} rounds`,
    labelMax: true,
  });
  return card;
}

function goingOutCard(games, pair) {
  const card = chartCard('Going-out rate', 'Share of scored rounds each player went out first');
  const go = goingOutStats(games).filter((e) => pair.includes(e.name));
  if (go.length === 0) {
    card.appendChild(h('p', 'st-note', 'No going-out data recorded yet.'));
    return card;
  }
  go.sort((a, b) => pair.indexOf(a.name) - pair.indexOf(b.name));
  renderHBars(card, {
    rows: go,
    colors: go.map((e) => SERIES[pair.indexOf(e.name)]),
    ariaLabel: `Going-out rate for ${go.map((e) => e.name).join(' and ')}`,
  });
  return card;
}

function recordsCard(games, youName) {
  const rec = singleRoundRecords(games, youName);
  if (!rec.worstHand && rec.timesWentOut === 0) return null; // youName not in these games
  const card = chartCard('Your records', `Single-round highs for ${youName}`);
  const grid = h('div', 'st-extremes st-records');
  const box = (label, value, sub) => {
    const b = h('div', 'st-extreme');
    b.appendChild(h('div', 'st-extreme-label', label));
    b.appendChild(h('div', 'st-extreme-value', value));
    if (sub) b.appendChild(h('div', 'st-extreme-sub', sub));
    return b;
  };
  const wh = rec.worstHand;
  grid.appendChild(box('Worst hand', wh ? `${wh.score} pts` : '—',
    wh ? `round of ${wh.label}s · vs ${truncate(wh.opponent, 10)}` : undefined));
  // cleanRounds ⊇ timesWentOut: a caught player who fully melds also scores 0,
  // and imported rounds where both scored 0 have no went-out marker. Showing
  // both keeps this tile consistent with the histogram's "0" bar.
  const extraClean = rec.cleanRounds - rec.timesWentOut;
  grid.appendChild(box('Times gone out', String(rec.timesWentOut),
    extraClean > 0 ? `+${extraClean} more rounds scored 0` : 'rounds you melded out first'));
  const bh = rec.biggestHit;
  grid.appendChild(box('Biggest hit', bh ? `${bh.score} pts` : '—',
    bh ? `${truncate(bh.opponent, 10)}, round of ${bh.label}s` : undefined));
  card.appendChild(grid);
  return card;
}

function eloCard(games, youName, pair) {
  const { ratings, series } = eloRatings(games);
  if (ratings.length < 2) return null; // need at least one decided/tied game
  const card = chartCard('Elo ratings', 'Skill rating from finished games (starts at 1500)');

  const table = h('table', 'st-elo');
  const thead = h('thead');
  const hr = h('tr');
  for (const head of ['#', 'Player', 'Elo', 'W–L–T']) hr.appendChild(h('th', null, head));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = h('tbody');
  ratings.forEach((r, i) => {
    const tr = h('tr');
    if (r.name === youName) tr.className = 'st-elo-you';
    tr.appendChild(h('td', null, String(i + 1)));
    tr.appendChild(h('td', 'st-elo-name', r.name));
    tr.appendChild(h('td', null, String(r.rating)));
    tr.appendChild(h('td', null, `${r.wins}–${r.losses}–${r.ties}`));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  card.appendChild(table);

  // Rating-progression chart for the named player + main opponent.
  const finished = games.filter((g) => g.finished
    && (g.winner === 0 || g.winner === 1 || g.winner === 'tie'))
    .slice()
    .sort((a, b) => a.dateISO.localeCompare(b.dateISO) || String(a.id).localeCompare(String(b.id)));
  if (finished.length >= 2 && pair.length) {
    const idxById = new Map(finished.map((g, i) => [g.id, i]));
    const chartSeries = pair
      .map((name) => series.find((s) => s.name === name))
      .filter(Boolean)
      .map((s) => {
        const values = new Array(finished.length).fill(null);
        for (const p of s.points) {
          if (p.gameId != null && idxById.has(p.gameId)) values[idxById.get(p.gameId)] = p.rating;
        }
        return { name: s.name, color: SERIES[pair.indexOf(s.name)] || SERIES[0], values };
      })
      .filter((s) => s.values.some((v) => v != null));
    if (chartSeries.length) {
      const chartWrap = h('div', 'st-elo-chart');
      renderLineChart(chartWrap, {
        series: chartSeries,
        xLabels: finished.map((g) => fmtDate(g.dateISO)),
        tipTitle: (i) => fmtDate(finished[i].dateISO),
        ariaLabel: `Elo rating over time for ${chartSeries.map((s) => s.name).join(' and ')}`,
        fitDomain: true, // Elo lives ~1400-1600; a 0-based axis flattens it
      });
      card.appendChild(chartWrap);
    }
  }
  return card;
}

/* -------------------------------------------------------------- games list */

function gameResultFor(game, youName) {
  if (!game.finished) return { text: 'In progress', cls: 'st-result-other' };
  if (game.winner === 'tie') return { text: 'Tie', cls: 'st-result-other' };
  if (game.winner !== 0 && game.winner !== 1) return { text: '—', cls: 'st-result-other' };
  const winnerName = game.players[game.winner];
  if (game.players.includes(youName)) {
    return winnerName === youName
      ? { text: 'Won', cls: 'st-result-win' }
      : { text: 'Lost', cls: 'st-result-loss' };
  }
  return { text: `${truncate(winnerName, 10)} won`, cls: 'st-result-other' };
}

function gameDetail(game) {
  const detail = h('div', 'st-game-detail');
  const table = h('table');
  const thead = h('thead');
  const hr = h('tr');
  for (const head of ['Round', game.players[0], game.players[1], 'Out']) {
    hr.appendChild(h('th', null, head));
  }
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = h('tbody');
  for (const r of game.rounds) {
    const tr = h('tr');
    tr.appendChild(h('td', null, r.round === 11 ? 'J' : r.round === 12 ? 'Q' : r.round === 13 ? 'K' : String(r.round)));
    tr.appendChild(h('td', null, String(r.scores[0])));
    tr.appendChild(h('td', null, String(r.scores[1])));
    tr.appendChild(h('td', null, r.wentOut === null ? '—' : truncate(game.players[r.wentOut], 8)));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  const tfoot = h('tfoot');
  const fr = h('tr');
  fr.appendChild(h('td', null, 'Total'));
  fr.appendChild(h('td', null, String(game.totals[0])));
  fr.appendChild(h('td', null, String(game.totals[1])));
  fr.appendChild(h('td', null, ''));
  tfoot.appendChild(fr);
  table.appendChild(tfoot);
  detail.appendChild(table);

  const btns = h('div', 'st-btn-row');
  const del = h('button', 'st-btn st-btn-danger', 'Delete game');
  del.type = 'button';
  del.addEventListener('click', () => {
    const ok = window.confirm(
      `Delete the ${fmtDate(game.dateISO)} game (${game.players[0]} vs ${game.players[1]})? This cannot be undone.`,
    );
    if (!ok) return;
    deleteGame(game.id);
    view.expandedId = null;
    toast('Game deleted');
    render();
  });
  btns.appendChild(del);
  detail.appendChild(btns);
  return detail;
}

function gamesListCard(games, youName) {
  const card = h('section', 'st-card');
  card.appendChild(h('h3', null, 'Recent games'));
  const sorted = games.slice().sort((a, b) => b.dateISO.localeCompare(a.dateISO));
  // Collapsed by default: the last 3 games, with a one-tap expand. Expanded
  // view is still bounded (mobile DOM) at MAX with a note beyond that.
  const COLLAPSED = 3;
  const MAX = 100;
  const shown = view.showAllGames ? MAX : COLLAPSED;
  for (const game of sorted.slice(0, shown)) {
    const row = h('div', 'st-game');
    const head = h('button', 'st-game-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(view.expandedId === game.id));

    const l1 = h('div', 'st-game-l1');
    l1.appendChild(h('span', 'st-game-date', fmtDate(game.dateISO)));
    l1.appendChild(h('span', 'st-badge',
      game.kind === 'ai' && game.aiLevel ? `vs AI · ${game.aiLevel}` : KIND_LABELS[game.kind]));
    if (game.hardMode) l1.appendChild(h('span', 'st-badge', 'Hard'));
    head.appendChild(l1);

    const l2 = h('div', 'st-game-l2');
    l2.appendChild(h('span', 'st-game-players', `${game.players[0]} vs ${game.players[1]}`));
    l2.appendChild(h('span', 'st-game-score', `${game.totals[0]}–${game.totals[1]}`));
    const res = gameResultFor(game, youName);
    l2.appendChild(h('span', `st-game-result ${res.cls}`, res.text));
    head.appendChild(l2);

    head.addEventListener('click', () => {
      view.expandedId = view.expandedId === game.id ? null : game.id;
      render();
    });
    row.appendChild(head);
    if (view.expandedId === game.id) row.appendChild(gameDetail(game));
    card.appendChild(row);
  }
  if (!view.showAllGames && sorted.length > COLLAPSED) {
    const more = h('button', 'st-btn st-btn-wide', `Show all ${sorted.length} games`);
    more.type = 'button';
    more.addEventListener('click', () => {
      view.showAllGames = true;
      render();
    });
    card.appendChild(more);
  } else if (view.showAllGames) {
    if (sorted.length > MAX) {
      card.appendChild(h('p', 'st-note', `Showing the latest ${MAX} of ${sorted.length} games.`));
    }
    if (sorted.length > COLLAPSED) {
      const less = h('button', 'st-btn st-btn-wide', 'Show fewer');
      less.type = 'button';
      less.addEventListener('click', () => {
        view.showAllGames = false;
        render();
      });
      card.appendChild(less);
    }
  }
  return card;
}

/* ----------------------------------------------------------- export/import */

function doExport() {
  const stamp = new Date().toISOString().slice(0, 10);
  const blob = new Blob([exportJSON()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `four-crowns-stats-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importButton(label, className) {
  const btn = h('button', className, label);
  btn.type = 'button';
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.hidden = true;
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    try {
      const res = importJSON(await file.text());
      toast(`Imported ${res.added} new, ${res.updated} updated`
        + (res.skipped ? `, ${res.skipped} skipped` : ''));
      render();
    } catch (err) {
      toast(err && err.message ? err.message : 'Import failed');
    }
  });
  btn.addEventListener('click', () => input.click());
  const frag = document.createDocumentFragment();
  frag.appendChild(btn);
  frag.appendChild(input);
  return frag;
}

function backupCard() {
  const card = h('section', 'st-card');
  card.appendChild(h('h3', null, 'Backup'));
  const row = h('div', 'st-btn-row');
  const exp = h('button', 'st-btn', 'Export JSON');
  exp.type = 'button';
  exp.addEventListener('click', doExport);
  row.appendChild(exp);
  row.appendChild(importButton('Import JSON', 'st-btn'));
  card.appendChild(row);
  card.appendChild(h('p', 'st-io-note',
    'Import merges by game id — your existing games are never wiped.'));
  return card;
}

/* ------------------------------------------------------------------ render */

function emptyState() {
  const card = h('section', 'st-card st-empty');
  card.appendChild(h('h3', null, 'No games yet'));
  card.appendChild(h('p', null,
    'Play a hand or two and your stats, streaks and charts will show up here.'));
  const row = h('div', 'st-btn-row');
  const play = h('button', 'st-btn st-btn-primary', 'Start a game');
  play.type = 'button';
  play.addEventListener('click', () => navigate('home'));
  row.appendChild(play);
  const score = h('button', 'st-btn', 'Score a real-cards game');
  score.type = 'button';
  score.addEventListener('click', () => navigate('scorekeeper'));
  row.appendChild(score);
  row.appendChild(importButton('Import backup', 'st-btn'));
  card.appendChild(row);
  return card;
}

function render() {
  if (!root || !root.isConnected) return;
  root.textContent = '';
  root.appendChild(h('h2', 'st-h', 'Stats'));

  const allGames = getGames();
  if (allGames.length === 0) {
    root.appendChild(emptyState());
    return;
  }

  // one filter row, scoping every tile, chart and list below it
  root.appendChild(filterRow());
  const games = filterGames(allGames, {
    kind: view.kind,
    hardMode: view.hardOnly ? true : null,
  });
  if (games.length === 0) {
    root.appendChild(h('p', 'st-note', 'No games match these filters.'));
    root.appendChild(backupCard());
    return;
  }

  const youName = getSettings().playerName;
  const pair = namePair(games, youName);

  root.appendChild(overviewTiles(games, youName));
  const records = recordsCard(games, youName);
  if (records) root.appendChild(records);
  root.appendChild(trajectoryCard(games));
  root.appendChild(roundAveragesCard(games, pair));
  root.appendChild(totalsOverTimeCard(games, pair));
  root.appendChild(distributionCard(games, youName));
  root.appendChild(goingOutCard(games, pair));
  const elo = eloCard(games, youName, pair);
  if (elo) root.appendChild(elo);
  root.appendChild(gamesListCard(games, youName));
  root.appendChild(backupCard());
}

registerScreen('stats', {
  mount(container) {
    injectStyles();
    view.expandedId = null;
    view.showAllGames = false;
    container.textContent = '';
    root = h('div', 'st-root');
    container.appendChild(root);
    render();
  },
});
