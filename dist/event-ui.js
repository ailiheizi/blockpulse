const $ = id => document.getElementById(id);
const signed = n => `${n > 0 ? '+' : ''}${n}`;
const COLOR_NAME = { red: '红', black: '黑', green: '绿' };

function setText(id, value) {
  const node = $(id);
  if (node.textContent !== value) node.textContent = value;
}

let chartKey = '';

function drawProgress(state) {
  const e = state.event;
  const svg = $('event-chart');
  const key = e ? `${e.startBlock}:${e.observed}:${e.busy}:${state.heat}` : '';
  if (key === chartKey) return;
  chartKey = key;
  if (!e) { svg.innerHTML = ''; return; }
  const shift = state.heat - state.baseline;
  const hi = e.baseline + e.tolerance - shift;
  const lo = e.baseline - e.tolerance - shift;
  const top = Math.max(hi + 6, e.busy + 4, Math.ceil(e.baseline * 1.25));
  const left = 30, right = 590, upper = 10, lower = 128;
  const x = block => left + block / e.windowBlocks * (right - left);
  const y = count => lower - count / top * (lower - upper);
  const points = [[0, 0], ...e.series.map((count, index) => [index + 1, count])];
  const line = points.map(([block, count], index) => `${index ? 'L' : 'M'}${x(block).toFixed(1)},${y(count).toFixed(1)}`).join(' ');
  let projection = '';
  if (e.observed >= 10) {
    const slope = e.busy / e.observed;
    projection = `<path class="event-project" d="M${x(e.observed).toFixed(1)},${y(e.busy).toFixed(1)} L${x(e.windowBlocks).toFixed(1)},${y(slope * e.windowBlocks).toFixed(1)}"/>`;
  }
  const mid = (a, b) => (y(a) + y(b)) / 2 + 3;
  svg.innerHTML = `<line class="event-lock" x1="${x(e.lockBlocks)}" x2="${x(e.lockBlocks)}" y1="${upper}" y2="${lower}"/>
    <rect x="${right}" y="${y(Math.min(top, hi))}" width="8" height="${Math.max(0, y(lo) - y(Math.min(top, hi)))}" class="event-green" opacity="0.55"/>
    <text x="${right + 12}" y="${mid(top, hi)}" class="chart-text">红 &gt; ${hi}</text>
    <text x="${right + 12}" y="${mid(hi, lo)}" class="chart-text">绿</text>
    <text x="${right + 12}" y="${mid(lo, 0)}" class="chart-text">黑 &lt; ${lo}</text>
    <path class="event-expect" d="M${x(0)},${y(0)} L${x(e.windowBlocks)},${y(e.baseline)}"/>
    ${projection}<path class="event-line" d="${line}"/>
    <text x="${x(e.lockBlocks) - 4}" y="${upper + 9}" text-anchor="end" class="chart-text">封盘 ${e.lockBlocks}</text>
    <text x="${left}" y="143" class="chart-text">0</text><text x="${right}" y="143" text-anchor="end" class="chart-text">${e.windowBlocks} 块</text>`;
}

/** Fills the event panel from engine state and block-feed state; DOM text only. */
export function renderEventPanel(state, feed) {
  const e = state.event;
  const pill = $('event-feed-state');
  const label = { idle: '未连接', loading: '读取中', live: '已连接', error: '读取失败' }[feed.status] || '未连接';
  pill.textContent = label;
  pill.className = `phase-pill ${feed.status === 'live' ? 'trading' : feed.status === 'error' ? 'locked' : 'ready'}`;
  setText('event-observed', e ? `${e.observed} / ${e.windowBlocks}` : '— / 180');
  setText('event-head', e ? `起点 #${e.startBlock}${e.observed ? ` · 最新 #${e.startBlock + e.observed}` : ''}` : feed.head ? `链头 #${feed.head}` : '—');
  setText('event-busy', e ? String(e.busy) : '—');
  setText('event-baseline', e ? String(e.baseline) : '—');
  setText('event-baseline-note', e ? `近 ${e.sampleBlocks} 块中 ${e.sampleBusy} 块繁忙（${(e.rate * 100).toFixed(0)}%）× ${e.windowBlocks}` : feed.status === 'loading' ? `读取基准区块 ${feed.loaded} / ${feed.target}` : '等待读取区块');
  if (e && e.observed >= 10) {
    const projected = Math.round(e.busy * e.windowBlocks / e.observed);
    setText('event-projection', `X ≈ ${projected}`);
    setText('event-projection-note', `偏差 ${signed(projected - e.baseline)}，封盘前仍会波动`);
  } else {
    setText('event-projection', '—');
    setText('event-projection-note', e ? '观察满 10 个区块后显示' : '封盘前仍会波动');
  }
  drawProgress(state);
  let message = '';
  if (feed.status === 'error') message = feed.error || '区块读取失败。';
  else if (feed.status === 'loading') message = `正在读取最近 ${feed.target || 600} 个区块作为基准，公开 RPC 限速，约需半分钟。`;
  else if (state.phase === 'settled' && state.result?.voided) message = `本轮作废：${state.result.reason}。未平仓份额已按含费成本退回，已平仓交易的损益保留。`;
  else if (state.phase === 'settled' && state.result?.event) {
    const r = state.result;
    message = `结算：繁忙块 X = ${r.event.busy}，基准 B = ${r.event.baseline}，偏差 ${signed(r.noise)}；行动偏移 ${signed(r.actionHeat - state.baseline)}；收盘热度 ${r.finalHeat}，${COLOR_NAME[r.color]}盘命中。区块 #${r.event.startBlock + 1} 至 #${r.event.endBlock} 可在区块浏览器核对。`;
  } else if (state.phase === 'locked') message = '已封盘：只等剩余区块出完，期间不能交易或行动。';
  else if (state.phase === 'trading') message = `交易中：第 ${e.lockBlocks} 个区块出现时封盘。区块读取延迟约 1 秒，报价按已读到的区块计算。`;
  else if (feed.status === 'live') message = '基准已就绪。点击开始后，从下一个新区块起统计。';
  setText('event-status', message);
  $('event-retry').hidden = feed.status !== 'error';
}
