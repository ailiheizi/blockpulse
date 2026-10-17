const CHART_COLORS = Object.freeze(['red', 'black', 'green']);
const PAINT = Object.freeze({ red: 'var(--red)', black: 'var(--blue)', green: 'var(--green)' });

/** Draws three outcome price lines; points are { timeMs, prices } within one round. */
export function drawPriceChart(svg, { durationMs, lockMs, points, elapsedMs, prices, label, title }) {
  const width = Math.max(230, svg.getBoundingClientRect().width || 650);
  const height = 210, left = 32, right = width - 10, top = 13, bottom = 178;
  const x = ms => left + Math.min(1, Math.max(0, ms / durationMs)) * (right - left);
  const y = p => top + (1 - p) * (bottom - top);
  const visible = points.filter(point => point.prices && point.timeMs <= elapsedMs);
  if (!visible.length) visible.push({ timeMs: 0, prices });
  if (visible.at(-1).timeMs !== elapsedMs) visible.push({ timeMs: elapsedMs, prices });
  const sampleEvery = Math.max(1, Math.ceil(visible.length / 600));
  const sampled = visible.filter((_, index) => index % sampleEvery === 0 || index === visible.length - 1);
  const seconds = durationMs / 1000;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('aria-label', label);
  svg.innerHTML = `<title>${title}</title><rect x="${x(lockMs)}" y="${top}" width="${right - x(lockMs)}" height="${bottom - top}" class="chart-lock"/>
    ${[0, 0.25, 0.5, 0.75, 1].map(p => `<line x1="${left}" x2="${right}" y1="${y(p)}" y2="${y(p)}" class="chart-grid"/><text x="0" y="${y(p) + 3}" class="chart-text">${p.toFixed(2)}</text>`).join('')}
    ${[0, 0.25, 0.5, 0.75, 1].map(f => `<text x="${x(f * durationMs)}" y="203" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}" class="chart-text">${Math.round(f * seconds)}s</text>`).join('')}
    ${CHART_COLORS.map(c => `<path d="${sampled.map((p, i) => `${i ? 'L' : 'M'}${x(p.timeMs).toFixed(2)},${y(p.prices[c]).toFixed(2)}`).join(' ')}" class="chart-line" style="stroke:${PAINT[c]}"/><circle cx="${x(elapsedMs)}" cy="${y(prices[c])}" r="3" style="fill:${PAINT[c]}"/>`).join('')}`;
}
