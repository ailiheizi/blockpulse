import { createGame, resetGame, startRound, advance, executeTrade, playerAction, nextRound, quoteTrade, quoteBudget, marketPrices, scenarioOdds, participantStats, configureEvent, observeEvent, actionPreview, configureAutomation } from './game.js';
import { prepareMonadEvent, pollMonadEvent } from './event-source.js';
import { mountMonad } from './monad-ui.js';
import { mountMarket } from './monad-market-ui.js';
import { mountTheme } from './theme.js';
import { drawPriceChart } from './chart.js';

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
let selectedEventMode = 'simulation';
let preparedSpec = null;
let eventGeneration = 0;
let eventController = null;
let pollBusy = false;
let lastPollAt = 0;

// v3 adds event and player automation state. Older versions are deliberately not resumed.
function validSaved(saved) {
  const s = saved?.state;
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const nonnegative = n => finite(n) && n >= 0;
  if (saved?.version !== 3 || s?.schemaVersion !== 3 || !['ready', 'trading', 'locked', 'settled'].includes(s.phase)) return false;
  if (![2, 20].includes(s.botCount) || s.participants?.length !== s.botCount + 1) return false;
  if (!Number.isInteger(s.round) || s.round < 1 || s.durationMs !== 60000 || s.tradingDurationMs !== 55000) return false;
  if (!nonnegative(s.elapsedMs) || s.elapsedMs > 60000 || !finite(s.remainingMs) || Math.abs(s.elapsedMs + s.remainingMs - 60000) > 0.001) return false;
  if (s.event?.mode !== 'monad' && ((s.phase === 'ready' && s.elapsedMs !== 0) || (s.phase === 'trading' && s.elapsedMs >= 55000) || (s.phase === 'locked' && (s.elapsedMs < 55000 || s.elapsedMs >= 60000)) || (s.phase === 'settled' && s.elapsedMs !== 60000))) return false;
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
  const ev = s.event, automation = s.automation;
  if (!ev || !['simulation', 'monad'].includes(ev.mode) || !['ready', 'expired', 'verified', 'simulated'].includes(ev.status)
    || typeof ev.title !== 'string' || !Number.isSafeInteger(ev.startBlock) || !Number.isSafeInteger(ev.closeBlock)
    || !Number.isSafeInteger(ev.targetBlock) || !Number.isSafeInteger(ev.lower) || !Number.isSafeInteger(ev.upper) || ev.lower < 0 || ev.upper <= ev.lower
    || (ev.mode === 'monad' && (ev.chainId !== 10143 || ev.source !== 'Monad Testnet RPC' || ev.closeBlock !== ev.startBlock + 130 || ev.targetBlock !== ev.startBlock + 150 || ev.confirmations !== 2 || !Number.isFinite(ev.baseline) || ev.baseline < 1))
    || (ev.mode === 'simulation' && (ev.lower !== 98 || ev.upper !== 102 || ev.status === 'verified'))) return false;
  if (!automation || typeof automation.enabled !== 'boolean' || !['value', 'momentum'].includes(automation.strategy)
    || !Number.isInteger(automation.orderShares) || automation.orderShares < 1 || automation.orderShares > 50
    || !Number.isInteger(automation.maxPosition) || automation.maxPosition < 10 || automation.maxPosition > 500
    || !finite(automation.edge) || automation.edge < 0.01 || automation.edge > 0.2
    || !Number.isInteger(automation.tradeCount) || automation.tradeCount < 0 || !Array.isArray(automation.decisions)) return false;
  if (!nonnegative(s.market?.cash) || !finite(s.market?.b) || s.market.b <= 0 || s.market.feeRate !== 0.003 || !COLORS.every(c => Number.isInteger(s.market.q?.[c]) && s.market.q[c] >= 0 && s.market.q[c] <= s.market.cash + 0.000001)) return false;
  if (!s.market.priors || Math.abs(s.market.priors.red - 0.45) > 1e-12 || Math.abs(s.market.priors.black - 0.45) > 1e-12 || Math.abs(s.market.priors.green - 0.10) > 1e-12) return false;
  if (s.initialTotal !== (s.botCount + 1) * 1000 + 1000 || Math.abs(s.participants.reduce((sum, p) => sum + p.balance, s.market.cash) - s.initialTotal) > 0.001) return false;
  if (!COLORS.every(c => Math.abs(s.participants.reduce((sum, p) => sum + p.holdings[c], 0) - s.market.q[c]) < 0.000001)) return false;
  if (!Array.isArray(s.history) || !s.history.length || s.history.length > 10000 || !s.history.every(p => nonnegative(p.timeMs) && p.timeMs <= s.elapsedMs && finite(p.heat) && COLORS.every(c => nonnegative(p.prices?.[c]) && p.prices[c] <= 1))) return false;
  if (!Array.isArray(s.events) || !Array.isArray(s.trades) || !Array.isArray(s.results) || !Number.isInteger(s.tradeCount) || s.tradeCount < 0) return false;
  const validResult = r => r && Number.isInteger(r.round) && r.round > 0 && r.round <= s.round
    && COLORS.includes(r.color) && Number.isInteger(r.finalHeat) && Number.isInteger(r.actionHeat)
    && Number.isInteger(r.noise) && Math.abs(r.noise) <= s.noiseRange && r.finalHeat === r.actionHeat + r.noise
    && Number.isSafeInteger(r.eventValue) && Number.isSafeInteger(r.eventLower) && Number.isSafeInteger(r.eventUpper) && Array.isArray(r.ranking)
    && finite(r.profits?.player) && nonnegative(r.payouts?.player)
    && COLORS.every(c => nonnegative(r.closingPrices?.[c]) && r.closingPrices[c] <= 1);
  if (!s.results.every(validResult)) return false;
  if (!s.events.every(e => Number.isInteger(e.id) && nonnegative(e.timeMs) && e.timeMs <= s.elapsedMs && typeof e.message === 'string')) return false;
  if (!s.trades.every(t => ids.has(t.traderId) && COLORS.includes(t.color) && ['buy', 'sell'].includes(t.side) && Number.isInteger(t.shares) && t.shares > 0 && nonnegative(t.timeMs) && t.timeMs <= s.elapsedMs && nonnegative(t.fee) && nonnegative(t.total))) return false;
  if (!['_rngState', '_noiseRngState', '_eventRngState', '_nextTickMs', '_nextAutomationMs', '_nextEventId', '_nextTradeId'].every(k => Number.isInteger(s[k]) && s[k] >= 0)) return false;
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
    selectedEventMode = state.event.mode === 'monad' ? 'monad' : 'simulation';
    preparedSpec = state.event.mode === 'monad' ? exactEventSpec(state.event) : null;
    $('notice').textContent = '已恢复本机 v3 进度；离开页面期间未继续模拟。';
  } else if (saved || localStorage.getItem('blockpulse-playground-v2')) $('notice').textContent = '旧进度或无效进度未恢复，已准备新的 v3 场次。';
} catch { /* Storage is optional; an unavailable or invalid save never blocks play. */ }

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify({ version: 3, state, form: { color: selectedColor, side: selectedSide, shares: $('shares').value, budget: $('budget').value, mode: amountMode } })); } catch { /* Private mode or full storage is fine. */ }
  lastPersistAt = performance.now();
}
function notify(message) { $('notice').textContent = message; }
function showError(message = '') { $('error').textContent = message; $('error').hidden = !message; }
function profitText(id, value, digits = 2) { $(id).textContent = signed(value, digits); $(id).className = pnlClass(value); }
function clearKeys() { chartKey = botKey = tradeKey = resultKey = feedKey = ''; }

function exactEventSpec(event) {
  if (!event || event.mode !== 'monad') return null;
  return { mode: event.mode, title: event.title, chainId: event.chainId, source: event.source,
    startBlock: event.startBlock, closeBlock: event.closeBlock, targetBlock: event.targetBlock,
    baseline: event.baseline, lower: event.lower, upper: event.upper, confirmations: event.confirmations };
}
function cancelEventWork() {
  eventGeneration += 1;
  eventController?.abort();
  eventController = null;
  pollBusy = false;
}
function eventErrorText(error) { return error?.message || 'Monad RPC 读取失败；真实事件仍未确认，可重试或重新准备。'; }

async function prepareRealEvent() {
  if (state.phase !== 'ready' || selectedEventMode !== 'monad') return;
  cancelEventWork();
  const generation = eventGeneration;
  const controller = new AbortController(); eventController = controller;
  $('event-prepare').disabled = $('event-retry').disabled = true;
  setText('event-observation', '正在读取 Monad 测试网近期区块并准备未来目标…');
  try {
    const spec = await prepareMonadEvent({ signal: controller.signal });
    if (generation !== eventGeneration || controller.signal.aborted) return;
    preparedSpec = spec;
    state = configureEvent(state, spec);
    lastPollAt = 0;
    notify(`已准备 Monad 真实事件：目标区块 ${spec.targetBlock}；现在开始前会再次检查封盘状态。`);
    persist(); render();
  } catch (error) {
    if (generation === eventGeneration && error?.code !== 'ABORTED') {
      setText('event-observation', `${eventErrorText(error)}未切换为模拟结果。`);
      showError(eventErrorText(error));
    }
  } finally {
    if (generation === eventGeneration) { eventController = null; $('event-prepare').disabled = $('event-retry').disabled = false; }
  }
}

async function readRealEvent({ preflight = false, force = false } = {}) {
  if (!preparedSpec || state.event.mode !== 'monad' || pollBusy) return null;
  if (!force && !preflight && performance.now() - lastPollAt < 1900) return null;
  const generation = eventGeneration;
  const controller = new AbortController(); eventController = controller; pollBusy = true;
  lastPollAt = performance.now();
  try {
    const observation = await pollMonadEvent(preparedSpec, { signal: controller.signal });
    if (generation !== eventGeneration || controller.signal.aborted) return null;
    state = observeEvent(state, observation);
    setText('event-observation', observation.verified
      ? `已双读确认目标区块 ${observation.blockNumber}：${observation.txCount} 笔交易 · ${observation.blockHash}`
      : `Monad 当前高度 ${observation.headBlock}；目标区块 ${preparedSpec.targetBlock}，等待确认数达到 ${preparedSpec.confirmations}。`);
    showError(''); persist(); render();
    return observation;
  } catch (error) {
    if (generation === eventGeneration && error?.code !== 'ABORTED') {
      setText('event-observation', `${eventErrorText(error)}真实事件仍待确认，没有使用本地结果代替。`);
      if (preflight) showError(eventErrorText(error));
    }
    return null;
  } finally {
    if (generation === eventGeneration) { eventController = null; pollBusy = false; }
  }
}

function renderEventCard() {
  const e = state.event, monad = e.mode === 'monad' || selectedEventMode === 'monad';
  $('event-local').classList.toggle('selected', !monad); $('event-local').setAttribute('aria-pressed', String(!monad));
  $('event-monad').classList.toggle('selected', monad); $('event-monad').setAttribute('aria-pressed', String(monad));
  $('event-local').disabled = $('event-monad').disabled = state.phase !== 'ready';
  $('event-prepare').hidden = !monad || state.phase !== 'ready';
  $('event-retry').hidden = !monad || state.phase === 'ready' && !preparedSpec;
  $('event-retry').textContent = state.phase === 'ready' ? '重新准备目标' : '立即重试读取';
  $('event-prepare').disabled = $('event-retry').disabled = Boolean(eventController);
  const title = e.mode === 'monad' ? e.title : '本地模拟交易笔数';
  setText('event-card-title', title);
  $('event-mode-badge').textContent = e.mode === 'monad' ? '真实 Monad RPC' : '本地练习';
  $('event-question').textContent = e.mode === 'monad'
    ? '目标：未来 Monad 目标区块的交易笔数落在哪个区间？确认前不会揭示结果。'
    : '目标：本地模拟回合结束时生成的交易笔数落在哪个区间？';
  $('event-red-bound').textContent = `>${e.upper}`; $('event-green-bound').textContent = `${e.lower}–${e.upper}`; $('event-black-bound').textContent = `<${e.lower}`;
  $('event-range').textContent = e.mode === 'monad'
    ? `基准：准备时最近 8 个区块的平均笔数 ${e.baseline}；固定区间由基准派生。绿色表示低价 / 命中回报较高，不代表低概率。`
    : `本地随机事件区间：低于 ${e.lower} 为黑，${e.lower}–${e.upper}（含边界）为绿，高于 ${e.upper} 为红。`;
  $('event-source').textContent = e.mode === 'monad' ? `来源：${e.source} · chainId ${e.chainId} · 开放 ${e.startBlock} / 封盘 ${e.closeBlock} / 目标 ${e.targetBlock}` : '来源：本地模拟器（非链上 TPS）';
  const progress = e.mode === 'monad' ? Math.max(0, Math.min(100, 100 * ((e.headBlock || e.startBlock) - e.startBlock) / Math.max(1, e.targetBlock - e.startBlock)))
    : Math.max(0, Math.min(100, 100 * (e.headBlock || 0) / Math.max(1, e.targetBlock)));
  $('event-progress-bar').style.width = `${progress}%`;
  $('event-progress').textContent = e.mode === 'monad' ? `区块进度 ${e.headBlock ?? e.startBlock} / ${e.targetBlock} · 封盘 ${e.closeBlock}` : `本地模拟进度 ${e.headBlock || 0} / ${e.targetBlock}`;
  if (e.mode === 'monad' && e.status === 'expired') setText('event-observation', '准备规格已过封盘高度；请重新准备目标区块后再下注。');
  else if (e.mode === 'simulation' && state.phase === 'ready') setText('event-observation', '本地事件将在 60 秒回合结束时生成；价格是交易报价，不是结果概率。');
  else if (e.mode === 'simulation') setText('event-observation', state.phase === 'settled' ? `本轮真实模拟结果：${e.txCount} 笔交易。` : '本地模拟事件正在运行。');
  setText('red-upper', e.upper); setText('black-lower', e.lower); setText('green-lower', e.lower); setText('green-upper', e.upper);
  if (monad && e.mode !== 'monad') {
    setText('event-card-title', 'Monad 未来目标区块交易笔数'); $('event-mode-badge').textContent = '待准备';
    setText('event-question', '选择真实数据源后，点击“准备真实事件”读取基准并创建未来目标。准备后、开局前还会再次检查封盘高度。');
    setText('event-source', '来源：Monad Testnet RPC · 未准备目标');
    setText('event-progress', '尚未读取目标区块');
    setText('event-range', '准备后按最近 8 个区块平均交易笔数派生固定区间。绿色表示低价 / 命中回报较高，不代表低概率。');
    $('event-progress-bar').style.width = '0%';
    setText('event-observation', '未准备真实事件；不会使用本地结果代替 Monad 数据。');
  }
}

function renderAutomation() {
  const a = state.automation;
  $('automation-enabled').checked = Boolean(a.enabled);
  $('automation-enabled').disabled = state.phase === 'ready' || state.phase === 'locked' || state.phase === 'settled';
  $('automation-strategy').disabled = state.phase === 'locked' || state.phase === 'settled';
  $('automation-shares').disabled = $('automation-position').disabled = $('automation-edge').disabled = state.phase === 'locked' || state.phase === 'settled';
  for (const [id, value] of [['automation-strategy', a.strategy], ['automation-shares', a.orderShares], ['automation-position', a.maxPosition], ['automation-edge', a.edge]]) {
    const node = $(id); if (document.activeElement !== node) node.value = String(value);
  }
  const d = a.lastDecision;
  setText('automation-decision', d ? `${d.action === 'hold' ? '观望' : d.action === 'buy' ? '已买入' : d.action === 'sell' ? '已卖出' : d.action === 'start' ? '已启用' : d.action === 'stop' ? '已停止' : '待机'}：${d.reason}${d.color ? ` · ${LABELS[d.color]} ${d.shares || ''} 份` : ''}` : '尚未启用。');
  setText('automation-count', `策略实际成交 ${a.tradeCount} 笔 · 不含预览`);
}

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
    title: '本地模拟成交形成的价格，不是结果概率',
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
    return `<tr><td>${esc(participant?.name || t.traderId)}<small>${fmt(t.timeMs / 1000, 1)} 秒</small></td><td><span class="trade-side ${t.side}">${t.comboSide === 'short' ? '开 NO' : t.comboSide === 'cover' ? '平 NO' : t.side === 'buy' ? '买' : '卖'}${t.comboSide ? ` · ${LABELS[t.color]}` : LABELS[t.color]}</span></td><td>${fmt(t.shares, 0)}</td><td>${esc(moneyFmt(t.averagePrice, 4))}</td><td>${esc(moneyFmt(t.fee, 4))}</td><td>${t.side === 'buy' ? '−' : '+'}${esc(moneyFmt(t.total, 3))}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="empty-cell">开场后，这里记录每一笔实际成交。</td></tr>';
}

function drawResults() {
  const key = `${state.round}:${state.phase}:${state.results.length}`;
  if (key === resultKey) return;
  resultKey = key;
  $('record-count').textContent = `${state.results.length} 轮`;
  $('results-list').innerHTML = state.results.length ? state.results.slice(-5).reverse().map(r => `<div class="result-row"><span>#${String(r.round).padStart(2, '0')}</span><span class="color-tag ${r.color}"><i></i>${LABELS[r.color]}盘 <small>${r.eventValue} 笔</small></span><b class="${pnlClass(r.profits.player)}">${signed(r.profits.player)}</b></div>`).join('') : '<p class="empty-message">第一轮，从你的判断开始。</p>';
  $('result').hidden = state.phase !== 'settled';
  if (state.phase === 'settled') {
    const r = state.result;
    $('result').className = `result-box outcome-${r.color}`;
    const source = r.eventMode === 'monad' ? `Monad Testnet 目标区块 ${r.targetBlock} · ${r.eventValue} 笔 · ${r.eventHash || '已验证'}` : `本地模拟事件 · ${r.eventValue} 笔`;
    const standings = (r.ranking || []).map(item => `<li><span>#${item.rank} ${esc(item.name)}</span><b class="${pnlClass(item.profit)}">${signed(item.profit)}</b></li>`).join('');
    $('result').innerHTML = `<div class="result-heading"><span class="result-symbol">${r.color === 'red' ? '↗' : r.color === 'black' ? '↘' : '＝'}</span><strong>${LABELS[r.color]}盘命中 · 本轮已结算</strong></div><span class="result-profit ${pnlClass(r.profits.player)}">${signed(r.profits.player)} <small>积分</small></span><p>你的本轮净盈亏，已包含交易费用。持仓兑付 ${fmt(r.payouts.player)} 积分。</p><p id="event-result-summary">${esc(source)}；区间：黑 &lt; ${r.eventLower}，绿 ${r.eventLower}–${r.eventUpper}（含边界），红 &gt; ${r.eventUpper}。</p><div class="result-ranking"><strong>本轮收益排名</strong><ol id="ranking-list">${standings}</ol></div>`;
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
    $('quote-note').textContent = '本轮份额已按结果兑付，卡片显示到期兑付价。下一轮重新开始。';
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
    try {
      const quote = quoteBudget(state, 'player', color, 50, 'buy');
      $(`compare-${color}`).textContent = quote.shares > 0
        ? `${fmt(quote.shares, 0)}份 · 命中返${fmt(quote.winPayout, 0)}分 · ${fmt(quote.winPayout / quote.total, 2)}×`
        : '50分不足1份';
    } catch { $(`compare-${color}`).textContent = '暂不可报价'; }
  }
}

function render() {
  const player = playerOf(state), stats = participantStats(state, 'player');
  const prices = marketPrices(state), odds = scenarioOdds(state);
  drawBudgetComparisons();
  const trading = state.phase === 'trading', settled = state.phase === 'settled';
  $('balance').textContent = fmt(player.balance);
  $('equity').textContent = fmt(stats.equity);
  $('total-pnl').textContent = `${signed(stats.pnl)} · 预计清仓口径`;
  $('total-pnl').className = pnlClass(stats.pnl);
  $('reserve').textContent = fmt(state.market.cash);
  $('trade-count').textContent = fmt(state.tradeCount, 0);
  const lastSecond = state.trades.filter(t => t.timeMs > state.elapsedMs - 1000 && t.timeMs <= state.elapsedMs).length;
  $('trade-rate').textContent = `${live(state) ? lastSecond : 0} 笔 / 近 1 秒`;
  $('round-label').textContent = state.event.mode === 'monad' ? `第 ${String(state.round).padStart(2, '0')} 轮 / 真实目标区块 ${state.event.targetBlock}` : `第 ${String(state.round).padStart(2, '0')} 轮 / 模拟区块 ${String(state.block).padStart(3, '0')}`;
  $('phase').textContent = { ready: '准备开场', trading: '自由交易中', locked: '已封盘 · 等待结果', settled: '本轮已到期' }[state.phase];
  $('phase').className = `phase-pill ${state.phase}`;
  $('time').textContent = fmt(state.remainingMs / 1000, 1);
  $('window-label').textContent = trading ? `距封盘 ${fmt(Math.max(0, 55000 - state.elapsedMs) / 1000, 1)} 秒` : state.phase === 'locked' ? '买卖与行动均已停止' : '55 秒交易 + 5 秒封盘';
  $('round-action').disabled = live(state) || simulationFailed || state.phase === 'ready' && selectedEventMode === 'monad' && (!preparedSpec || state.event.mode !== 'monad');
  setText('round-action-label', state.phase === 'ready' ? selectedEventMode === 'monad' ? '先准备并检查真实事件' : '开始 60 秒交易' : settled ? '继续下一轮' : state.phase === 'locked' ? '等待到期结算' : '交易进行中');
  $('time-bar').style.width = `${100 * state.remainingMs / state.durationMs}%`;
  $('timer').setAttribute('aria-valuenow', fmt(state.remainingMs / 1000, 1));
  $('timer').classList.toggle('urgent', state.phase === 'locked');
  $('countdown-dial').style.setProperty('--remaining', `${100 * state.remainingMs / state.durationMs}%`);
  $('countdown-dial').classList.toggle('urgent', state.phase === 'locked');
  $('chart-prompt').hidden = state.phase !== 'ready';
  const realEvent = state.event.mode === 'monad';
  $('scenario-note').textContent = settled ? `结果已确认：${state.result.eventValue} 笔交易；市场价格是交易报价，不是事件概率。${realEvent ? '真实事件无校准概率模型。' : '本地模型估计不保证结果。'}` : realEvent ? '真实 Monad 事件暂无校准概率模型，卡片显示“未估计”；份额价格来自本地成交，不是链上概率。' : '本地模拟概率基于当前交易笔数模型估计；市场价格由成交推动，两者都不保证最终结果。';
  document.querySelectorAll('#game .scenario-label').forEach(node => { node.textContent = settled ? '本轮结果' : realEvent ? '真实概率' : '结果场景估计'; });
  document.querySelectorAll('[data-bots]').forEach(b => { b.disabled = live(state); b.classList.toggle('selected', Number(b.dataset.bots) === state.botCount); b.setAttribute('aria-pressed', String(Number(b.dataset.bots) === state.botCount)); });
  document.querySelectorAll('#game [data-color]').forEach(b => { b.classList.toggle('selected', b.dataset.color === selectedColor); b.setAttribute('aria-pressed', String(b.dataset.color === selectedColor)); });
  document.querySelectorAll('#game .price-unit').forEach(node => { node.textContent = settled ? '到期兑付价 · 积分 / 份' : '市场价格 · 积分 / 份'; });
  for (const color of COLORS) {
    $(`price-${color}`).textContent = fmt(prices[color], 3);
    $(`odds-${color}`).textContent = settled ? (state.result.color === color ? '已命中' : '未命中') : realEvent ? '未估计' : percent(odds[color]);
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
  $('noise-label').textContent = realEvent ? settled ? `真实区块 ${state.event.targetBlock}` : '真实事件 · 无本地控场' : settled ? `本地事件 ${state.result.eventValue} 笔` : `本地事件随机扰动 · ±${state.noiseRange}`;
  $('tickets').textContent = `你的行动券 ${player.tickets} / 3 · 可保留不用`;
  $('ticket-dots').querySelectorAll('i').forEach((dot, index) => { dot.classList.toggle('used', index >= player.tickets); });
  $('heat-up').disabled = $('heat-down').disabled = !trading || player.tickets <= 0 || realEvent;
  const preview = actionPreview(state, 1), mapOdds = obj => COLORS.map(c => `${LABELS[c]} ${percent(obj[c])}`).join(' · ');
  $('action-preview-before').textContent = realEvent ? '未估计' : mapOdds(preview.before); $('action-preview-after').textContent = realEvent ? '未估计' : mapOdds(preview.after);
  $('action-preview-note').textContent = realEvent ? '真实链结果不可被本地行动影响。' : preview.reason || '仅为本地场景估计变化，实际事件仍受随机扰动影响。';
  renderEventCard(); renderAutomation();
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
$('round-action').addEventListener('click', async () => {
  try {
    flushTime();
    if (state.phase === 'ready' && selectedEventMode === 'monad') {
      if (!preparedSpec || state.event.mode !== 'monad') { showError('请先准备真实 Monad 事件。'); return; }
      cancelEventWork();
      const observation = await readRealEvent({ preflight: true, force: true });
      if (!observation) return;
      if (observation.headBlock >= preparedSpec.closeBlock || observation.verified || state.event.status !== 'ready') {
        notify('该真实事件已到封盘高度或目标已确认，不能再开局；请重新准备目标区块。'); render(); return;
      }
    }
    if (state.phase === 'ready') { state = startRound(state); notify(selectedEventMode === 'monad' ? '真实事件前置检查通过；积分预测回合已开，等待 Monad 目标区块结算。' : '本轮开始：55 秒内可持续买卖，最后 5 秒封盘。'); }
    else if (state.phase === 'settled') { cancelEventWork(); state = nextRound(state); preparedSpec = null; selectedEventMode = 'simulation'; clearKeys(); notify('已准备下一轮，余额与累计统计保留。点击开始，开启新的 60 秒。'); }
    showError(''); lastNow = performance.now(); persist(); render();
  } catch (error) { showError(error.reason || error.message || '操作未成功。'); render(); }
});

$('event-local').addEventListener('click', () => {
  if (state.phase !== 'ready') return;
  cancelEventWork(); preparedSpec = null; selectedEventMode = 'simulation';
  try { state = configureEvent(state, { mode: 'simulation' }); showError(''); setText('event-observation', '本地模拟事件已选择；将在本轮结束时由本地随机过程生成。'); persist(); render(); }
  catch (error) { showError(error.reason || error.message); }
});
$('event-monad').addEventListener('click', () => { if (state.phase !== 'ready') return; selectedEventMode = 'monad'; showError(''); render(); });
$('event-prepare').addEventListener('click', prepareRealEvent);
$('event-retry').addEventListener('click', () => {
  if (state.phase === 'ready') { selectedEventMode = 'monad'; prepareRealEvent(); }
  else readRealEvent({ force: true });
});

function updateAutomation(patch) {
  try { state = configureAutomation(state, patch); showError(''); persist(); render(); }
  catch (error) { showError(error.reason || error.message); render(); }
}
$('automation-enabled').addEventListener('change', event => updateAutomation({ enabled: event.target.checked }));
$('automation-strategy').addEventListener('change', event => updateAutomation({ strategy: event.target.value }));
$('automation-shares').addEventListener('change', event => updateAutomation({ orderShares: Number(event.target.value) }));
$('automation-position').addEventListener('change', event => updateAutomation({ maxPosition: Number(event.target.value) }));
$('automation-edge').addEventListener('change', event => updateAutomation({ edge: Number(event.target.value) }));
$('rules-link').addEventListener('click', () => { $('rules').open = true; });
$('rules-link-inline').addEventListener('click', () => { $('rules').open = true; });

function freshGame(botCount = state.botCount) {
  cancelEventWork(); preparedSpec = null; selectedEventMode = 'simulation';
  flushTime();
  state = resetGame(freshSeed(), { botCount });
  simulationFailed = false;
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
window.addEventListener('pagehide', () => { cancelEventWork(); try { flushTime(); persist(); } catch { /* Optional save. */ } });
setInterval(() => {
  try {
    const running = live(state);
    flushTime();
    if (running) render();
    if (running && performance.now() - lastPersistAt > 1000) persist();
    if (state.event.mode === 'monad' && live(state) && !pollBusy && performance.now() - lastPollAt >= 2000) readRealEvent();
  }
  catch (error) { simulationFailed = true; showError(`本地进度无法继续：${error.reason || error.message}。请用右上角“重置积分”重新开始。`); }
}, 100);
mountTheme();
render();
mountMarket(mountMonad());
