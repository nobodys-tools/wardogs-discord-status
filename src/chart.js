// Renders the 24h player-count chart as a PNG buffer.
import { Canvas, hexToRgb } from "./png.js";

const BG = [43, 45, 49];          // discord dark embed grey
const GRID = [70, 73, 80];
const TEXT = [160, 165, 175];
const OFFLINE = [200, 90, 90, 90];

/**
 * @param {object} h  result of db.history()  { series: (number|null)[], start, end, peak, avg }
 * @param {number} maxPlayers  server slot cap (0 = unknown)
 * @param {string} accentHex   line colour
 */
export function renderChart(h, maxPlayers, accentHex, { width = 800, height = 220 } = {}) {
  const accent = hexToRgb(accentHex, [217, 70, 70]);
  const c = new Canvas(width, height, BG);

  const padL = 44, padR = 16, padT = 14, padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const baseY = padT + plotH;

  const series = h.series;
  const n = series.length;
  const observedMax = Math.max(0, ...series.filter((v) => v !== null));
  let yMax = maxPlayers > 0 ? maxPlayers : Math.max(4, observedMax);
  if (observedMax > yMax) yMax = observedMax;
  // nice rounding when cap unknown
  if (maxPlayers <= 0) yMax = Math.ceil(yMax / 4) * 4;

  const xOf = (i) => padL + (i / (n - 1)) * plotW;
  const yOf = (v) => baseY - (Math.min(v, yMax) / yMax) * plotH;

  // horizontal grid at 0, 25, 50, 75, 100 %
  for (let k = 0; k <= 4; k++) {
    const v = (yMax * k) / 4;
    const y = yOf(v);
    c.fillRect(padL, y, plotW, 1, GRID);
    const label = String(Math.round(v));
    c.text(padL - 6 - Canvas.textWidth(label, 2), y - 7, label, TEXT, 2);
  }

  // vertical ticks every 6h
  const hours = (h.end - h.start) / 3600_000;
  for (let t = 0; t <= hours; t += 6) {
    const i = (t / hours) * (n - 1);
    const x = xOf(i);
    c.fillRect(x, padT, 1, plotH, GRID);
    const label = t === hours ? "now" : `-${hours - t}h`;
    const w = Canvas.textWidth(label, 2);
    const tx = t === hours ? x - w : t === 0 ? x : x - w / 2;
    c.text(tx, baseY + 8, label, TEXT, 2);
  }

  // fill + line. Gaps (null) are drawn as a faint red baseline mark.
  let prev = null;
  for (let i = 0; i < n; i++) {
    const v = series[i];
    const x = xOf(i);
    if (v === null) {
      const x0 = i === 0 ? x : xOf(i - 1);
      c.fillRect(x0, baseY - 2, x - x0 + 1, 3, OFFLINE);
      prev = null;
      continue;
    }
    const y = yOf(v);
    if (prev) {
      // area fill under the segment, column by column
      const x0 = Math.round(prev.x), x1 = Math.round(x);
      for (let xx = x0; xx <= x1; xx++) {
        const t = x1 === x0 ? 1 : (xx - x0) / (x1 - x0);
        const yy = prev.y + (y - prev.y) * t;
        c.fillRect(xx, yy, 1, baseY - yy, [accent[0], accent[1], accent[2], 70]);
      }
      c.line(prev.x, prev.y, x, y, accent, 3);
    } else {
      c.fillRect(x, y, 1, baseY - y, [accent[0], accent[1], accent[2], 70]);
    }
    prev = { x, y };
  }
  if (prev) c.circle(prev.x, prev.y, 4, accent);

  // axes
  c.fillRect(padL, padT, 1, plotH + 1, [110, 114, 122]);
  c.fillRect(padL, baseY, plotW, 1, [110, 114, 122]);

  return c.toPNG();
}

// Text-only fallback for when charts are disabled: 24 hourly bars.
const BLOCKS = "▁▂▃▄▅▆▇█";
export function sparkline(h, maxPlayers) {
  const src = h.series;
  const step = Math.max(1, Math.floor(src.length / 24));
  const out = [];
  const cap = maxPlayers > 0 ? maxPlayers : Math.max(1, ...src.filter((v) => v !== null));
  for (let i = 0; i < src.length; i += step) {
    const slice = src.slice(i, i + step).filter((v) => v !== null);
    if (!slice.length) { out.push("·"); continue; }
    const v = Math.max(...slice);
    const idx = Math.min(BLOCKS.length - 1, Math.round((v / cap) * (BLOCKS.length - 1)));
    out.push(BLOCKS[idx]);
  }
  return out.join("");
}

const fmtK = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k` : String(Math.round(v)));

/**
 * Cash over the current match: total (accent) + one line per faction (its colour).
 * @param samples  db.matchSamples() rows, chronological
 * @param factions [{ name, colorHex }]
 */
export function renderCashChart(samples, factions, accentHex, { width = 800, height = 240 } = {}) {
  const accent = hexToRgb(accentHex, [217, 70, 70]);
  const c = new Canvas(width, height, BG);
  const padL = 56, padR = 16, padT = 14, padB = 48;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const baseY = padT + plotH;

  const t0 = samples[0]?.ts ?? Date.now();
  const t1 = Math.max(samples[samples.length - 1]?.ts ?? t0, t0 + 60_000);
  const series = [
    { label: "total", color: accent, values: samples.map((s) => [s.ts, s.totalCash]) },
    ...factions.map((f) => ({ label: f.name, color: hexToRgb(f.colorHex, [180, 180, 180]), values: samples.map((s) => [s.ts, s.factionCash?.[f.name] ?? 0]) })),
  ];
  const observedMax = Math.max(1, ...series.flatMap((sr) => sr.values.map((v) => v[1])));
  const step = niceStep(observedMax / 4);
  const yMax = Math.ceil(observedMax / step) * step;
  const xOf = (t) => padL + ((t - t0) / (t1 - t0)) * plotW;
  const yOf = (v) => baseY - (v / yMax) * plotH;

  for (let v = 0; v <= yMax; v += step) {
    const y = yOf(v);
    c.fillRect(padL, y, plotW, 1, GRID);
    const label = fmtK(v);
    c.text(padL - 6 - Canvas.textWidth(label, 2), y - 7, label, TEXT, 2);
  }
  // x ticks in minutes since match start
  const spanMin = (t1 - t0) / 60_000;
  const tickMin = Math.max(1, niceStep(spanMin / 6, [1, 2, 5, 10, 15, 30, 60, 120]));
  for (let m = 0; m <= spanMin + 0.01; m += tickMin) {
    const x = xOf(t0 + m * 60_000);
    c.fillRect(x, padT, 1, plotH, GRID);
    const label = `${Math.round(m)}m`;
    const w = Canvas.textWidth(label, 2);
    c.text(Math.min(x - w / 2, width - padR - w), baseY + 8, label, TEXT, 2);
  }

  for (const sr of series) {
    let prev = null;
    for (const [t, v] of sr.values) {
      const x = xOf(t), y = yOf(v);
      if (prev) c.line(prev.x, prev.y, x, y, sr.color, sr.label === "total" ? 3 : 2);
      prev = { x, y };
    }
    if (prev) c.circle(prev.x, prev.y, 3, sr.color);
  }

  // legend along the bottom
  let lx = padL;
  const ly = height - 18;
  for (const sr of series) {
    c.fillRect(lx, ly + 2, 10, 10, sr.color);
    const label = sr.label.toLowerCase();
    c.text(lx + 14, ly, label, TEXT, 2);
    lx += 14 + Canvas.textWidth(label, 2) + 18;
  }

  c.fillRect(padL, padT, 1, plotH + 1, [110, 114, 122]);
  c.fillRect(padL, baseY, plotW, 1, [110, 114, 122]);
  return c.toPNG();
}

function niceStep(raw, bases = [1, 2, 2.5, 5, 10]) {
  if (raw <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const b of bases) if (b * mag >= raw) return b * mag;
  return bases[bases.length - 1] * mag;
}
