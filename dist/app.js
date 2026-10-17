import { createGame, resetGame, startRound, advance, executeTrade, playerAction, nextRound, quoteTrade, quoteBudget, marketPrices, scenarioOdds, participantStats, armChainEvent, ingestBlocks, voidRound, configureAutomation, actionPreview } from './game.js';
import { mountMonad } from './monad-ui.js';
import { mountMarket } from './monad-market-ui.js';
import { mountTheme } from './theme.js';
import { drawPriceChart } from './chart.js';
import { createBlockFeed } from './block-feed.js';
import { renderEventPanel } from './event-ui.js';
import { CHAIN_BLOCK_MS } from './chain-event.js';

const $ = id => document.getElementById(id);
const setText = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
const KEY = 'blockpulse-playground-v3';
const COLORS = ['red', 'black', 'green'];
const LABELS = { red: '红', black: '黑', green: '绿' };
const NAMES = { red: '红 · 上行', black: '黑 · 下行', green: '绿 · 区间' };
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
// Chain rounds are session-only: the local game is parked in stash while one runs.
const feed = createBlockFeed();
let feedState = feed.getState();
const stash = { local: null, chain: null };
let chainEverLive = false;
const REARM_BLOCKS = 20;
const FEED_FRESH_MS = 10000;
const chainMode = () => state.mode === 'chain';

// v3 stores local practice and player strategy configuration; old sessions are not resumed.
function validSaved(saved) {
  const s = saved?.state;
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const nonnegative = n => finite(n) && n >= 0;
  if (saved?.version !== 3 || s?.schemaVersion !== 3 || (s.mode && s.mode !== 'local') || !['ready', 'trading', 'locked', 'settled'].includes(s.phase)) return false;
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
  const automation = s.automation, ev = s.event;
  if (!ev || ev.mode !== 'simulation' || ev.lower !== 98 || ev.upper !== 102 || !Number.isSafeInteger(ev.targetBlock)
    || !['ready', 'simulated'].includes(ev.status)) return false;
  if (!automation || typeof automation.enabled !== 'boolean' || !['value', 'momentum'].includes(automation.strategy)
    || !Number.isInteger(automation.orderShares) || automation.orderShares < 1 || automation.orderShares > 50
    || !Number.isInteger(automation.maxPosition) || automation.maxPosition < 10 || automation.maxPosition > 500
    || !finite(automation.edge) || automation.edge < 0.01 || automation.edge > 0.2 || !Number.isInteger(automation.tradeCount)
    || automation.tradeCount < 0 || !Array.isArray(automation.decisions)) return false;
  if (!nonnegative(s.market?.cash) || !finite(s.market?.b) || s.market.b <= 0 || s.market.feeRate !== 0.003 || !COLORS.every(c => Number.isInteger(s.market.q?.[c]) && s.market.q[c] >= 0 && s.market.q[c] <= s.market.cash + 0.000001)) return false;
  if (!s.market.priors || Math.abs(s.market.priors.red - 0.45) > 1e-12 || Math.abs(s.market.priors.black - 0.45) > 1e-12 || Math.abs(s.market.priors.green - 0.10) > 1e-12) return false;
  if (s.initialTotal !== (s.botCount + 1) * 1000 + 1000 || Math.abs(s.participants.reduce((sum, p) => sum + p.balance, s.market.cash) - s.initialTotal) > 0.001) return false;
  if (!COLORS.every(c => Math.abs(s.participants.reduce((sum, p) => sum + p.holdings[c], 0) - s.market.q[c]) < 0.000001)) return false;
  if (!Array.isArray(s.history) || !s.history.length || s.history.length > 10000 || !s.history.every(p => nonnegative(p.timeMs) && p.timeMs <= s.elapsedMs && finite(p.heat) && COLORS.every(c => nonnegative(p.prices?.[c]) && p.prices[c] <= 1))) return false;
  if (!Array.isArray(s.events) || !Array.isArray(s.trades) || !Array.isArray(s.results) || !Number.isInteger(s.tradeCount) || s.tradeCount < 0) return false;
  const validResult = r => r && Number.isInteger(r.round) && r.round > 0 && r.round <= s.round
    && COLORS.includes(r.color) && Number.isInteger(r.finalHeat) && Number.isInteger(r.actionHeat)
    && Number.isInteger(r.noise) && Math.abs(r.noise) <= s.noiseRange && r.finalHeat === r.actionHeat + r.noise
    && finite(r.profits?.player) && nonnegative(r.payouts?.player)
    && Number.isSafeInteger(r.eventValue) && r.eventLower === 98 && r.eventUpper === 102 && Array.isArray(r.ranking)
    && COLORS.every(c => nonnegative(r.closingPrices?.[c]) && r.closingPrices[c] <= 1);
  if (!s.results.every(validResult)) return false;
  if (!s.events.every(e => Number.isInteger(e.id) && nonnegative(e.timeMs) && e.timeMs <= s.elapsedMs && typeof e.message === 'string')) return false;
  if (!s.trades.every(t => ids.has(t.traderId) && COLORS.includes(t.color) && ['buy', 'sell'].includes(t.side) && Number.isInteger(t.shares) && t.shares > 0 && nonnegative(t.timeMs) && t.timeMs <= s.elapsedMs && nonnegative(t.fee) && nonnegative(t.total))) return false;
  if (!['_rngState', '_noiseRngState', '_eventRngState', '_nextAutomationMs', '_nextTickMs', '_nextEventId', '_nextTradeId'].every(k => Number.isInteger(s[k]) && s[k] >= 0)) return false;
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
    selectedSide = ['buy', 'sell', 'short', 'cover'].includes(saved.form?.side) ? saved.form.side : 'buy';
    amountMode = ['sell', 'cover'].includes(selectedSide) ? 'shares' : saved.form?.mode === 'shares' ? 'shares' : 'budget';
    if (typeof saved.form?.shares === 'string' && saved.form.shares.length <= 8) $('shares').value = saved.form.shares;
    if (typeof saved.form?.budget === 'string' && saved.form.budget.length <= 8) $('budget').value = saved.form.budget;
    $('notice').textContent = '已恢复本机 v3 进度；离开页面期间未继续模拟。';
  } else if (saved || localStorage.getItem('blockpulse-playground-v2')) $('notice').textContent = '旧进度或无效进度未恢复，已准备新的 v3 场次。';
} catch { /* Storage is optional; an unavailable or invalid save never blocks play. */ }

function persist() {
  if (chainMode()) return;
  try { localStorage.setItem(KEY, JSON.stringify({ version: 3, state, form: { color: selectedColor, side: selectedSide, shares: $('shares').value, budget: $('budget').value, mode: amountMode } })); } catch { /* Private mode or full storage is fine. */ }
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
  const chain = chainMode();
  drawPriceChart(svg, {
    durationMs: state.durationMs, lockMs: state.tradingDurationMs, points: state.history, elapsedMs: state.elapsedMs, prices,
    ticks: chain ? [0, 45, 90, 135, 180].map(block => [block * CHAIN_BLOCK_MS, block ? `${block}` : '0 块']) : undefined,
    label: `第 ${state.round} 轮份额价格，红 ${fmt(prices.red, 3)}、黑 ${fmt(prices.black, 3)}、绿 ${fmt(prices.green, 3)} 积分每份`,
    title: chain ? '模拟成交形成的价格，开盘价取自基准区块的先验概率' : '本地模拟成交形成的价格，不是结果概率',
  });
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
    return `<tr><td>${esc(participant?.name || t.traderId)}<small>${fmt(t.timeMs / 1000, 1)} 秒</small></td><td><span class="trade-side ${t.side}">${t.source === 'strategy' ? '策略 · ' : ''}${t.comboSide === 'short' ? '开 NO' : t.comboSide === 'cover' ? '平 NO' : t.side === 'buy' ? '买' : '卖'}${t.comboSide ? ` · ${LABELS[t.color]}` : LABELS[t.color]}</span></td><td>${fmt(t.shares, 0)}</td><td>${esc(moneyFmt(t.averagePrice, 4))}</td><td>${esc(moneyFmt(t.fee, 4))}</td><td>${t.side === 'buy' ? '−' : '+'}${esc(moneyFmt(t.total, 3))}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="empty-cell">开场后，这里记录每一笔实际成交。</td></tr>';
}

function drawResults() {
  const key = `${state.round}:${state.phase}:${state.results.length}`;
  if (key === resultKey) return;
  resultKey = key;
  $('record-count').textContent = `${state.results.length} 轮`;
  $('results-list').innerHTML = state.results.length ? state.results.slice(-5).reverse().map(r => {
    const detail = Number.isSafeInteger(r.eventValue) ? `${r.eventValue} 笔` : r.event ? `${r.event.busy}/${r.event.baseline} 繁忙块` : r.finalHeat;
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
    const busySummary = r.event ? `忙区块事件：观察 ${r.event.busy} 个繁忙块，基准 ${r.event.baseline}，区块窗口 #${r.event.startBlock + 1}–#${r.event.endBlock}。` : '';
    const localSummary = Number.isSafeInteger(r.eventValue) ? `本地模拟事件：第 ${r.targetBlock} 个模拟区块交易笔数为 ${r.eventValue}；黑 < ${r.eventLower}，绿 ${r.eventLower}–${r.eventUpper}（含边界），红 > ${r.eventUpper}。` : '';
    let lastProfit, lastRank = 0;
    const ranking = r.ranking || Object.entries(r.profits || {}).map(([id, profit]) => ({ id, name: state.participants.find(p => p.id === id)?.name || id, profit }))
      .sort((a, b) => b.profit - a.profit).map((entry, index) => { if (index === 0 || entry.profit !== lastProfit) lastRank = index + 1; lastProfit = entry.profit; return { ...entry, rank: lastRank }; });
    const rankingRows = ranking.map(item => `<li><span>#${item.rank} ${esc(item.name)}</span><b class="${pnlClass(item.profit)}">${signed(item.profit)}</b></li>`).join('');
    const eventSummary = busySummary || localSummary;
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
      : chainMode() ? '本轮份额已按结果兑付，卡片显示到期兑付价。下一轮按新的基准区块重新定开盘价。'
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

function renderPersonalStrategy(chain) {
  const panel = $('automation-panel');
  panel.hidden = !state.automation;
  $('action-preview').hidden = !state.automation;
  if (!state.automation) return;
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
  const preview = actionPreview(state, 1);
  const oddsText = odds => COLORS.map(color => `${LABELS[color]} ${percent(odds[color])}`).join(' · ');
  $('action-preview-before').textContent = oddsText(preview.before);
  $('action-preview-after').textContent = oddsText(preview.after);
  $('action-preview-note').textContent = preview.reason || '仅是本地模型估计变化；事件仍有随机扰动，不保证结果。';
}

function render() {
  const player = playerOf(state), stats = participantStats(state, 'player');
  const prices = marketPrices(state), odds = scenarioOdds(state);
  drawBudgetComparisons();
  const trading = state.phase === 'trading', settled = state.phase === 'settled';
  const chain = chainMode(), e = state.event, voided = settled && state.result.voided;
  const feedLive = feedState.status === 'live';
  document.documentElement.dataset.game = chain ? 'chain' : 'local';
  document.querySelectorAll('[data-game-mode]').forEach(b => { const on = b.dataset.gameMode === (chain ? 'chain' : 'local'); b.classList.toggle('selected', on); b.setAttribute('aria-pressed', String(on)); });
  $('event-panel').hidden = !chain;
  if (chain) renderEventPanel(state, feedState);
  const lowerBound = chain ? state.greenBand[0] : (state.event?.lower ?? state.greenBand[0]);
  const upperBound = chain ? state.greenBand[1] : (state.event?.upper ?? state.greenBand[1]);
  const metric = chain ? '收盘分数' : '交易笔数';
  for (const color of COLORS) $(`band-${color}`).textContent = color === 'red' ? `${metric} > ${upperBound}` : color === 'black' ? `${metric} < ${lowerBound}` : `${lowerBound} ≤ ${metric} ≤ ${upperBound}`;
  $('balance').textContent = fmt(player.balance);
  $('equity').textContent = fmt(stats.equity);
  $('total-pnl').textContent = `${signed(stats.pnl)} · 预计清仓口径`;
  $('total-pnl').className = pnlClass(stats.pnl);
  $('reserve').textContent = fmt(state.market.cash);
  $('trade-count').textContent = fmt(state.tradeCount, 0);
  const lastSecond = state.trades.filter(t => t.timeMs > state.elapsedMs - 1000 && t.timeMs <= state.elapsedMs).length;
  $('trade-rate').textContent = chain ? `${live(state) ? state.trades.filter(t => t.timeMs > state.elapsedMs - 3 * CHAIN_BLOCK_MS && t.timeMs <= state.elapsedMs).length : 0} 笔 / 近 3 个区块`
    : `${live(state) ? lastSecond : 0} 笔 / 近 1 秒`;
  $('round-label').textContent = chain ? `第 ${String(state.round).padStart(2, '0')} 轮 / 链上区块 ${String(state.block).padStart(3, '0')} / ${e ? e.windowBlocks : 180}`
    : `第 ${String(state.round).padStart(2, '0')} 轮 / 模拟区块 ${String(state.block).padStart(3, '0')}`;
  $('phase').textContent = { ready: '准备开场', trading: '自由交易中', locked: '已封盘 · 等待结果', settled: '本轮已到期' }[state.phase];
  $('phase').className = `phase-pill ${state.phase}`;
  const blocksLeft = e ? e.windowBlocks - e.observed : 180;
  $('time').textContent = chain ? String(blocksLeft) : fmt(state.remainingMs / 1000, 1);
  $('time-unit').textContent = chain ? '区块' : '秒';
  $('window-label').textContent = trading ? (chain ? `距封盘 ${e.lockBlocks - e.observed} 个区块` : `距封盘 ${fmt(Math.max(0, 55000 - state.elapsedMs) / 1000, 1)} 秒`)
    : state.phase === 'locked' ? '买卖与行动均已停止' : chain ? '180 个区块窗口 · 最后 15 块封盘' : '55 秒交易 + 5 秒封盘';
  $('round-action').disabled = live(state) || simulationFailed || (chain && state.phase === 'ready' && !feedLive);
  setText('round-action-label', state.phase === 'ready' ? (chain ? (feedLive ? '开始区块事件' : '等待区块数据') : '开始 60 秒交易') : settled ? '继续下一轮' : state.phase === 'locked' ? (chain ? '等待窗口结束' : '等待到期结算') : '交易进行中');
  $('time-bar').style.width = `${100 * state.remainingMs / state.durationMs}%`;
  $('timer').setAttribute('aria-valuenow', fmt(state.remainingMs / 1000, 1));
  $('timer').classList.toggle('urgent', state.phase === 'locked');
  $('countdown-dial').style.setProperty('--remaining', `${100 * state.remainingMs / state.durationMs}%`);
  $('countdown-dial').classList.toggle('urgent', state.phase === 'locked');
  $('chart-prompt').hidden = state.phase !== 'ready';
  $('chart-prompt-note').textContent = chain ? '开盘价取自基准区块算出的先验概率，之后随成交和新区块变化' : '开始一轮，观察三色份额怎样从 1/3 出发';
  $('chart-lock-note').textContent = chain ? '阴影区：最后 15 个区块封盘' : '阴影区：最后 5 秒封盘';
  $('scenario-note').textContent = voided ? '本轮已作废，份额按成本退回。' : settled ? '结果已确认：三色卡片现在显示到期兑付价与命中结果；封盘前价格保留在曲线上。'
    : chain ? '场景概率假设后续无人再用行动券，按基准繁忙比例推算剩余区块；它不同于交易价格，也不代表最终胜率。基准比例会随时段漂移。'
    : '本地交易笔数结果模型会结合当前进度与行动影响给出估计；它不同于份额价格，也不能保证最终结果。';
  document.querySelectorAll('#game .scenario-label').forEach(node => { node.textContent = settled ? '本轮结果' : '当前事件场景估计'; });
  document.querySelectorAll('[data-game-mode]').forEach(b => { b.disabled = live(state); });
  document.querySelectorAll('[data-bots]').forEach(b => { b.disabled = live(state); b.classList.toggle('selected', Number(b.dataset.bots) === state.botCount); b.setAttribute('aria-pressed', String(Number(b.dataset.bots) === state.botCount)); });
  document.querySelectorAll('#game [data-color]').forEach(b => { b.classList.toggle('selected', b.dataset.color === selectedColor); b.setAttribute('aria-pressed', String(b.dataset.color === selectedColor)); });
  document.querySelectorAll('#game .price-unit').forEach(node => { node.textContent = settled ? '到期兑付价 · 积分 / 份' : '市场价格 · 积分 / 份'; });
  for (const color of COLORS) {
    $(`price-${color}`).textContent = fmt(prices[color], 3);
    $(`odds-${color}`).textContent = voided ? '已作废' : settled ? (state.result.color === color ? '已命中' : '未命中') : percent(odds[color]);
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
  $('heat').textContent = state.heat;
  $('noise-label').textContent = voided ? '本轮作废' : chain ? (settled ? `本轮链上偏差 ${signed(state.result.noise, 0)}` : e ? `链上偏差 ${signed(e.busy - e.baseline, 0)} · 繁忙块 ${e.busy} − 基准 ${e.baseline}` : '链上偏差 · 等待基准')
    : settled && Number.isSafeInteger(state.result.eventValue) ? `本轮模拟交易 ${state.result.eventValue} 笔` : settled ? `本轮模拟噪声 ${signed(state.result.noise, 0)}` : `本地事件模拟 · ±${state.noiseRange}`;
  $('tickets').textContent = `你的行动券 ${player.tickets} / 3 · ${chain ? `全场热度偏移上限 ±${state.heatLimit}` : '可保留不用'}`;
  $('ticket-dots').querySelectorAll('i').forEach((dot, index) => { dot.classList.toggle('used', index >= player.tickets); });
  const upPreview = actionPreview(state, 1), downPreview = actionPreview(state, -1);
  $('heat-up').disabled = !upPreview.canExecute;
  $('heat-down').disabled = !downPreview.canExecute;
  renderPersonalStrategy(chain);
  $('phase-note').textContent = chain ? { ready: '读到基准区块后即可开始。开场后统计接下来 180 个区块，前 165 个区块可买卖和行动。', trading: '动作不扣积分，只消耗行动券，且全场热度最多偏离 ±3。繁忙块数由链上决定，用券改变不了它。', locked: '最后 15 个区块：不能下单、卖出或控场。窗口结束后按链上结果兑付。', settled: voided ? '本轮作废，成本已退回。可开始下一轮，重新读取基准。' : '到期兑付已入账。下轮保留余额与累计统计，并按新的基准区块重新定开盘价。' }[state.phase]
    : { ready: '先开始一轮。前 55 秒可反复买卖及使用行动券；本地结果按第 120 个模拟区块的交易笔数判定。', trading: '动作不扣积分，只消耗行动券。行动会影响本地模型估计，但交易笔数仍有随机扰动，无法保证结果。', locked: '最后 5 秒：不能下单、卖出或控场。等待本地目标区块交易笔数生成并结算。', settled: '事件结果、持有人数和收益排名已记录。下轮保留余额与累计统计，开始新的本地事件。' }[state.phase];
  renderQuote(prices); drawChart(prices); drawBots(); drawTrades(); drawResults(); drawFeed();
  if (lastPhase !== state.phase) {
    if (state.phase === 'locked') notify(chain ? '已进入最后 15 个区块封盘：买卖及行动停止，等待窗口结束。' : '已进入最后 5 秒封盘：买卖及行动停止，等待结算。');
    if (voided) notify(`第 ${state.round} 轮已作废：${state.result.reason}。成本已退回，本轮盈亏 ${signed(state.result.profits.player)} 积分。`);
    else if (settled) notify(`第 ${state.round} 轮${LABELS[state.result.color]}盘命中，你的本轮净盈亏 ${signed(state.result.profits.player)} 积分。`);
    lastPhase = state.phase;
    persist();
  }
}

function runOperation(operation) {
  try { flushTime(); operation(); showError(); lastNow = performance.now(); persist(); render(); }
  catch (error) { showError(error.reason || error.message || '操作未成功，请查看当前阶段与账户余额。'); render(); }
}

document.querySelectorAll('#game [data-color]').forEach(button => button.addEventListener('click', () => runOperation(() => { selectedColor = button.dataset.color; })));
document.querySelectorAll('#game [data-side]').forEach(button => button.addEventListener('click', () => runOperation(() => {
  selectedSide = button.dataset.side;
  if (selectedSide === 'sell' || selectedSide === 'cover') amountMode = 'shares';
})));
document.querySelectorAll('#game [data-budget]').forEach(button => button.addEventListener('click', () => runOperation(() => { $('budget').value = button.dataset.budget; })));
document.querySelectorAll('#game [data-shares]').forEach(button => button.addEventListener('click', () => runOperation(() => { $('shares').value = button.dataset.shares; })));
$('budget-mode').addEventListener('click', () => runOperation(() => { if (selectedSide === 'buy' || selectedSide === 'short') amountMode = 'budget'; }));
$('shares-mode').addEventListener('click', () => runOperation(() => { amountMode = 'shares'; }));
$('budget').addEventListener('input', () => runOperation(() => {}));
$('budget').addEventListener('keydown', event => { if (event.key === 'Enter' && !$('submit-trade').disabled) $('submit-trade').click(); });
$('shares').addEventListener('input', () => runOperation(() => {}));
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
    const limit = selectedSide === 'buy' ? playerOf(state).balance : playerOf(state).balance;
    let low = 0, high = 1000;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const quote = quoteTrade(preview, 'player', selectedColor, selectedSide, mid);
      if (quote.canExecute && quote.total <= limit) low = mid;
      else high = mid - 1;
    }
    if (!low) throw new Error('积分或做市储备不足，当前不能开仓。');
    $('shares').value = String(low);
  }
}));

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
document.querySelectorAll('#game [data-sell]').forEach(b => b.addEventListener('click', () => sellColors([b.dataset.sell])));
$('sell-all').addEventListener('click', () => sellColors(COLORS));
$('heat-up').addEventListener('click', () => runOperation(() => { state = playerAction(state, 1); notify(`已加热 +1，热度 ${state.heat}；剩余 ${playerOf(state).tickets} 张行动券。`); }));
$('heat-down').addEventListener('click', () => runOperation(() => { state = playerAction(state, -1); notify(`已降温 −1，热度 ${state.heat}；剩余 ${playerOf(state).tickets} 张行动券。`); }));
function updateAutomation(patch) {
  try { state = configureAutomation(state, patch); showError(''); persist(); render(); }
  catch (error) { showError(error.reason || error.message || '策略设置无效。'); render(); }
}
$('automation-enabled').addEventListener('change', event => updateAutomation({ enabled: event.target.checked }));
$('automation-strategy').addEventListener('change', event => updateAutomation({ strategy: event.target.value }));
$('automation-shares').addEventListener('change', event => updateAutomation({ orderShares: Number(event.target.value) }));
$('automation-position').addEventListener('change', event => updateAutomation({ maxPosition: Number(event.target.value) }));
$('automation-edge').addEventListener('change', event => updateAutomation({ edge: Number(event.target.value) }));
$('round-action').addEventListener('click', () => runOperation(() => {
  if (state.phase === 'ready' && chainMode()) {
    const { status, blocks, lastBlockAt } = feed.getState();
    if (status !== 'live' || Date.now() - lastBlockAt > FEED_FRESH_MS) throw new Error('区块数据不是最新的，请稍候再开始。');
    state = startRound(armChainEvent(state, blocks));
    notify(`事件开始：统计区块 #${state.event.startBlock + 1} 起的 ${state.event.windowBlocks} 个区块，基准 ${state.event.baseline} 个繁忙块。`);
  } else if (state.phase === 'ready') { state = startRound(state); notify('本轮开始：55 秒内可持续买卖，最后 5 秒封盘。'); }
  else if (state.phase === 'settled') {
    state = nextRound(state); clearKeys();
    if (chainMode()) { maybeArm(); notify('已准备下一轮，余额与累计统计保留。基准区块已更新，点击开始。'); }
    else notify('已准备下一轮，余额与累计统计保留。点击开始，开启新的 60 秒。');
  }
}));
$('rules-link').addEventListener('click', () => { $('rules').open = true; });

function freshGame(botCount = state.botCount) {
  flushTime();
  state = resetGame(freshSeed(), { botCount, mode: state.mode });
  simulationFailed = false;
  if (chainMode()) maybeArm();
  selectedColor = 'red'; selectedSide = 'buy'; amountMode = 'budget'; $('budget').value = '50'; $('shares').value = '50'; compareKey = '';
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

// Re-arm while idle so the opening prior tracks the chain; a started round is never re-armed.
function maybeArm() {
  if (!chainMode() || state.phase !== 'ready') return;
  const { status, blocks } = feed.getState();
  if (status !== 'live' || blocks.length < 300) return;
  if (state.event && blocks.at(-1).number - state.event.startBlock < REARM_BLOCKS) return;
  try { state = armChainEvent(state, blocks); clearKeys(); } catch (error) { showError(error.reason || error.message); }
}

function abortChainRound(reason) {
  if (!chainMode() || !live(state)) return;
  try { state = voidRound(state, reason); clearKeys(); showError(); }
  catch (error) { simulationFailed = true; showError(`区块事件无法作废：${error.reason || error.message}。请用右上角“重置积分”重新开始。`); }
}

function enterChain() {
  if (chainMode() || live(state)) return;
  flushTime(); persist();
  stash.local = state;
  state = stash.chain ?? createGame(freshSeed(), { botCount: state.botCount, mode: 'chain' });
  stash.chain = null;
  chainEverLive = false; lastPhase = ''; clearKeys(); showError();
  feedState = feed.getState();
  void feed.start();
  render(); notify('已切到区块事件场：正在读取最近 600 个区块作为基准，约需半分钟。');
}

function leaveChain(message) {
  if (!chainMode() || live(state)) return;
  stash.chain = state;
  state = stash.local; stash.local = null;
  feed.stop();
  lastNow = performance.now(); lastPhase = ''; clearKeys(); showError();
  render(); notify(message);
}

feed.subscribe(next => {
  feedState = next;
  if (!chainMode()) return;
  if (next.status === 'live') { chainEverLive = true; maybeArm(); }
  if (next.status === 'error') {
    if (live(state)) abortChainRound(next.error || '链上数据中断');
    else if (!chainEverLive) { leaveChain(`已回到本地随机场：${next.error || '无法读取测试网区块。'}`); return; }
  }
  render();
});
feed.onBlocks(fresh => {
  if (!chainMode() || !state.event || !live(state)) return;
  try { state = ingestBlocks(state, fresh); }
  catch (error) { abortChainRound(error.reason || error.message || '链上数据异常'); }
  render();
});
document.querySelectorAll('[data-game-mode]').forEach(b => b.addEventListener('click', () => {
  try {
    if (b.dataset.gameMode === 'chain') enterChain();
    else leaveChain('已回到本地随机场，本地进度已保留。');
  } catch (error) { showError(error.reason || error.message); }
}));
$('event-retry').addEventListener('click', () => { if (chainMode()) { showError(); void feed.start(); } });
mountTheme();
render();
mountMarket(mountMonad());
