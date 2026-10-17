import { createGame, resetGame, startRound, advance, executeTrade, nextRound, quoteTrade, quoteBudget, marketPrices, scenarioOdds, participantStats, configureAutomation, configurePriceEvent, observePriceEvent } from './game.js';
import { mountMonad } from './monad-ui.js';
import { mountMarket } from './monad-market-ui.js';
import { mountTheme } from './theme.js';
import { drawPriceChart } from './chart.js';
import { renderEventPanel } from './event-ui.js';
import { preparePriceEvent, pollPriceEvent } from './price-source.js';

const $ = id => document.getElementById(id);
const setText = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
const KEY = 'blockpulse-playground-v4';
const COLORS = ['red', 'black', 'green'];
const LABELS = { red: '红', black: '黑', green: '绿' };
const NAMES = { red: '红 · 上行', black: '黑 · 下行', green: '绿 · 区间' };
const MAX_SAVED_SHARES = 100000;
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
let amountMode = 'budget';
let compareKey = '';
let lastNow = performance.now();
let lastPhase = '';
let lastPersistAt = 0;
let chartKey = '', botKey = '', tradeKey = '', resultKey = '', feedKey = '';
let simulationFailed = false;
let selectedEventMode = 'local';
let sourceStatus = { status: 'idle', error: '', observation: null };
let eventGeneration = 0, eventController = null, pollInFlight = false, pollPromise = null, lastPollAt = 0;
const priceMode = () => selectedEventMode === 'price';

// v4 saves offline practice only. Price sessions depend on external time and data,
// so they live only in memory and are never replayed after a page refresh.
function validSaved(saved) {
  const s = saved?.state;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const nonnegative = value => finite(value) && value >= 0;
  const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
  const position = (value, { shares = false, maxShares = MAX_SAVED_SHARES } = {}) => value && COLORS.every(color => shares
    ? integer(value[color], maxShares)
    : nonnegative(value[color]) && value[color] <= s.initialTotal);
  try {
    if (saved?.version !== 4 || s?.schemaVersion !== 4 || s.mode !== 'local'
      || !['ready', 'trading', 'locked', 'settled'].includes(s.phase)
      || ![2, 20].includes(s.botCount) || !integer(s.round, 1000000) || s.round < 1 || !Array.isArray(s.participants)
      || s.participants.length !== s.botCount + 1) return false;
    const total = (s.botCount + 1) * 1000 + 1000;
    if (s.initialTotal !== total || s.durationMs !== 60000 || s.tradingDurationMs !== 55000
      || !finite(s.elapsedMs) || s.elapsedMs < 0 || s.elapsedMs > 60000
      || !finite(s.remainingMs) || s.remainingMs < 0 || s.remainingMs > 60000
      || Math.abs(s.elapsedMs + s.remainingMs - 60000) > 0.001
      || !integer(s.block, 120) || s.block !== Math.floor(s.elapsedMs / 500)) return false;
    if ((s.phase === 'ready' && s.elapsedMs !== 0)
      || (s.phase === 'trading' && s.elapsedMs >= s.tradingDurationMs)
      || (s.phase === 'locked' && s.elapsedMs >= s.durationMs
        || s.phase === 'locked' && s.elapsedMs < s.tradingDurationMs && !COLORS.includes(s.event?.certainColor))
      || (s.phase === 'settled' && s.elapsedMs !== s.durationMs)) return false;
    const event = s.event;
    const reference = 100000000;
    if (!event || event.mode !== 'simulation' || event.title !== '独立模拟 SOL/USD 价格'
      || event.source !== '本地独立模拟' || event.product !== 'SOL-USD'
      || event.startTimeMs !== 0 || event.referenceTimeMs !== 0 || event.cutoffTimeMs !== 55000 || event.targetTimeMs !== 60000
      || event.referenceMicros !== reference || event.lowerMicros !== 99980000 || event.upperMicros !== 100020000
      || event.bandBps !== 2 || event.settlementDelayMs !== 0
      || !integer(event.priceMicros, reference + 120 * 20000) || event.priceMicros < reference - 120 * 20000
      || !finite(event.priceTimeMs) || event.priceTimeMs < 0 || event.priceTimeMs > s.elapsedMs
      || !finite(event.serverTimeMs) || event.serverTimeMs < 0
      || !['simulation', 'locked', 'settled'].includes(event.status) || (event.certainColor != null && !COLORS.includes(event.certainColor))
      || !Array.isArray(event.series) || event.series.length > 700
      || !event.series.every(point => point && finite(point.timeMs) && point.timeMs >= 0 && point.timeMs <= s.elapsedMs
        && integer(point.priceMicros, reference + 120 * 20000) && point.priceMicros >= reference - 120 * 20000)) return false;
    const market = s.market;
    if (!market || !nonnegative(market.cash) || market.cash > total || market.initialReserve !== 1000
      || !finite(market.b) || market.b <= 0 || market.b > 150 || market.feeRate !== 0.003
      || !position(market.q, { shares: true, maxShares: (s.botCount + 1) * MAX_SAVED_SHARES }) || !market.priors
      || market.priors.red !== 0.45 || market.priors.black !== 0.45 || market.priors.green !== 0.10) return false;
    const ids = new Set();
    let balances = market.cash;
    for (const trader of s.participants) {
      if (!trader || typeof trader.id !== 'string' || ids.has(trader.id) || typeof trader.name !== 'string'
        || !['player', 'momentum', 'value'].includes(trader.strategy)
        || !nonnegative(trader.balance) || trader.balance > total
        || !position(trader.holdings, { shares: true }) || !position(trader.costBasis)
        || !finite(trader.realizedPnl) || Math.abs(trader.realizedPnl) > total * 10000
        || !nonnegative(trader.peakEquity) || trader.peakEquity > total * 2
        || !finite(trader.maxDrawdown) || trader.maxDrawdown < 0 || trader.maxDrawdown > 1
        || !integer(trader.tradeCount, 100000)) return false;
      ids.add(trader.id); balances += trader.balance;
    }
    if (!ids.has('player') || playerOf(s)?.strategy !== 'player' || Math.abs(balances - total) > 0.001
      || !s._roundStartBalances || Object.keys(s._roundStartBalances).length !== ids.size
      || ![...ids].every(id => nonnegative(s._roundStartBalances[id]) && s._roundStartBalances[id] <= total)) return false;
    for (const color of COLORS) {
      const held = s.participants.reduce((sum, trader) => sum + trader.holdings[color], 0);
      if (held !== market.q[color]) return false;
    }
    const automation = s.automation;
    if (!automation || typeof automation.enabled !== 'boolean' || !['value', 'momentum'].includes(automation.strategy)
      || !Number.isInteger(automation.orderShares) || automation.orderShares < 1 || automation.orderShares > 50
      || !Number.isInteger(automation.maxPosition) || automation.maxPosition < 10 || automation.maxPosition > 500
      || !finite(automation.edge) || automation.edge < 0.01 || automation.edge > 0.2
      || !integer(automation.tradeCount, 100000) || !Array.isArray(automation.decisions) || automation.decisions.length > 400
      || !automation.decisions.every(item => item && finite(item.timeMs) && item.timeMs >= 0 && item.timeMs <= s.elapsedMs
        && typeof item.action === 'string' && typeof item.reason === 'string')
      || (automation.enabled && s.phase !== 'trading')) return false;
    if (!['_rngState', '_noiseRngState', '_eventRngState'].every(key => integer(s[key], 0xffffffff))
      || !integer(s._nextEventId) || s._nextEventId < 1 || !integer(s._nextTradeId) || s._nextTradeId < 1
      || !integer(s._nextTickMs, 60500) || s._nextTickMs <= s.elapsedMs
      || s._nextTickMs !== Math.floor(s.elapsedMs / 500) * 500 + 500
      || !integer(s._nextAutomationMs, 61000) || s._nextAutomationMs <= s.elapsedMs
      || s._nextAutomationMs !== Math.floor(s.elapsedMs / 1000) * 1000 + 1000) return false;
    if (!Array.isArray(s.history) || !s.history.length || s.history.length > 700
      || !s.history.every(point => point && nonnegative(point.timeMs) && point.timeMs <= s.elapsedMs
        && finite(point.heat) && COLORS.every(color => nonnegative(point.prices?.[color]) && point.prices[color] <= 1))) return false;
    if (!Array.isArray(s.events) || s.events.length > 400 || !Array.isArray(s.trades) || s.trades.length > 400
      || !Array.isArray(s.results) || s.results.length > 400 || !integer(s.tradeCount, 100000)) return false;
    if (!s.events.every(item => item && integer(item.id) && nonnegative(item.timeMs) && item.timeMs <= s.elapsedMs && typeof item.message === 'string')) return false;
    if (!s.trades.every(item => item && ids.has(item.traderId) && COLORS.includes(item.color) && ['buy', 'sell'].includes(item.side)
      && integer(item.shares, 1000) && item.shares > 0 && nonnegative(item.timeMs) && item.timeMs <= s.elapsedMs
      && nonnegative(item.fee) && nonnegative(item.total))) return false;
    const validResult = result => result && integer(result.round) && result.round > 0 && result.round <= s.round
      && COLORS.includes(result.color) && Number.isSafeInteger(result.eventPriceMicros)
      && result.eventPriceMicros >= reference - 120 * 20000 && result.eventPriceMicros <= reference + 120 * 20000
      && result.eventReferenceMicros === reference && result.eventLowerMicros === 99980000 && result.eventUpperMicros === 100020000
      && result.eventMode === 'simulation' && result.eventSource === '本地独立模拟'
      && finite(result.totalPayout) && result.totalPayout >= 0 && integer(result.tradeCount, 100000)
      && result.profits && ids.size === Object.keys(result.profits).length && [...ids].every(id => finite(result.profits[id]))
      && result.payouts && ids.size === Object.keys(result.payouts).length && [...ids].every(id => nonnegative(result.payouts[id]))
      && result.supportCounts && COLORS.every(color => integer(result.supportCounts[color], s.participants.length))
      && Array.isArray(result.ranking) && result.ranking.length === s.participants.length
      && result.ranking.every(item => item && ids.has(item.id) && typeof item.name === 'string'
        && finite(item.profit) && integer(item.rank, s.participants.length) && item.rank > 0)
      && result.closingPrices && COLORS.every(color => finite(result.closingPrices[color]) && result.closingPrices[color] >= 0 && result.closingPrices[color] <= 1);
    if (!s.results.every(validResult)) return false;
    if (s.phase === 'settled' && (!validResult(s.result) || s.result.round !== s.round)) return false;
    const prices = marketPrices(s), stats = participantStats(s, 'player');
    return COLORS.every(color => finite(prices[color])) && finite(stats.equity);
  } catch { return false; }
}

try {
  const saved = JSON.parse(localStorage.getItem(KEY));
  if (validSaved(saved)) {
    state = saved.state;
    selectedColor = COLORS.includes(saved.form?.color) ? saved.form.color : 'red';
    selectedSide = ['buy', 'sell', 'short', 'cover'].includes(saved.form?.side) ? saved.form.side : 'buy';
    amountMode = ['sell', 'cover'].includes(selectedSide) ? 'shares' : saved.form?.mode === 'shares' ? 'shares' : 'budget';
    if (typeof saved.form?.shares === 'string' && saved.form.shares.length <= 8) $('shares').value = saved.form.shares;
    if (typeof saved.form?.budget === 'string' && saved.form.budget.length <= 8) $('budget').value = saved.form.budget;
    $('notice').textContent = '已恢复本机 v4 离线练习；离开页面期间未继续模拟。';
  } else if (saved?.version === 3 || saved?.state?.schemaVersion === 3 || localStorage.getItem('blockpulse-playground-v3')) {
    $('notice').textContent = 'v3 旧存档已明确拒绝恢复；已准备新的 v4 离线练习。';
  } else if (saved) $('notice').textContent = 'v4 存档不完整或数值校验失败；已准备新的安全离线练习。';
} catch { $('notice').textContent = '存档无法读取或格式损坏；已准备新的安全离线练习。'; }

function persist() {
  if (selectedEventMode !== 'local' || state.mode !== 'local') return;
  try { localStorage.setItem(KEY, JSON.stringify({ version: 4, state, form: { color: selectedColor, side: selectedSide, shares: $('shares').value, budget: $('budget').value, mode: amountMode } })); } catch { /* Private mode or full storage is fine. */ }
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
  drawPriceChart(svg, {
    durationMs: state.durationMs, lockMs: state.tradingDurationMs, points: state.history, elapsedMs: state.elapsedMs, prices,
    label: `第 ${state.round} 轮份额价格，红 ${fmt(prices.red, 3)}、黑 ${fmt(prices.black, 3)}、绿 ${fmt(prices.green, 3)} 积分每份`,
    title: '模拟成交形成的份额价格；独立 SOL/USD 事件结果不受成交影响',
  });
}

function drawBots() {
  const key = JSON.stringify(state.participants);
  if (key === botKey) return;
  botKey = key;
  $('bot-summary').textContent = priceMode() ? `${state.botCount} 位 Bot · 真实事件暂时观望` : `${state.botCount} 位对手 · 无未来信息`;
  $('bots-body').innerHTML = state.participants.filter(p => p.id !== 'player').map(p => {
    const stats = participantStats(state, p.id);
    const position = COLORS.filter(c => p.holdings[c]).map(c => `${LABELS[c]} ${fmt(p.holdings[c], 0)} 份`).join(' / ') || '当前无持仓';
    return `<tr><td><span class="bot-name">${esc(p.name)}</span><span class="bot-position">${position}</span></td><td><span class="strategy-tag ${p.strategy === 'value' ? 'value' : ''}">${p.strategy === 'value' ? '价值' : '动量'}</span></td><td>${fmt(stats.tradeCount, 0)}</td><td>${fmt(stats.equity)}</td><td class="${pnlClass(stats.pnl)}">${signed(stats.pnl)}</td><td>${percent(stats.maxDrawdown)}</td></tr>`;
  }).join('');
}

function drawTrades() {
  const key = `${state.round}:${state.tradeCount}:${state.trades.at(-1)?.id ?? 0}`;
  if (key === tradeKey) return;
  tradeKey = key;
  const trades = state.trades.slice(-9).reverse();
  $('trades-body').innerHTML = trades.length ? trades.map(t => {
    const participant = state.participants.find(p => p.id === t.traderId);
    return `<tr><td>${esc(participant?.name || t.traderId)}<small>${fmt(t.timeMs / 1000, 1)} 秒</small></td><td><span class="trade-side ${t.side}">${t.source === 'strategy' ? '策略 · ' : ''}${t.comboSide === 'short' ? '开 NO' : t.comboSide === 'cover' ? '平 NO' : t.side === 'buy' ? '买' : '卖'}${t.comboSide ? ` · ${LABELS[t.color]}` : LABELS[t.color]}</span></td><td>${fmt(t.shares, 0)}</td><td>${esc(moneyFmt(t.averagePrice, 4))}</td><td>${esc(moneyFmt(t.fee, 4))}</td><td>${t.side === 'buy' ? '−' : '+'}${esc(moneyFmt(t.total, 3))}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="empty-cell">开场后，这里记录每一笔实际成交。</td></tr>';
}

function drawResults() {
  const key = `${state.round}:${state.phase}:${state.results.length}`;
  if (key === resultKey) return;
  resultKey = key;
  $('record-count').textContent = `${state.results.length} 轮`;
  $('results-list').innerHTML = state.results.length ? state.results.slice(-5).reverse().map(r => {
    const detail = Number.isSafeInteger(r.eventPriceMicros) ? `$${fmt(r.eventPriceMicros / 1e6, 2)}` : Number.isSafeInteger(r.eventValue) ? `${r.eventValue}` : '—';
    return `<div class="result-row"><span>#${String(r.round).padStart(2, '0')}</span><span class="color-tag ${r.color}"><i></i>${LABELS[r.color]}盘 <small>${detail}</small></span><b class="${pnlClass(r.profits.player)}">${signed(r.profits.player)}</b></div>`;
  }).join('') : '<p class="empty-message">第一轮，从你的判断开始。</p>';
  $('result').hidden = state.phase !== 'settled';
  if (state.phase === 'settled' && state.result.voided) {
    const r = state.result;
    $('result').className = 'result-box';
    $('result').innerHTML = `<div class="result-heading"><span class="result-symbol">∅</span><strong>本轮作废 · 成本已退回</strong></div><span class="result-profit ${pnlClass(r.profits.player)}">${signed(r.profits.player)} <small>积分</small></span><p>${esc(r.reason)}。未平仓份额按含费成本退回，已平仓交易的损益保留；本轮不计入收盘记录。</p>`;
  } else if (state.phase === 'settled') {
    const r = state.result;
    $('result').className = `result-box outcome-${r.color}`;
    const priceSummary = Number.isSafeInteger(r.eventPriceMicros) && r.eventSource === 'Coinbase Exchange SOL-USD' ? `独立事件收盘价 $${fmt(r.eventPriceMicros / 1e6, 2)}；参考价 $${fmt((r.eventReferenceMicros || 0) / 1e6, 2)}，绿区间 $${fmt((r.eventLowerMicros || 0) / 1e6, 2)}–$${fmt((r.eventUpperMicros || 0) / 1e6, 2)}。来源：${r.eventSource}。` : '';
    const localSummary = Number.isSafeInteger(r.eventPriceMicros) ? `本地独立模拟收盘价 $${fmt(r.eventPriceMicros / 1e6, 2)}，参考价 $${fmt((r.eventReferenceMicros || 0) / 1e6, 2)}；与本轮交易无关。` : '';
    let lastProfit, lastRank = 0;
    const ranking = r.ranking || Object.entries(r.profits || {}).map(([id, profit]) => ({ id, name: state.participants.find(p => p.id === id)?.name || id, profit }))
      .sort((a, b) => b.profit - a.profit).map((entry, index) => { if (index === 0 || entry.profit !== lastProfit) lastRank = index + 1; lastProfit = entry.profit; return { ...entry, rank: lastRank }; });
    const rankingRows = ranking.map(item => `<li><span>#${item.rank} ${esc(item.name)}</span><b class="${pnlClass(item.profit)}">${signed(item.profit)}</b></li>`).join('');
    const eventSummary = priceSummary || localSummary;
    const supporters = r.supportCounts ? `持有者账户数（红 ${r.supportCounts.red} · 黑 ${r.supportCounts.black} · 绿 ${r.supportCounts.green}）` : '';
    $('result').innerHTML = `<div class="result-heading"><span class="result-symbol">${r.color === 'red' ? '↗' : r.color === 'black' ? '↘' : '＝'}</span><strong>${LABELS[r.color]}盘命中 · 本轮已结算</strong></div><span class="result-profit ${pnlClass(r.profits.player)}">${signed(r.profits.player)} <small>积分</small></span><p>你的本轮净盈亏，已包含交易费用。持仓兑付 ${fmt(r.payouts.player)} 积分。</p>${eventSummary ? `<p id="event-result-summary">${esc(eventSummary)}</p>` : ''}${supporters ? `<p>${esc(supporters)}</p>` : ''}<div class="result-ranking"><strong>本轮收益排名</strong><ol id="ranking-list">${rankingRows}</ol></div>`;
  }
}

function drawFeed() {
  const key = `${state.round}:${state.events.at(-1)?.id}`;
  if (key === feedKey) return;
  feedKey = key;
  $('feed').innerHTML = state.events.slice(-4).reverse().map(e => `<li><time>${fmt(e.timeMs / 1000, 1)}s</time><span>${esc(e.message)}</span></li>`).join('');
}

function renderQuote(prices) {
  const player = playerOf(state);
  const opening = selectedSide === 'buy' || selectedSide === 'short';
  const buying = selectedSide === 'buy';
  const noSide = selectedSide === 'short' || selectedSide === 'cover';
  const closeSide = selectedSide === 'sell' || selectedSide === 'cover';
  const closed = state.phase === 'locked' || state.phase === 'settled';
  const useBudget = amountMode === 'budget' && opening;
  const amount = Number(useBudget ? $('budget').value : $('shares').value);
  const effectiveBudget = useBudget ? Math.min(amount, player.balance) : amount;
  $('selected-chip').className = `color-tag ${selectedColor}`;
  $('selected-chip').innerHTML = `<i></i>${NAMES[selectedColor]}${noSide ? ' · NO' : ''}`;
  $('budget-row').hidden = !useBudget;
  $('shares-row').hidden = useBudget;
  $('budget-mode').classList.toggle('selected', amountMode === 'budget');
  $('shares-mode').classList.toggle('selected', amountMode === 'shares');
  $('budget-mode').setAttribute('aria-pressed', String(amountMode === 'budget'));
  $('shares-mode').setAttribute('aria-pressed', String(amountMode === 'shares'));
  $('budget-mode').disabled = closeSide;
  const noLegs = COLORS.filter(color => color !== selectedColor);
  $('short-explainer').textContent = selectedSide === 'cover'
    ? `平仓将卖出 ${noLegs.map(color => LABELS[color]).join(' + ')} 两条 NO 持仓；没有杠杆或自动借币。`
    : '做空所选颜色会全额买入等份的另外两色作为 NO 组合；无借贷、杠杆或强平。平 NO 会卖出这两种实际持仓。';
  $('available').textContent = opening ? `可用 ${fmt(player.balance)} 积分` : selectedSide === 'cover'
    ? `NO 可平 ${fmt(Math.min(...COLORS.filter(c => c !== selectedColor).map(c => player.holdings[c])), 0)} 份`
    : `持有 ${fmt(player.holdings[selectedColor], 0)} 份`;
  $('quote-total-label').textContent = opening ? '预计支付（含费用）' : '预计到账（扣除费用）';
  const actionName = { buy: '买入 YES', sell: '卖出', short: '买入 NO', cover: '平 NO' }[selectedSide];
  setText('submit-label', state.phase === 'settled' ? '本轮已到期' : state.phase === 'locked' ? '已封盘，等待结算' : `${actionName} · ${LABELS[selectedColor]}`);
  $('max-shares').textContent = selectedSide === 'cover' ? '全部平 NO' : opening ? '最多' : '卖出全部';
  const held = selectedSide === 'cover' ? Math.min(...COLORS.filter(c => c !== selectedColor).map(c => player.holdings[c])) : player.holdings[selectedColor];
  $('max-shares').disabled = closed || (closeSide && held < 1);
  $('budget').disabled = closed || !opening;
  $('shares').disabled = closed;
  document.querySelectorAll('#game [data-budget]').forEach(button => { const selected = Number(button.dataset.budget) === amount; button.disabled = closed; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
  document.querySelectorAll('#game [data-shares]').forEach(button => { const selected = Number(button.dataset.shares) === amount; button.disabled = closed; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
  document.querySelectorAll('#game [data-side]').forEach(button => { button.classList.toggle('selected', button.dataset.side === selectedSide); button.setAttribute('aria-pressed', String(button.dataset.side === selectedSide)); });
  if (state.phase === 'settled') {
    ['quote-total', 'quote-average', 'quote-gross', 'quote-fee', 'quote-impact', 'quote-shares', 'quote-unused'].forEach(id => { $(id).textContent = '—'; });
    $('quote-spot').textContent = `${fmt(prices[selectedColor], 3)} / 份（到期兑付）`;
    $('win-preview').hidden = true;
    $('submit-trade').disabled = true;
    $('quote-note').textContent = state.result.voided ? '本轮已作废，份额按成本退回。下一轮重新读取基准。'
      : priceMode() ? '本轮已按独立价格事件结算；下一轮需重新读取并冻结新的 Coinbase 参考价。'
      : '本轮份额已按结果兑付，卡片显示到期兑付价。下一轮重新开始。';
    return;
  }
  let quote;
  try {
    quote = useBudget
      ? quoteBudget(state, 'player', selectedColor, effectiveBudget, selectedSide)
      : quoteTrade(state, 'player', selectedColor, selectedSide, amount);
  } catch (error) {
    ['quote-total', 'quote-spot', 'quote-average', 'quote-gross', 'quote-fee', 'quote-impact', 'quote-shares', 'quote-unused'].forEach(id => { $(id).textContent = '—'; });
    $('win-preview').hidden = true;
    $('submit-trade').disabled = true;
    $('quote-note').textContent = error.reason || error.message || '请检查预算或份数。';
    return;
  }
  const count = quote.shares;
  const validQuote = Number.isInteger(count) && count > 0 && !(closeSide && quote.code === 'INSUFFICIENT_HOLDINGS');
  $('quote-shares').textContent = validQuote ? `${fmt(count, 0)} 份` : '—';
  $('quote-unused').textContent = useBudget && validQuote ? `${moneyFmt(Math.max(0, effectiveBudget - quote.total), 3)} 分${amount > player.balance ? `（余额上限 ${fmt(player.balance)}）` : ''}` : '—';
  $('quote-total').textContent = validQuote ? moneyFmt(quote.total, 3) : '—';
  $('quote-spot').textContent = `${fmt(quote.spotPrice, 4)} / 份`;
  $('quote-average').textContent = validQuote ? `${moneyFmt(quote.averagePrice, 4)} / 份` : '—';
  $('quote-gross').textContent = validQuote ? moneyFmt(quote.gross, 4) : '—';
  $('quote-fee').textContent = validQuote ? moneyFmt(quote.fee, 4) : '—';
  const currentImpactSpot = selectedSide === 'short' || selectedSide === 'cover' ? 1 - prices[selectedColor] : prices[selectedColor];
  const nextImpactSpot = selectedSide === 'short' || selectedSide === 'cover' ? 1 - quote.pricesAfter[selectedColor] : quote.pricesAfter[selectedColor];
  $('quote-impact').textContent = validQuote ? `${signed((nextImpactSpot - currentImpactSpot) * 100, 2)} 个百分点` : '—';
  $('win-preview').hidden = !opening || !validQuote;
  $('win-label').textContent = selectedSide === 'short' ? `若${LABELS[selectedColor]}盘未命中，NO 组合兑付` : `若${LABELS[selectedColor]}盘命中，持有到结算`;
  $('quote-win-payout').textContent = validQuote ? `兑付 ${fmt(quote.winPayout, 0)} 积分` : '—';
  profitText('quote-win-profit', quote.winProfit, 3);
  $('quote-roi').textContent = validQuote ? `命中时返还 ${fmt((quote.winPayout / quote.total) || 0, 2)}× 本单成本；净收益 ${signed(quote.winProfit, 3)} 分。这是条件兑付，不是胜率。` : '预算不足以买入一份。';
  $('submit-trade').disabled = !quote.canExecute || !validQuote || simulationFailed;
  const legs = quote.legs?.map(leg => `${LABELS[leg.color]} ${fmt(leg.shares, 0)} 份 ${leg.side === 'buy' ? '买入' : '卖出'} ${moneyFmt(leg.total, 3)} 分`).join('；');
  $('quote-note').textContent = legs
    ? `NO 两腿报价：${legs}。${quote.canExecute ? '下单时按最新报价重算。' : quote.reason || '当前不能成交。'}`
    : quote.canExecute ? '报价随成交变化，下单时按最新价格重算；你可以盘中卖出锁定实际盈亏。' : quote.reason || '当前不能成交。';
}

function drawBudgetComparisons() {
  const key = `${state.round}:${state.block}:${state.tradeCount}:${state.market.cash}:${state.market.q.red}:${state.market.q.black}:${state.market.q.green}`;
  if (compareKey === key) return;
  compareKey = key;
  for (const color of COLORS) {
    if (state.phase === 'settled') { $(`compare-${color}`).textContent = '本轮已结算 · 下轮重新报价'; continue; }
    try {
      const quote = quoteBudget(state, 'player', color, 50, 'buy');
      $(`compare-${color}`).textContent = quote.shares > 0
        ? `${fmt(quote.shares, 0)}份 · 命中返${fmt(quote.winPayout, 0)}分 · ${fmt(quote.winPayout / quote.total, 2)}×`
        : '50分不足1份';
    } catch { $(`compare-${color}`).textContent = '暂不可报价'; }
  }
}

function renderPersonalStrategy() {
  const panel = $('automation-panel');
  panel.hidden = !state.automation || priceMode();
  if (!state.automation || priceMode()) return;
  const a = state.automation;
  $('automation-enabled').checked = Boolean(a.enabled);
  $('automation-enabled').disabled = state.phase !== 'trading';
  for (const [id, value] of [['automation-strategy', a.strategy], ['automation-shares', a.orderShares], ['automation-position', a.maxPosition], ['automation-edge', a.edge]]) {
    const node = $(id); node.disabled = state.phase === 'locked' || state.phase === 'settled';
    if (document.activeElement !== node) node.value = String(value);
  }
  const decision = a.lastDecision;
  $('automation-decision').textContent = decision ? `${decision.action === 'hold' ? '观望' : decision.action === 'buy' ? '已买入' : decision.action === 'sell' ? '已卖出' : decision.action === 'start' ? '已启用' : decision.action === 'stop' ? '已停止' : '待机'}：${decision.reason}${decision.color ? ` · ${LABELS[decision.color]} ${decision.shares || ''} 份` : ''}` : '尚未启用。';
  $('automation-count').textContent = `策略实际成交 ${a.tradeCount} 笔 · 以成交账本为准`;
}

function render() {
  const player = playerOf(state), stats = participantStats(state, 'player');
  const prices = marketPrices(state);
  let odds = null;
  if (!priceMode()) { try { odds = scenarioOdds(state); } catch { odds = null; } }
  drawBudgetComparisons();
  const trading = state.phase === 'trading', settled = state.phase === 'settled';
  const e = state.event || {}, voided = settled && state.result?.voided;
  document.documentElement.dataset.game = priceMode() ? 'price' : 'local';
  document.querySelectorAll('[data-game-mode]').forEach(b => { const on = b.dataset.gameMode === selectedEventMode; b.classList.toggle('selected', on); b.setAttribute('aria-pressed', String(on)); b.disabled = live(state); });
  $('event-panel').hidden = !priceMode();
  if (priceMode()) renderEventPanel(state, sourceStatus);
  const lower = Number.isSafeInteger(e.lowerMicros) ? e.lowerMicros / 1e6 : Number.isFinite(e.lower) ? e.lower : 98;
  const upper = Number.isSafeInteger(e.upperMicros) ? e.upperMicros / 1e6 : Number.isFinite(e.upper) ? e.upper : 102;
  const metric = priceMode() ? 'SOL/USD' : '模拟价格';
  for (const color of COLORS) $(`band-${color}`).textContent = color === 'red' ? `${metric} > ${fmt(upper, 2)}` : color === 'black' ? `${metric} < ${fmt(lower, 2)}` : `${fmt(lower, 2)} ≤ ${metric} ≤ ${fmt(upper, 2)}`;
  $('balance').textContent = fmt(player.balance);
  $('equity').textContent = fmt(stats.equity);
  $('total-pnl').textContent = `${signed(stats.pnl)} · 预计清仓口径`;
  $('total-pnl').className = pnlClass(stats.pnl);
  $('reserve').textContent = fmt(state.market.cash);
  $('trade-count').textContent = fmt(state.tradeCount, 0);
  const lastSecond = state.trades.filter(t => t.timeMs > state.elapsedMs - 1000 && t.timeMs <= state.elapsedMs).length;
  $('trade-rate').textContent = `${live(state) ? lastSecond : 0} 笔 / 近 1 秒`;
  $('round-label').textContent = `第 ${String(state.round).padStart(2, '0')} 轮 / ${priceMode() ? '独立价格事件' : '本地模拟'}`;
  $('phase').textContent = { ready: '准备开场', trading: '自由交易中', locked: '已截止 · 等待结果', settled: '本轮已到期' }[state.phase];
  $('phase').className = `phase-pill ${state.phase}`;
  const obs = sourceStatus.observation;
  const eventRemaining = priceMode() && Number.isFinite(e.targetTimeMs) && Number.isFinite(obs?.serverTimeMs)
    ? Math.max(0, e.targetTimeMs - obs.serverTimeMs) : state.remainingMs;
  $('time').textContent = fmt(eventRemaining / 1000, 1);
  $('time-unit').textContent = '秒';
  $('window-label').textContent = trading && priceMode() ? `交易截止 ${e.cutoffTimeMs ? new Date(e.cutoffTimeMs).toLocaleTimeString('zh-CN') : '—'}`
    : trading ? `距封盘 ${fmt(Math.max(0, 55000 - state.elapsedMs) / 1000, 1)} 秒`
    : state.phase === 'locked' ? '交易已停止 · 等待精确目标 candle' : priceMode() ? '实时事件需主动准备 · 刷新后不恢复' : '55 秒交易 + 5 秒封盘';
  const canStartReal = !priceMode() || (e.mode === 'price' && Number.isFinite(e.targetTimeMs) && sourceStatus.status !== 'error');
  $('round-action').disabled = live(state) || simulationFailed || (priceMode() && state.phase === 'ready' && !canStartReal);
  setText('round-action-label', state.phase === 'ready' ? (priceMode() ? (canStartReal ? '开始 SOL/USD 事件' : '先准备实时事件') : '开始 60 秒交易') : settled ? (priceMode() ? '准备下一轮 Coinbase 事件' : '继续下一轮') : state.phase === 'locked' ? '等待到期结算' : '交易进行中');
  $('time-bar').style.width = `${Math.max(0, Math.min(100, 100 * eventRemaining / (priceMode() ? Math.max(1, e.targetTimeMs - e.startTimeMs) : state.durationMs)))}%`;
  $('timer').setAttribute('aria-valuenow', fmt(eventRemaining / 1000, 1));
  $('timer').classList.toggle('urgent', state.phase === 'locked');
  $('countdown-dial').style.setProperty('--remaining', `${Math.max(0, Math.min(100, 100 * eventRemaining / (priceMode() ? Math.max(1, e.targetTimeMs - e.startTimeMs) : state.durationMs)))}%`);
  $('countdown-dial').classList.toggle('urgent', state.phase === 'locked');
  $('chart-prompt').hidden = state.phase !== 'ready';
  $('chart-prompt-note').textContent = '三色份额价格由同一 LMSR 交易账本决定；事件结果保持独立';
  $('chart-lock-note').textContent = priceMode() ? '实时来源在截止时间前 15 秒停止交易' : '阴影区：最后 5 秒封盘';
  $('scenario-note').textContent = voided ? '本轮作废，未平仓份额按含费成本退回。' : settled ? '事件结果已确认；卡片显示本轮到期兑付价。' : priceMode() ? '实时 SOL/USD 模式不展示未经校准的胜率；当前市场价格是交易报价，不是结果概率。' : '本地价格路径与账户交易分离；份额价格是交易报价，不代表结果概率。';
  document.querySelectorAll('#game .scenario-label').forEach(node => { node.textContent = settled ? '本轮结果' : priceMode() ? '校准概率' : '本地模型估计'; });
  document.querySelectorAll('[data-bots]').forEach(b => { b.disabled = live(state); b.classList.toggle('selected', Number(b.dataset.bots) === state.botCount); b.setAttribute('aria-pressed', String(Number(b.dataset.bots) === state.botCount)); });
  document.querySelectorAll('#game [data-color]').forEach(b => { b.classList.toggle('selected', b.dataset.color === selectedColor); b.setAttribute('aria-pressed', String(b.dataset.color === selectedColor)); });
  document.querySelectorAll('#game .price-unit').forEach(node => { node.textContent = settled ? '到期兑付价 · 积分 / 份' : '市场价格 · 积分 / 份'; });
  for (const color of COLORS) {
    $(`price-${color}`).textContent = fmt(prices[color], 3);
    $(`odds-${color}`).textContent = voided ? '已作废' : settled ? (state.result.color === color ? '已命中' : '未命中') : priceMode() ? '—' : odds ? percent(odds[color]) : '—';
    const support = settled ? state.result.supportCounts?.[color] : state.participants.filter(participant => participant.holdings[color] > 0).length;
    $(`support-${color}`).textContent = Number.isInteger(support) ? String(support) : '—';
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
  renderPersonalStrategy();
  $('phase-note').textContent = priceMode()
    ? ({ ready: '先读取并冻结 Coinbase 参考价，再开始事件。每次成交前复核截止与新鲜行情；截止后禁止所有交易。', trading: '实时来源每 3 秒轮询，成交复用 3 秒内的成功观察。若网络失败，事件保持待结算；不会用模拟价格替代。', locked: '交易已截止。等待精确目标分钟 candle 收盘价；只有核验到目标 bucket 才结算。', settled: '事件已按目标 candle 收盘价结算。下一轮需重新准备实时事件。' })[state.phase]
    : ({ ready: '本地离线模拟可直接开始；交易改变 LMSR 价格与账本，不能改变独立模拟价格路径。', trading: '开放交易时可买入 YES / NO 或卖出已有持仓；没有控场动作和行动券。', locked: state.event.certainColor ? `剩余合法价格范围已确定 ${LABELS[state.event.certainColor]} 盘，已提前封盘；等待 60 秒正式结算。` : '最后 5 秒封盘：停止买卖，等待独立价格路径到期。', settled: '事件结果、实际兑付、持有人数与收益排名已记录。' })[state.phase];
  renderQuote(prices); drawChart(prices); drawBots(); drawTrades(); drawResults(); drawFeed();
  if (lastPhase !== state.phase) {
    if (state.phase === 'locked') notify(priceMode() ? '已到交易截止时间：开仓与退出已停止，等待独立来源的目标 candle。' : '已进入封盘：买卖停止，等待本地独立价格路径到期。');
    if (voided) notify(`第 ${state.round} 轮已作废：${state.result.reason}。成本已退回，本轮盈亏 ${signed(state.result.profits.player)} 积分。`);
    else if (settled) notify(`第 ${state.round} 轮${LABELS[state.result.color]}盘命中，你的本轮净盈亏 ${signed(state.result.profits.player)} 积分。`);
    lastPhase = state.phase;
    persist();
  }
}

const PRICE_SPEC_KEYS = ['mode', 'title', 'source', 'product', 'startTimeMs', 'cutoffTimeMs', 'targetTimeMs', 'referenceTimeMs', 'referenceMicros', 'lowerMicros', 'upperMicros', 'bandBps', 'settlementDelayMs'];
function priceEventSpec(event) {
  if (!event) throw new Error('请先准备一个新的 Coinbase SOL-USD 事件。');
  return JSON.parse(JSON.stringify(Object.fromEntries(PRICE_SPEC_KEYS.map(key => [key, event[key]]))));
}
function runPricePoll() {
  if (!priceMode() || !state.event || state.event.mode !== 'price') throw new Error('请先准备一个新的 Coinbase SOL-USD 事件。');
  if (pollPromise) return pollPromise;
  pollInFlight = true;
  const generation = eventGeneration;
  const controller = new AbortController(); eventController = controller;
  sourceStatus = { ...sourceStatus, status: 'loading', error: '' }; renderEventPanel(state, sourceStatus);
  const task = (async () => {
    try {
      const observation = await pollPriceEvent(priceEventSpec(state.event), { signal: controller.signal });
      if (generation !== eventGeneration || controller.signal.aborted) throw new Error('本次读取已取消。');
      state = observePriceEvent(state, observation);
      sourceStatus = { status: 'live', error: '', observation };
      lastPollAt = performance.now();
      return observation;
    } catch (error) {
      if (generation === eventGeneration && !controller.signal.aborted) sourceStatus = { ...sourceStatus, status: 'error', error: error.message || 'Coinbase 行情读取失败。' };
      throw error;
    } finally {
      if (generation === eventGeneration) { pollInFlight = false; eventController = null; pollPromise = null; render(); }
    }
  })();
  pollPromise = task;
  return task;
}
async function refreshPriceForTrade({ force = false, requireTrading = true } = {}) {
  if (!state.event || state.event.mode !== 'price') throw new Error('请先准备一个新的 Coinbase SOL-USD 事件。');
  const age = performance.now() - lastPollAt;
  const observation = sourceStatus.observation;
  const projectedServerTime = observation ? observation.serverTimeMs + Math.max(0, age) : Infinity;
  const stale = sourceStatus.status !== 'live' || !observation || age > 3000 || projectedServerTime >= state.event.cutoffTimeMs;
  if (force || stale) await runPricePoll();
  // Reconcile the timer after any network wait before handing control to a trade.
  flushTime();
  const latest = sourceStatus.observation;
  const latestAge = performance.now() - lastPollAt;
  const projected = latest ? latest.serverTimeMs + Math.max(0, latestAge) : Infinity;
  if (!latest || sourceStatus.status !== 'live') throw new Error(sourceStatus.error || '独立行情暂不可用，事件保持待处理。');
  if (requireTrading && (state.phase !== 'trading' || state.event.serverTimeMs >= state.event.cutoffTimeMs || projected >= state.event.cutoffTimeMs)) {
    throw new Error('价格事件已到交易截止时间；已停止开仓与退出。');
  }
  return latest;
}
function cancelPriceRequests() {
  eventGeneration += 1;
  eventController?.abort(); eventController = null; pollInFlight = false; pollPromise = null;
}
async function prepareRealEvent() {
  cancelPriceRequests();
  const generation = eventGeneration, controller = new AbortController(); eventController = controller;
  sourceStatus = { status: 'loading', error: '', observation: null };
  showError(''); render();
  try {
    const spec = await preparePriceEvent({ signal: controller.signal });
    if (generation !== eventGeneration || controller.signal.aborted) return;
    state = configurePriceEvent(state, spec);
    eventController = null;
    sourceStatus = { status: 'ready', error: '', observation: null };
    await runPricePoll();
    notify('Coinbase 事件已准备。参考价与目标 candle 已冻结；点击开始后进入交易窗口。');
  } catch (error) {
    if (generation !== eventGeneration || controller.signal.aborted) return;
    sourceStatus = { status: 'error', error: error.message || 'Coinbase 事件准备失败。', observation: null };
    showError(`实时事件准备失败：${sourceStatus.error}。不会切换到模拟价格；可重试读取。`);
    render();
  }
}
async function runOperation(operation, { priceCheck = true } = {}) {
  try {
    flushTime();
    if (priceCheck && priceMode() && (selectedSide === 'buy' || selectedSide === 'short' || selectedSide === 'sell' || selectedSide === 'cover')) await refreshPriceForTrade();
    await operation(); showError(''); lastNow = performance.now(); persist(); render();
  } catch (error) { showError(error.reason || error.message || '操作未成功，请查看当前阶段与账户余额。'); render(); }
}

document.querySelectorAll('#game [data-color]').forEach(button => button.addEventListener('click', () => runOperation(() => { selectedColor = button.dataset.color; }, { priceCheck: false })));
document.querySelectorAll('#game [data-side]').forEach(button => button.addEventListener('click', () => runOperation(() => {
  selectedSide = button.dataset.side;
  if (selectedSide === 'sell' || selectedSide === 'cover') amountMode = 'shares';
}, { priceCheck: false })));
document.querySelectorAll('#game [data-budget]').forEach(button => button.addEventListener('click', () => runOperation(() => { $('budget').value = button.dataset.budget; }, { priceCheck: false })));
document.querySelectorAll('#game [data-shares]').forEach(button => button.addEventListener('click', () => runOperation(() => { $('shares').value = button.dataset.shares; }, { priceCheck: false })));
$('budget-mode').addEventListener('click', () => runOperation(() => { if (selectedSide === 'buy' || selectedSide === 'short') amountMode = 'budget'; }, { priceCheck: false }));
$('shares-mode').addEventListener('click', () => runOperation(() => { amountMode = 'shares'; }, { priceCheck: false }));
$('budget').addEventListener('input', () => runOperation(() => {}, { priceCheck: false }));
$('budget').addEventListener('keydown', event => { if (event.key === 'Enter' && !$('submit-trade').disabled) $('submit-trade').click(); });
$('shares').addEventListener('input', () => runOperation(() => {}, { priceCheck: false }));
$('shares').addEventListener('keydown', event => { if (event.key === 'Enter' && !$('submit-trade').disabled) $('submit-trade').click(); });
$('max-shares').addEventListener('click', () => runOperation(() => {
  amountMode = 'shares';
  if (selectedSide === 'sell') {
    const owned = playerOf(state).holdings[selectedColor];
    if (!owned) throw new Error('当前没有该色持仓可以卖出。');
    $('shares').value = String(Math.min(1000, owned));
    if (owned > 1000) notify('单笔最多 1,000 份；要一次清掉全部，请使用持仓行的“全部卖出”。');
  } else if (selectedSide === 'cover') {
    const closable = Math.min(...COLORS.filter(color => color !== selectedColor).map(color => playerOf(state).holdings[color]));
    if (!closable) throw new Error('另外两色没有等量持仓，当前不能平 NO。');
    $('shares').value = String(Math.min(1000, closable));
  } else {
    const preview = state.phase === 'ready' ? { ...state, phase: 'trading' } : state;
    let low = 0, high = 1000;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2), quote = quoteTrade(preview, 'player', selectedColor, selectedSide, mid);
      if (quote.canExecute && quote.total <= playerOf(state).balance) low = mid; else high = mid - 1;
    }
    if (!low) throw new Error('积分或做市储备不足，当前不能开仓。');
    $('shares').value = String(low);
  }
}, { priceCheck: false }));
$('submit-trade').addEventListener('click', () => runOperation(() => {
  const quote = amountMode === 'budget' && (selectedSide === 'buy' || selectedSide === 'short')
    ? quoteBudget(state, 'player', selectedColor, Math.min(Number($('budget').value), playerOf(state).balance), selectedSide)
    : quoteTrade(state, 'player', selectedColor, selectedSide, Number($('shares').value));
  if (!quote.canExecute || !quote.shares) throw new Error(quote.reason || '当前报价无法成交。');
  state = executeTrade(state, 'player', selectedColor, selectedSide, quote.shares);
  const verb = { buy: '买入 YES', sell: '卖出持仓', short: '买入 NO', cover: '平 NO' }[selectedSide];
  const legSummary = quote.legs?.map(leg => `${LABELS[leg.color]} ${leg.shares} 份`).join(' + ');
  notify(`已${verb} ${legSummary || `${LABELS[selectedColor]} ${fmt(quote.shares, 0)} 份`}，${selectedSide === 'buy' || selectedSide === 'short' ? '支付' : '到账'} ${fmt(quote.total, 4)} 积分，费用 ${fmt(quote.fee, 4)}。`);
}));
function sellColors(colors) {
  runOperation(() => {
    let next = state, sold = 0, proceeds = 0, count = 0;
    for (const color of colors) while (playerOf(next).holdings[color] > 0) {
      const quantity = Math.min(1000, playerOf(next).holdings[color]);
      next = executeTrade(next, 'player', color, 'sell', quantity); sold += quantity;
      proceeds += next.trades.at(-1).total; count += 1;
    }
    if (!sold) throw new Error('当前没有可卖出的持仓。');
    state = next; notify(`已卖出 ${fmt(sold, 0)} 份持仓，分 ${count} 笔成交，扣费后到账 ${fmt(proceeds, 4)} 积分。`);
  });
}
document.querySelectorAll('#game [data-sell]').forEach(b => b.addEventListener('click', () => sellColors([b.dataset.sell])));
$('sell-all').addEventListener('click', () => sellColors(COLORS));
function updateAutomation(patch) {
  try { if (priceMode()) throw new Error('实时价格事件不启用未校准的自动策略。'); state = configureAutomation(state, patch); showError(''); persist(); render(); }
  catch (error) { showError(error.reason || error.message || '策略设置无效。'); render(); }
}
$('automation-enabled').addEventListener('change', event => updateAutomation({ enabled: event.target.checked }));
$('automation-strategy').addEventListener('change', event => updateAutomation({ strategy: event.target.value }));
$('automation-shares').addEventListener('change', event => updateAutomation({ orderShares: Number(event.target.value) }));
$('automation-position').addEventListener('change', event => updateAutomation({ maxPosition: Number(event.target.value) }));
$('automation-edge').addEventListener('change', event => updateAutomation({ edge: Number(event.target.value) }));
$('round-action').addEventListener('click', () => runOperation(async () => {
  if (state.phase === 'ready' && priceMode()) {
    if (!state.event || state.event.mode !== 'price') throw new Error('请先点击“读取 Coinbase 并准备事件”。');
    await refreshPriceForTrade({ force: true, requireTrading: false });
    state = startRound(state);
    notify('实时 SOL/USD 事件开始。开仓与退出会复核截止时间和新鲜行情；目标时间前 15 秒截止。');
  } else if (state.phase === 'ready') { state = startRound(state); notify('本地独立模拟开始：55 秒内可买卖，最后 5 秒封盘。'); }
  else if (state.phase === 'settled') {
    if (priceMode()) cancelPriceRequests();
    state = nextRound(state); clearKeys();
    if (priceMode()) { sourceStatus = { status: 'idle', error: '', observation: null }; notify('新一轮已准备。先重新读取 Coinbase 服务器时间与参考 candle。'); }
    else notify('已准备下一轮，余额与累计统计保留。点击开始，开启新的 60 秒。');
  }
}, { priceCheck: false }));
$('rules-link').addEventListener('click', () => { $('rules').open = true; });

function freshGame(botCount = state.botCount) {
  cancelPriceRequests();
  state = resetGame(freshSeed(), { botCount, mode: 'local' });
  simulationFailed = false; sourceStatus = { status: 'idle', error: '', observation: null };
  selectedColor = 'red'; selectedSide = 'buy'; amountMode = 'budget'; $('budget').value = '50'; $('shares').value = '50'; compareKey = '';
  lastNow = performance.now(); lastPhase = ''; clearKeys(); showError();
  persist(); render(); notify(`新场次已准备：你与 ${botCount} 位 Bot 各有 1,000 积分，做市账户有 1,000 积分。`);
}
$('reset').addEventListener('click', () => { try { freshGame(); } catch (error) { showError(error.reason || error.message); } });
document.querySelectorAll('[data-bots]').forEach(b => b.addEventListener('click', () => {
  if (live(state) || Number(b.dataset.bots) === state.botCount) return;
  freshGame(Number(b.dataset.bots));
}));
document.querySelectorAll('[data-game-mode]').forEach(button => button.addEventListener('click', () => {
  if (live(state)) return;
  cancelPriceRequests();
  selectedEventMode = button.dataset.gameMode === 'price' ? 'price' : 'local';
  state = resetGame(freshSeed(), { botCount: state.botCount, mode: 'local' });
  sourceStatus = { status: 'idle', error: '', observation: null };
  lastPhase = ''; clearKeys(); showError(); persist(); render();
  notify(priceMode() ? '已切到实时 SOL/USD 事件。网络读取只在你点击准备时开始；离线失败会保持等待。' : '已切回本地离线模拟，独立价格路径已准备好。');
}));
$('event-prepare').addEventListener('click', prepareRealEvent);
window.addEventListener('resize', () => { chartKey = ''; drawChart(marketPrices(state)); });
window.addEventListener('pagehide', () => { cancelPriceRequests(); try { flushTime(); persist(); } catch { /* Optional save. */ } });
setInterval(() => {
  try {
    const running = live(state); flushTime();
    if (running || priceMode()) render();
    if (running && performance.now() - lastPersistAt > 1000) persist();
  } catch (error) { simulationFailed = true; showError(`本地进度无法继续：${error.reason || error.message}。请用右上角“重置积分”重新开始。`); }
}, 100);
setInterval(() => {
  if (priceMode() && state.event?.mode === 'price' && !pollInFlight && performance.now() - lastPollAt >= 3000 && state.phase !== 'settled') void runPricePoll().catch(() => {});
}, 3000);
mountTheme();
render();
mountMarket(mountMonad());
