import { createGame, resetGame, startRound, advance, executeTrade, playerAction, nextRound, quoteTrade, marketPrices, scenarioOdds, participantStats } from './game.js';
import { mountMonad } from './monad-ui.js';

const $ = id => document.getElementById(id);
const setText = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
const KEY = 'blockpulse-playground-v2';
const COLORS = ['red', 'black', 'green'];
const LABELS = { red: '红', black: '黑', green: '绿' };
const NAMES = { red: '红 · 上行', black: '黑 · 下行', green: '绿 · 区间' };
const PAINT = { red: 'var(--red)', black: 'var(--blue)', green: 'var(--green)' };
const fmt = (n, digits = 2) => Number.isFinite(n) ? n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
const moneyFmt = (n, digits = 3) => n > 0 && n < 10 ** -digits ? `<${(10 ** -digits).toFixed(digits)}` : fmt(n, digits);
const signed = (n, digits = 2) => `${n > 0 ? '+' : ''}${fmt(Math.abs(n) < 0.0000005 ? 0 : n, digits)}`;
const percent = n => `${fmt(n * 100, 1)}%`;
const pnlClass = n => n > 0.0000005 ? 'gain' : n < -0.0000005 ? 'loss' : '';
const esc = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const playerOf = s => s.participants.find(p => p.id === 'player');
const freshSeed = () => Math.floor(Math.random() * 0x100000000);
const live = s => s.phase === 'trading' || s.phase === 'locked';
let state = createGame(freshSeed(), { botCount: 2 });
let selectedColor = 'red';
let selectedSide = 'buy';
let lastNow = performance.now();
let lastPhase = '';
let lastPersistAt = 0;
let chartKey = '', botKey = '', tradeKey = '', resultKey = '', feedKey = '';
let simulationFailed = false;

// Ignore v1 storage entirely. Validate schema, money, timers, inventories and the
// deterministic scheduler before trusting a locally saved v2 session.
function validSaved(saved) {
  const s = saved?.state;
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const nonnegative = n => finite(n) && n >= 0;
  if (saved?.version !== 2 || s?.schemaVersion !== 2 || !['ready', 'trading', 'locked', 'settled'].includes(s.phase)) return false;
  if (![2, 20].includes(s.botCount) || s.participants?.length !== s.botCount + 1) return false;
  if (!Number.isInteger(s.round) || s.round < 1 || s.durationMs !== 60000 || s.tradingDurationMs !== 55000) return false;
  if (!nonnegative(s.elapsedMs) || s.elapsedMs > 60000 || !finite(s.remainingMs) || Math.abs(s.elapsedMs + s.remainingMs - 60000) > 0.001) return false;
  if ((s.phase === 'ready' && s.elapsedMs !== 0) || (s.phase === 'trading' && s.elapsedMs >= 55000) || (s.phase === 'locked' && (s.elapsedMs < 55000 || s.elapsedMs >= 60000)) || (s.phase === 'settled' && s.elapsedMs !== 60000)) return false;
  if (!Number.isInteger(s.block) || s.block !== Math.floor(s.elapsedMs / 500) || !Number.isInteger(s.heat) || s.baseline !== 100) return false;
  if (s.greenBand?.[0] !== 98 || s.greenBand?.[1] !== 102 || s.actionLimit !== 3 || s.noiseRange !== s.participants.length * 3 + 3) return false;
  const ids = new Set();
  for (const p of s.participants) {
    if (typeof p.id !== 'string' || ids.has(p.id) || typeof p.name !== 'string' || !['player', 'momentum', 'value'].includes(p.strategy)) return false;
    ids.add(p.id);
    if (!nonnegative(p.balance) || !Number.isInteger(p.tickets) || p.tickets < 0 || p.tickets > 3 || !nonnegative(p.peakEquity) || !nonnegative(p.maxDrawdown) || p.maxDrawdown > 1 || !finite(p.realizedPnl) || !Number.isInteger(p.tradeCount) || p.tradeCount < 0) return false;
    if (!COLORS.every(c => Number.isInteger(p.holdings?.[c]) && p.holdings[c] >= 0 && nonnegative(p.costBasis?.[c]))) return false;
    if (!finite(s._roundStartBalances?.[p.id])) return false;
  }
  if (!ids.has('player') || playerOf(s).strategy !== 'player') return false;
  if (!nonnegative(s.market?.cash) || !finite(s.market?.b) || s.market.b <= 0 || s.market.feeRate !== 0.003 || !COLORS.every(c => Number.isInteger(s.market.q?.[c]) && s.market.q[c] >= 0 && s.market.q[c] <= s.market.cash + 0.000001)) return false;
  if (s.initialTotal !== (s.botCount + 1) * 1000 + 1000 || Math.abs(s.participants.reduce((sum, p) => sum + p.balance, s.market.cash) - s.initialTotal) > 0.001) return false;
  if (!COLORS.every(c => Math.abs(s.participants.reduce((sum, p) => sum + p.holdings[c], 0) - s.market.q[c]) < 0.000001)) return false;
  if (!Array.isArray(s.history) || !s.history.length || s.history.length > 10000 || !s.history.every(p => nonnegative(p.timeMs) && p.timeMs <= s.elapsedMs && finite(p.heat) && COLORS.every(c => nonnegative(p.prices?.[c]) && p.prices[c] <= 1))) return false;
  if (!Array.isArray(s.events) || !Array.isArray(s.trades) || !Array.isArray(s.results) || !Number.isInteger(s.tradeCount) || s.tradeCount < 0) return false;
  const validResult = r => r && Number.isInteger(r.round) && r.round > 0 && r.round <= s.round
    && COLORS.includes(r.color) && Number.isInteger(r.finalHeat) && Number.isInteger(r.actionHeat)
    && Number.isInteger(r.noise) && Math.abs(r.noise) <= s.noiseRange && r.finalHeat === r.actionHeat + r.noise
    && finite(r.profits?.player) && nonnegative(r.payouts?.player)
    && COLORS.every(c => nonnegative(r.closingPrices?.[c]) && r.closingPrices[c] <= 1);
  if (!s.results.every(validResult)) return false;
  if (!s.events.every(e => Number.isInteger(e.id) && nonnegative(e.timeMs) && e.timeMs <= s.elapsedMs && typeof e.message === 'string')) return false;
  if (!s.trades.every(t => ids.has(t.traderId) && COLORS.includes(t.color) && ['buy', 'sell'].includes(t.side) && Number.isInteger(t.shares) && t.shares > 0 && nonnegative(t.timeMs) && t.timeMs <= s.elapsedMs && nonnegative(t.fee) && nonnegative(t.total))) return false;
  if (!['_rngState', '_noiseRngState', '_nextTickMs', '_nextEventId', '_nextTradeId'].every(k => Number.isInteger(s[k]) && s[k] >= 0)) return false;
  if (s._nextTickMs !== (s.block + 1) * 500) return false;
  if (s.phase === 'settled' && (!validResult(s.result) || s.result.round !== s.round || s.result.finalHeat !== s.heat)) return false;
  try {
    const prices = marketPrices(s), odds = scenarioOdds(s), stats = participantStats(s, 'player');
    return COLORS.every(c => finite(prices[c]) && finite(odds[c])) && finite(stats.equity);
  } catch { return false; }
}

try {
  const saved = JSON.parse(localStorage.getItem(KEY));
  if (validSaved(saved)) {
    state = saved.state;
    selectedColor = COLORS.includes(saved.form?.color) ? saved.form.color : 'red';
    selectedSide = saved.form?.side === 'sell' ? 'sell' : 'buy';
    if (typeof saved.form?.shares === 'string' && saved.form.shares.length <= 8) $('shares').value = saved.form.shares;
    $('notice').textContent = '已恢复本机 v2 进度；离开页面期间未继续模拟。';
  } else if (saved) $('notice').textContent = '旧进度或无效进度未恢复，已准备新的 v2 场次。';
} catch { /* Storage is optional; an unavailable or invalid save never blocks play. */ }

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify({ version: 2, state, form: { color: selectedColor, side: selectedSide, shares: $('shares').value } })); } catch { /* Private mode or full storage is fine. */ }
  lastPersistAt = performance.now();
}
function notify(message) { $('notice').textContent = message; }
function showError(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function profitText(id, value, digits = 2) { $(id).textContent = signed(value, digits); $(id).className = pnlClass(value); }
function clearKeys() { chartKey = botKey = tradeKey = resultKey = feedKey = ''; }

function flushTime() {
  const now = performance.now();
  const dt = Math.max(0, now - lastNow);
  lastNow = now;
  if (live(state) && !simulationFailed) state = advance(state, dt);
}

function drawChart(prices) {
  const svg = $('price-chart');
  const width = Math.max(230, svg.getBoundingClientRect().width || 650);
  const key = `${state.round}:${state.elapsedMs}:${state.history.length}:${width}`;
  if (key === chartKey) return;
  chartKey = key;
  const height = 210, left = 32, right = width - 10, top = 13, bottom = 178;
  const x = ms => left + ms / state.durationMs * (right - left);
  const y = p => top + (1 - p) * (bottom - top);
  const points = state.history.filter(p => p.prices && p.timeMs <= state.elapsedMs);
  if (!points.length) points.push({ timeMs: 0, prices });
  if (points.at(-1).timeMs !== state.elapsedMs) points.push({ timeMs: state.elapsedMs, prices });
  const sampleEvery = Math.max(1, Math.ceil(points.length / 600));
  const sampled = points.filter((_, i) => i % sampleEvery === 0 || i === points.length - 1);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('aria-label', `第 ${state.round} 轮份额价格，红 ${fmt(prices.red, 3)}、黑 ${fmt(prices.black, 3)}、绿 ${fmt(prices.green, 3)} 积分每份`);
  svg.innerHTML = `<title>本地模拟成交形成的价格，不是结果概率</title><rect x="${x(55000)}" y="${top}" width="${right - x(55000)}" height="${bottom - top}" fill="#ffb68e09"/>
    ${[0, 0.25, 0.5, 0.75, 1].map(p => `<line x1="${left}" x2="${right}" y1="${y(p)}" y2="${y(p)}" class="chart-grid"/><text x="0" y="${y(p) + 3}" class="chart-text">${p.toFixed(2)}</text>`).join('')}
    ${[0, 15000, 30000, 45000, 60000].map(ms => `<text x="${x(ms)}" y="203" text-anchor="${ms === 0 ? 'start' : ms === 60000 ? 'end' : 'middle'}" class="chart-text">${ms / 1000}s</text>`).join('')}
    ${COLORS.map(c => `<path d="${sampled.map((p, i) => `${i ? 'L' : 'M'}${x(p.timeMs).toFixed(2)},${y(p.prices[c]).toFixed(2)}`).join(' ')}" class="chart-line" style="stroke:${PAINT[c]}"/><circle cx="${x(state.elapsedMs)}" cy="${y(prices[c])}" r="3" style="fill:${PAINT[c]}"/>`).join('')}`;
}

function drawBots() {
  const key = JSON.stringify(state.participants);
  if (key === botKey) return;
  botKey = key;
  $('bot-summary').textContent = `${state.botCount} 位对手 · 无未来信息`;
  $('bots-body').innerHTML = state.participants.filter(p => p.id !== 'player').map(p => {
    const stats = participantStats(state, p.id);
    const position = COLORS.filter(c => p.holdings[c]).map(c => `${LABELS[c]} ${fmt(p.holdings[c], 0)} 份`).join(' / ') || '当前无持仓';
    return `<tr><td><span class="bot-name">${esc(p.name)}</span><span class="bot-position">${position}</span></td><td><span class="strategy-tag ${p.strategy === 'value' ? 'value' : ''}">${p.strategy === 'value' ? '价值' : '动量'}</span></td><td>${fmt(stats.tradeCount, 0)}</td><td>${fmt(stats.equity)}</td><td class="${pnlClass(stats.pnl)}">${signed(stats.pnl)}</td><td>${percent(stats.maxDrawdown)}</td><td>${p.tickets} / 3</td></tr>`;
  }).join('');
}

function drawTrades() {
  const key = `${state.round}:${state.tradeCount}:${state.trades.at(-1)?.id ?? 0}`;
  if (key === tradeKey) return;
  tradeKey = key;
  const trades = state.trades.slice(-9).reverse();
  $('trades-body').innerHTML = trades.length ? trades.map(t => {
    const participant = state.participants.find(p => p.id === t.traderId);
    return `<tr><td>${esc(participant?.name || t.traderId)}<small>${fmt(t.timeMs / 1000, 1)} 秒</small></td><td><span class="trade-side ${t.side}">${t.side === 'buy' ? '买' : '卖'}${LABELS[t.color]}</span></td><td>${fmt(t.shares, 0)}</td><td>${esc(moneyFmt(t.averagePrice, 4))}</td><td>${esc(moneyFmt(t.fee, 4))}</td><td>${t.side === 'buy' ? '−' : '+'}${esc(moneyFmt(t.total, 3))}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="empty-cell">开场后，这里记录每一笔实际成交。</td></tr>';
}

function drawResults() {
  const key = `${state.round}:${state.phase}:${state.results.length}`;
  if (key === resultKey) return;
  resultKey = key;
  $('record-count').textContent = `${state.results.length} 轮`;
  $('results-list').innerHTML = state.results.length ? state.results.slice(-5).reverse().map(r => `<div class="result-row"><span>#${String(r.round).padStart(2, '0')}</span><span class="color-tag ${r.color}"><i></i>${LABELS[r.color]}收盘 <small>${r.finalHeat}</small></span><b class="${pnlClass(r.profits.player)}">${signed(r.profits.player)}</b></div>`).join('') : '<p class="empty-message">第一轮，从你的判断开始。</p>';
  $('result').hidden = state.phase !== 'settled';
  if (state.phase === 'settled') {
    const r = state.result;
    $('result').className = `result-box outcome-${r.color}`;
    $('result').innerHTML = `<div class="result-heading"><span class="result-symbol">${r.color === 'red' ? '↗' : r.color === 'black' ? '↘' : '＝'}</span><strong>${LABELS[r.color]}盘命中 · 本轮已结算</strong></div><span class="result-profit ${pnlClass(r.profits.player)}">${signed(r.profits.player)} <small>积分</small></span><p>你的本轮净盈亏，已包含交易费用。持仓兑付 ${fmt(r.payouts.player)} 积分。</p><p>行动热度 ${r.actionHeat} ${r.noise >= 0 ? '+' : '−'} ${Math.abs(r.noise)} 模拟噪声 = 收盘 ${r.finalHeat}。份额已兑付并清零；下一轮保留余额。</p>`;
  }
}

function drawFeed() {
  const key = `${state.round}:${state.events.at(-1)?.id}`;
  if (key === feedKey) return;
  feedKey = key;
  $('feed').innerHTML = state.events.slice(-4).reverse().map(e => `<li><time>${fmt(e.timeMs / 1000, 1)}s</time><span>${esc(e.message)}</span></li>`).join('');
}

function renderQuote(prices) {
  const player = playerOf(state), quantity = Number($('shares').value);
  const buy = selectedSide === 'buy';
  const closed = state.phase === 'locked' || state.phase === 'settled';
  $('selected-chip').className = `color-tag ${selectedColor}`;
  $('selected-chip').innerHTML = `<i></i>${NAMES[selectedColor]}`;
  $('available').textContent = buy ? `可用 ${fmt(player.balance)} 积分` : `持有 ${fmt(player.holdings[selectedColor], 0)} 份`;
  $('quote-total-label').textContent = buy ? '预计支付（含费用）' : '预计到账（扣除费用）';
  setText('submit-label', state.phase === 'settled' ? '本轮已到期' : state.phase === 'locked' ? '已封盘，等待结算' : `${buy ? '买入' : '卖出'}${LABELS[selectedColor]}色份额`);
  setText('max-shares', buy ? '最多' : player.holdings[selectedColor] > 1000 ? '卖 1,000 份' : '卖出 100%');
  $('max-shares').disabled = closed || (!buy && player.holdings[selectedColor] < 1);
  $('shares').disabled = closed;
  document.querySelectorAll('[data-shares]').forEach(b => { const selected = Number(b.dataset.shares) === quantity; b.disabled = closed; b.classList.toggle('selected', selected); b.setAttribute('aria-pressed', String(selected)); });
  document.querySelectorAll('[data-side]').forEach(b => { b.classList.toggle('selected', b.dataset.side === selectedSide); b.setAttribute('aria-pressed', String(b.dataset.side === selectedSide)); });
  if (state.phase === 'settled') {
    ['quote-total', 'quote-average', 'quote-gross', 'quote-fee', 'quote-impact'].forEach(id => { $(id).textContent = '—'; });
    $('quote-spot').textContent = `${fmt(prices[selectedColor], 3)} / 份（到期兑付）`;
    $('win-preview').hidden = true;
    $('submit-trade').disabled = true;
    $('quote-note').textContent = '本轮份额已按结果兑付，卡片显示到期兑付价。下一轮重新从三色等价开始。';
    return;
  }
  let quote;
  try { quote = quoteTrade(state, 'player', selectedColor, selectedSide, quantity); }
  catch (error) {
    ['quote-total', 'quote-spot', 'quote-average', 'quote-gross', 'quote-fee', 'quote-impact'].forEach(id => { $(id).textContent = '—'; });
    $('win-preview').hidden = true;
    $('submit-trade').disabled = true;
    $('quote-note').textContent = error.reason || '请输入 1 至 1,000 的整数份数。';
    return;
  }
  const hasQuote = !(selectedSide === 'sell' && player.holdings[selectedColor] < quantity);
  $('quote-total').textContent = hasQuote ? moneyFmt(quote.total, 3) : '—';
  $('quote-spot').textContent = `${fmt(quote.spotPrice, 4)} / 份`;
  $('quote-average').textContent = hasQuote ? `${moneyFmt(quote.averagePrice, 4)} / 份` : '—';
  $('quote-gross').textContent = hasQuote ? moneyFmt(quote.gross, 4) : '—';
  $('quote-fee').textContent = hasQuote ? moneyFmt(quote.fee, 4) : '—';
  $('quote-impact').textContent = hasQuote ? `${signed((quote.pricesAfter[selectedColor] - quote.spotPrice) * 100, 2)} 个百分点` : '—';
  $('win-preview').hidden = !buy || closed;
  $('win-label').textContent = `若${LABELS[selectedColor]}盘命中，持有到结算`;
  $('quote-win-payout').textContent = `兑付 ${fmt(quote.winPayout, 0)} 积分`;
  profitText('quote-win-profit', quote.winProfit, 3);
  $('quote-roi').textContent = `本单命中净回报 ${signed(quote.roi * 100, 1)}%；未命中最多损失 ${moneyFmt(quote.total, 3)} 积分。此为条件收益，不是胜率。`;
  $('submit-trade').disabled = !quote.canExecute || simulationFailed;
  $('quote-note').textContent = quote.canExecute ? '报价随成交变化，点击时重新核算；你也可以盘中卖出，锁定实际盈亏。' : quote.reason || '当前不能成交。';
}

function render() {
  const player = playerOf(state), stats = participantStats(state, 'player');
  const prices = marketPrices(state), odds = scenarioOdds(state);
  const trading = state.phase === 'trading', settled = state.phase === 'settled';
  $('balance').textContent = fmt(player.balance);
  $('equity').textContent = fmt(stats.equity);
  $('total-pnl').textContent = `${signed(stats.pnl)} · 预计清仓口径`;
  $('total-pnl').className = pnlClass(stats.pnl);
  $('reserve').textContent = fmt(state.market.cash);
  $('trade-count').textContent = fmt(state.tradeCount, 0);
  const lastSecond = state.trades.filter(t => t.timeMs > state.elapsedMs - 1000 && t.timeMs <= state.elapsedMs).length;
  $('trade-rate').textContent = `${live(state) ? lastSecond : 0} 笔 / 近 1 秒`;
  $('round-label').textContent = `第 ${String(state.round).padStart(2, '0')} 轮 / 模拟区块 ${String(state.block).padStart(3, '0')}`;
  $('phase').textContent = { ready: '准备开场', trading: '自由交易中', locked: '已封盘 · 等待结果', settled: '本轮已到期' }[state.phase];
  $('phase').className = `phase-pill ${state.phase}`;
  $('time').textContent = fmt(state.remainingMs / 1000, 1);
  $('window-label').textContent = trading ? `距封盘 ${fmt(Math.max(0, 55000 - state.elapsedMs) / 1000, 1)} 秒` : state.phase === 'locked' ? '买卖与行动均已停止' : '55 秒交易 + 5 秒封盘';
  $('round-action').disabled = live(state) || simulationFailed;
  setText('round-action-label', state.phase === 'ready' ? '开始 60 秒交易' : settled ? '继续下一轮' : state.phase === 'locked' ? '等待到期结算' : '交易进行中');
  $('time-bar').style.width = `${100 * state.remainingMs / state.durationMs}%`;
  $('timer').setAttribute('aria-valuenow', fmt(state.remainingMs / 1000, 1));
  $('timer').classList.toggle('urgent', state.phase === 'locked');
  $('countdown-dial').style.setProperty('--remaining', `${100 * state.remainingMs / state.durationMs}%`);
  $('countdown-dial').classList.toggle('urgent', state.phase === 'locked');
  $('chart-prompt').hidden = state.phase !== 'ready';
  $('scenario-note').textContent = settled ? '结果已确认：三色卡片现在显示到期兑付价与命中结果；封盘前价格保留在曲线上。' : '场景概率假设后续无人再用行动券，只计算结算噪声；它不同于交易价格，也不代表最终胜率。噪声仅为本地模拟随机。';
  document.querySelectorAll('.scenario-label').forEach(node => { node.textContent = settled ? '本轮到期结果' : '当前热度场景概率'; });
  document.querySelectorAll('[data-bots]').forEach(b => { b.disabled = live(state); b.classList.toggle('selected', Number(b.dataset.bots) === state.botCount); b.setAttribute('aria-pressed', String(Number(b.dataset.bots) === state.botCount)); });
  document.querySelectorAll('[data-color]').forEach(b => { b.classList.toggle('selected', b.dataset.color === selectedColor); b.setAttribute('aria-pressed', String(b.dataset.color === selectedColor)); });
  document.querySelectorAll('.price-unit').forEach(node => { node.textContent = settled ? '到期兑付价 · 积分 / 份' : '市场价格 · 积分 / 份'; });
  for (const color of COLORS) {
    $(`price-${color}`).textContent = fmt(prices[color], 3);
    $(`odds-${color}`).textContent = settled ? (state.result.color === color ? '已命中' : '未命中') : percent(odds[color]);
    const holdings = player.holdings[color], basis = player.costBasis[color];
    $(`holding-${color}`).textContent = fmt(holdings, 0);
    $(`basis-${color}`).textContent = holdings ? fmt(basis / holdings, 4) : '—';
    $(`value-${color}`).textContent = fmt(holdings * prices[color]);
    profitText(`pnl-${color}`, holdings * prices[color] - basis);
    $(`sell-${color}`).disabled = !trading || holdings < 1;
  }
  profitText('realized-pnl', stats.realizedPnl);
  profitText('unrealized-pnl', stats.unrealizedPnl);
  $('position-value').textContent = fmt(stats.positionValue);
  $('sell-all').disabled = !trading || !COLORS.some(c => player.holdings[c] > 0);
  $('heat').textContent = state.heat;
  $('noise-label').textContent = settled ? `本轮模拟噪声 ${signed(state.result.noise, 0)}` : `结算噪声 ±${state.noiseRange} · 本地模拟`;
  $('tickets').textContent = `你的行动券 ${player.tickets} / 3 · 可保留不用`;
  $('ticket-dots').querySelectorAll('i').forEach((dot, index) => { dot.classList.toggle('used', index >= player.tickets); });
  $('heat-up').disabled = $('heat-down').disabled = !trading || player.tickets <= 0;
  $('phase-note').textContent = { ready: '先开始一轮。前 55 秒可反复买卖及使用行动券，最后 5 秒等待结算。', trading: '动作不扣积分，只消耗行动券。Bot 也能行动；剩余噪声使单靠用券无法保证结果。', locked: '最后 5 秒：不能下单、卖出或控场。既有份额将在 60 秒时按模拟结果兑付。', settled: '到期兑付已入账。下轮保留余额与累计统计，热度和市场报价重新开始。' }[state.phase];
  renderQuote(prices); drawChart(prices); drawBots(); drawTrades(); drawResults(); drawFeed();
  if (lastPhase !== state.phase) {
    if (state.phase === 'locked') notify('已进入最后 5 秒封盘：买卖及行动停止，等待结算。');
    if (settled) notify(`第 ${state.round} 轮${LABELS[state.result.color]}盘命中，你的本轮净盈亏 ${signed(state.result.profits.player)} 积分。`);
    lastPhase = state.phase;
    persist();
  }
}

function runOperation(operation) {
  try { flushTime(); operation(); showError(); lastNow = performance.now(); persist(); render(); }
  catch (error) { showError(error.reason || error.message || '操作未成功，请查看当前阶段与账户余额。'); render(); }
}

document.querySelectorAll('[data-color]').forEach(b => b.addEventListener('click', () => runOperation(() => { selectedColor = b.dataset.color; })));
document.querySelectorAll('[data-side]').forEach(b => b.addEventListener('click', () => runOperation(() => { selectedSide = b.dataset.side; })));
document.querySelectorAll('[data-shares]').forEach(b => b.addEventListener('click', () => runOperation(() => { $('shares').value = b.dataset.shares; })));
$('shares').addEventListener('input', () => runOperation(() => {}));
$('shares').addEventListener('keydown', e => { if (e.key === 'Enter' && !$('submit-trade').disabled) $('submit-trade').click(); });

$('max-shares').addEventListener('click', () => runOperation(() => {
  if (selectedSide === 'sell') {
    const owned = playerOf(state).holdings[selectedColor];
    if (!owned) throw new Error('当前没有该色持仓可以卖出。');
    $('shares').value = String(Math.min(1000, owned));
    if (owned > 1000) notify('单笔最多 1,000 份；要一次清掉全部，请使用持仓行的“全部卖出”。');
  } else {
    // Ready quotes are previews; temporarily adjust only the phase for checking
    // affordability. No state changes or random draws occur while quoting.
    const preview = state.phase === 'ready' ? { ...state, phase: 'trading' } : state;
    let low = 0, high = 1000;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (quoteTrade(preview, 'player', selectedColor, 'buy', mid).canExecute) low = mid;
      else high = mid - 1;
    }
    if (!low) throw new Error('积分或做市储备不足，当前不能买入一份。');
    $('shares').value = String(low);
  }
}));

$('submit-trade').addEventListener('click', () => runOperation(() => {
  const quantity = Number($('shares').value);
  const before = state.tradeCount;
  state = executeTrade(state, 'player', selectedColor, selectedSide, quantity);
  if (state.tradeCount > before) {
    const trade = state.trades.at(-1);
    notify(`已${selectedSide === 'buy' ? '买入' : '卖出'}${LABELS[selectedColor]}色 ${fmt(quantity, 0)} 份，${selectedSide === 'buy' ? '支付' : '到账'} ${fmt(trade.total, 4)} 积分（费用 ${fmt(trade.fee, 4)}）。`);
  }
}));

function sellColors(colors) {
  runOperation(() => {
    let next = state, sold = 0, proceeds = 0, count = 0;
    // Build an immutable batch first: if any leg fails, none of this batch is
    // assigned to state. Each actual engine fill still appears in the ledger.
    for (const color of colors) {
      while (playerOf(next).holdings[color] > 0) {
        const quantity = Math.min(1000, playerOf(next).holdings[color]);
        next = executeTrade(next, 'player', color, 'sell', quantity);
        sold += quantity;
        proceeds += next.trades.at(-1).total;
        count += 1;
      }
    }
    if (!sold) throw new Error('当前没有可卖出的持仓。');
    state = next;
    notify(`已卖出 ${fmt(sold, 0)} 份持仓，分 ${count} 笔成交，扣费后到账 ${fmt(proceeds, 4)} 积分。`);
  });
}
document.querySelectorAll('[data-sell]').forEach(b => b.addEventListener('click', () => sellColors([b.dataset.sell])));
$('sell-all').addEventListener('click', () => sellColors(COLORS));
$('heat-up').addEventListener('click', () => runOperation(() => { state = playerAction(state, 1); notify(`已加热 +1，热度 ${state.heat}；剩余 ${playerOf(state).tickets} 张行动券。`); }));
$('heat-down').addEventListener('click', () => runOperation(() => { state = playerAction(state, -1); notify(`已降温 −1，热度 ${state.heat}；剩余 ${playerOf(state).tickets} 张行动券。`); }));
$('round-action').addEventListener('click', () => runOperation(() => {
  if (state.phase === 'ready') { state = startRound(state); notify('本轮开始：55 秒内可持续买卖，最后 5 秒封盘。'); }
  else if (state.phase === 'settled') { state = nextRound(state); clearKeys(); notify('已准备下一轮，余额与累计统计保留。点击开始，开启新的 60 秒。'); }
}));
$('rules-link').addEventListener('click', () => { $('rules').open = true; });

function freshGame(botCount = state.botCount) {
  flushTime();
  state = resetGame(freshSeed(), { botCount });
  simulationFailed = false;
  selectedColor = 'red'; selectedSide = 'buy'; $('shares').value = '50';
  lastNow = performance.now(); lastPhase = ''; clearKeys(); showError();
  persist(); render(); notify(`新场次已准备：你与 ${botCount} 位 Bot 各有 1,000 积分，做市账户有 1,000 积分。`);
}
$('reset').addEventListener('click', () => { try { freshGame(); } catch (error) { showError(error.reason || error.message); } });
document.querySelectorAll('[data-bots]').forEach(b => b.addEventListener('click', () => {
  if (live(state) || Number(b.dataset.bots) === state.botCount) return;
  freshGame(Number(b.dataset.bots));
}));
window.addEventListener('resize', () => { chartKey = ''; drawChart(marketPrices(state)); });
window.addEventListener('pagehide', () => { try { flushTime(); persist(); } catch { /* Optional save. */ } });
setInterval(() => {
  try {
    const running = live(state);
    flushTime();
    if (running) render();
    if (running && performance.now() - lastPersistAt > 1000) persist();
  }
  catch (error) { simulationFailed = true; showError(`本地进度无法继续：${error.reason || error.message}。请用右上角“重置积分”重新开始。`); }
}, 100);
render();
mountMonad();
