/** Local-only three-outcome LMSR simulator. Points cannot be redeemed.
 * Immutable reducers; bots run on deterministic ticks, not frames.
 * Local mode ticks every 500 ms and settles on seeded noise, which is a simulation,
 * not secure blockchain randomness. Chain mode ticks once per observed block and
 * settles on the busy-block count read from Monad testnet.
 */
import { EVENT_WINDOW_BLOCKS, EVENT_LOCK_BLOCKS, EVENT_TOLERANCE, BUSY_TX_MIN, CHAIN_BLOCK_MS, baselineFromBlocks, busyPmf, isBusy } from './chain-event.js';
export const COLORS = Object.freeze(['red', 'black', 'green']);
export const ROUND_DURATION_MS = 60000;
export const TRADING_DURATION_MS = 55000;
export const BLOCK_DURATION_MS = 500;
export const POINT_PRECISION = 1000000;

export class GameError extends Error {
  constructor(code, reason) {
    super(reason);
    this.name = 'GameError';
    this.code = code;
    this.reason = reason;
  }
}

const fail = (code, reason) => { throw new GameError(code, reason); };
const copy = value => structuredClone(value);
const emptyPosition = () => ({ red: 0, black: 0, green: 0 });
const units = value => Math.round(value * POINT_PRECISION);
const points = value => value / POINT_PRECISION;
const money = value => points(units(value));
const upUnits = value => Math.max(0, Math.ceil(value * POINT_PRECISION));
const downUnits = value => Math.max(0, Math.floor(value * POINT_PRECISION));
const MAX_RECORDS = 400;
const MAX_HISTORY = 700;
const DEFAULT_B = 150;
const DEFAULT_PRIORS = Object.freeze({ red: 0.45, black: 0.45, green: 0.10 });
const MIN_ROUND_RESERVE = 1;
const MIN_PRIOR = 0.001;

function findTrader(state, id) {
  const trader = state.participants.find(participant => participant.id === id);
  if (!trader) fail('INVALID_TRADER', '找不到这位参与者');
  return trader;
}

function random(state, field = '_rngState') {
  state[field] = (state[field] + 0x6d2b79f5) >>> 0;
  let value = state[field];
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

function marketCost(q, b, priors = DEFAULT_PRIORS) {
  const values = COLORS.map(color => q[color] / b);
  const maximum = Math.max(...values);
  return b * (maximum + Math.log(COLORS.reduce((sum, color, index) =>
    sum + priors[color] * Math.exp(values[index] - maximum), 0)));
}

// Shared by execution quotes and portfolio valuation. Amounts are integer
// micropoints, conservatively rounded in favor of the collateral reserve.
function tradeAmounts(market, color, side, shares) {
  const qAfter = { ...market.q, [color]: market.q[color] + (side === 'buy' ? shares : -shares) };
  const beforeCost = marketCost(market.q, market.b, market.priors);
  const afterCost = marketCost(qAfter, market.b, market.priors);
  const rawGross = side === 'buy' ? afterCost - beforeCost : beforeCost - afterCost;
  // Positive LMSR purchases always have positive cost. At extreme q spreads,
  // subtracting two large C values can lose a tiny difference entirely.
  const grossUnits = side === 'buy' ? Math.max(1, upUnits(rawGross)) : downUnits(rawGross);
  const feeUnits = Math.ceil(grossUnits * market.feeRate);
  const totalUnits = side === 'buy' ? grossUnits + feeUnits : Math.max(0, grossUnits - feeUnits);
  return { qAfter, grossUnits, feeUnits, totalUnits };
}

// One portfolio cannot liquidate each color against the same unmodified q.
// Simulate the actual red -> black -> green sale path, in legal <=1000 chunks.
function liquidationValue(state, trader) {
  let q = { ...state.market.q };
  let receivedUnits = 0;
  for (const color of COLORS) {
    let remaining = trader.holdings[color];
    while (remaining > 0) {
      const shares = Math.min(1000, remaining);
      const sale = tradeAmounts({ ...state.market, q }, color, 'sell', shares);
      receivedUnits += sale.totalUnits;
      q = sale.qAfter;
      remaining -= shares;
    }
  }
  return points(receivedUnits);
}

export function marketPrices(state) {
  if (state.phase === 'settled' && state.result && !state.result.voided) {
    return Object.fromEntries(COLORS.map(color => [color, color === state.result.color ? 1 : 0]));
  }
  const values = COLORS.map(color => state.market.q[color] / state.market.b);
  const maximum = Math.max(...values);
  const weights = COLORS.map((color, index) => (state.market.priors?.[color] ?? 1 / 3) * Math.exp(values[index] - maximum));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return Object.fromEntries(COLORS.map((color, index) => [color, weights[index] / total]));
}

/** Exact discrete probabilities conditional on no further participant actions. */
export function scenarioOdds(state) {
  if (state.phase === 'settled' && state.result) return marketPrices(state);
  if (state.mode === 'chain') return chainOdds(state);
  const odds = emptyPosition();
  for (let noise = -state.noiseRange; noise <= state.noiseRange; noise += 1) {
    const finalHeat = state.heat + noise;
    odds[finalHeat > state.greenBand[1] ? 'red' : finalHeat < state.greenBand[0] ? 'black' : 'green'] += 1;
  }
  const count = 2 * state.noiseRange + 1;
  return Object.fromEntries(COLORS.map(color => [color, odds[color] / count]));
}

const colorOf = (state, finalHeat) => finalHeat > state.greenBand[1] ? 'red' : finalHeat < state.greenBand[0] ? 'black' : 'green';

// Exact odds for the busy-block event: blocks already seen are fixed, the rest
// are modeled as independent draws at the baseline rate. Assumes no further actions.
function chainOdds(state) {
  const event = state.event;
  if (!event) return Object.fromEntries(COLORS.map(color => [color, 1 / 3]));
  const remaining = event.windowBlocks - event.observed;
  const pmf = busyPmf(remaining, event.rate);
  const odds = emptyPosition();
  for (let more = 0; more <= remaining; more += 1) {
    odds[colorOf(state, state.heat + event.busy + more - event.baseline)] += pmf[more];
  }
  return odds;
}

// Chain mode only: opening prices follow the scenario odds. Local rounds keep their fixed
// priors, since unobservable local noise would otherwise leave bots nothing to trade on.
// Only valid while no shares exist (ready phase).
function applyPrior(state) {
  if (state.mode !== 'chain') return;
  const odds = scenarioOdds(state);
  state.market.priors = Object.fromEntries(COLORS.map(color => [color, Math.max(odds[color], MIN_PRIOR)]));
}

export function participantStats(state, traderId) {
  const trader = findTrader(state, traderId);
  const prices = marketPrices(state);
  const markPositionValue = COLORS.reduce((sum, color) => sum + trader.holdings[color] * prices[color], 0);
  const positionValue = liquidationValue(state, trader);
  const basis = COLORS.reduce((sum, color) => sum + trader.costBasis[color], 0);
  const equity = trader.balance + positionValue;
  return {
    equity, pnl: equity - 1000, realizedPnl: trader.realizedPnl,
    unrealizedPnl: positionValue - basis, positionValue, markPositionValue,
    maxDrawdown: trader.maxDrawdown, tradeCount: trader.tradeCount,
  };
}

function updateStats(state) {
  for (const trader of state.participants) {
    const equity = trader.balance + liquidationValue(state, trader);
    trader.peakEquity = Math.max(trader.peakEquity, equity);
    if (trader.peakEquity > 0) trader.maxDrawdown = Math.max(trader.maxDrawdown, (trader.peakEquity - equity) / trader.peakEquity);
  }
}

function event(state, type, message, detail = {}) {
  state.events.push({ ...detail, id: state._nextEventId++, timeMs: state.elapsedMs, type, message });
  if (state.events.length > MAX_RECORDS) state.events.splice(0, state.events.length - MAX_RECORDS);
}

function snapshot(state) {
  state.history.push({ timeMs: state.elapsedMs, heat: state.heat, prices: marketPrices(state), block: state.block });
  if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY);
}

function clock(state, timeMs) {
  state.elapsedMs = timeMs;
  state.remainingMs = Math.max(0, state.durationMs - timeMs);
}

function participant(id, name, strategy) {
  return {
    id, name, strategy, balance: 1000, holdings: emptyPosition(), costBasis: emptyPosition(),
    realizedPnl: 0, tickets: 3, tradeCount: 0, peakEquity: 1000, maxDrawdown: 0,
  };
}

export function createGame(seed = 20261017, options = {}) {
  if (typeof seed !== 'number' || !Number.isFinite(seed)) fail('INVALID_SEED', '种子必须是有限数字');
  const botCount = options.botCount ?? 2;
  if (botCount !== 2 && botCount !== 20) fail('INVALID_BOT_COUNT', '请选择 2 或 20 位 Bot');
  const mode = options.mode ?? 'local';
  if (mode !== 'local' && mode !== 'chain') fail('INVALID_MODE', '请选择本地模拟或区块事件');
  const chain = mode === 'chain';
  const normalizedSeed = Math.trunc(seed) >>> 0;
  const participants = [participant('player', '你', 'player')];
  for (let index = 0; index < botCount; index += 1) {
    const momentum = index % 2 === 0;
    participants.push(participant(index === 0 ? 'momentum' : index === 1 ? 'value' : `bot-${index + 1}`,
      `${momentum ? '动量' : '价值'} Bot${index > 1 ? ` ${index + 1}` : ''}`, momentum ? 'momentum' : 'value'));
  }
  const state = {
    schemaVersion: 2, mode, event: null, heatLimit: chain ? EVENT_TOLERANCE : null,
    phase: 'ready', round: 1, seed: normalizedSeed, botCount,
    durationMs: chain ? EVENT_WINDOW_BLOCKS * CHAIN_BLOCK_MS : ROUND_DURATION_MS,
    tradingDurationMs: chain ? EVENT_LOCK_BLOCKS * CHAIN_BLOCK_MS : TRADING_DURATION_MS,
    elapsedMs: 0, remainingMs: chain ? EVENT_WINDOW_BLOCKS * CHAIN_BLOCK_MS : ROUND_DURATION_MS, block: 0,
    heat: 100, baseline: 100, greenBand: chain ? [100 - EVENT_TOLERANCE, 100 + EVENT_TOLERANCE] : [98, 102], actionLimit: 3,
    noiseRange: chain ? 0 : participants.length * 3 + 3,
    market: { q: emptyPosition(), cash: 1000, initialReserve: 1000, b: DEFAULT_B, feeRate: 0.003, priors: { ...DEFAULT_PRIORS } },
    participants, initialTotal: participants.length * 1000 + 1000,
    history: [], events: [], trades: [], results: [], result: null, tradeCount: 0,
    _rngState: normalizedSeed, _noiseRngState: (normalizedSeed ^ 0x9e3779b9) >>> 0,
    _nextTickMs: BLOCK_DURATION_MS, _nextEventId: 1, _nextTradeId: 1,
    _roundStartBalances: Object.fromEntries(participants.map(trader => [trader.id, trader.balance])),
  };
  applyPrior(state);
  snapshot(state);
  event(state, 'round_ready', chain ? '区块事件市场已准备：等待读取基准区块；命中每份兑付 1 积分，积分不可兑换'
    : '本地份额市场已准备：命中每份兑付 1 积分，积分不可兑换');
  return state;
}

export function resetGame(seed = 20261017, options = {}) {
  return createGame(seed, options);
}

export function startRound(state) {
  if (state.phase !== 'ready') fail('INVALID_PHASE', '只有准备中的回合可以开始');
  if (state.market.cash < MIN_ROUND_RESERVE) fail('RESERVE_EXHAUSTED', '做市储备不足 1 积分，请重置试玩');
  if (state.mode === 'chain' && !state.event) fail('EVENT_NOT_ARMED', '尚未读取基准区块，不能开始区块事件');
  const next = copy(state);
  next.phase = 'trading';
  next._roundStartBalances = Object.fromEntries(next.participants.map(trader => [trader.id, trader.balance]));
  if (next.mode === 'chain') {
    const { windowBlocks, lockBlocks, startBlock, baseline } = next.event;
    event(next, 'round_started', `事件开始：从区块 #${startBlock + 1} 起统计 ${windowBlocks} 个区块，基准 ${baseline} 个繁忙块；前 ${lockBlocks} 个区块可交易`);
  } else event(next, 'round_started', '交易开始：前 55 秒可买卖和行动，最后 5 秒封盘等待结算');
  return next;
}

/** Quote uses no RNG and never mutates state, including rejected previews. */
export function quoteTrade(state, traderId, color, side, shares) {
  const trader = findTrader(state, traderId);
  if (!COLORS.includes(color)) fail('INVALID_COLOR', '请选择红、黑或绿');
  if (side !== 'buy' && side !== 'sell') fail('INVALID_SIDE', '请选择买入或卖出');
  if (!Number.isInteger(shares) || shares < 1 || shares > 1000) fail('INVALID_SHARES', '份数必须是 1 至 1000 的整数');
  const prices = marketPrices(state);
  const quote = {
    side, color, shares, spotPrice: prices[color], averagePrice: 0, gross: 0,
    fee: 0, total: 0, pricesAfter: prices, winPayout: 0, winProfit: 0, roi: 0,
    canExecute: false, reason: '', code: '',
  };
  if (side === 'sell' && trader.holdings[color] < shares) {
    return { ...quote, reason: '持仓不足，不能卖空', code: 'INSUFFICIENT_HOLDINGS' };
  }
  const { qAfter, grossUnits, feeUnits, totalUnits } = tradeAmounts(state.market, color, side, shares);
  quote.gross = points(grossUnits);
  quote.fee = points(feeUnits);
  quote.total = points(totalUnits);
  quote.averagePrice = quote.gross / shares;
  quote.pricesAfter = marketPrices({ market: { ...state.market, q: qAfter } });
  if (side === 'buy') {
    quote.winPayout = shares;
    quote.winProfit = shares - quote.total;
    quote.roi = quote.total > 0 ? quote.winProfit / quote.total : 0;
  }
  if (state.phase !== 'trading' || state.elapsedMs >= state.tradingDurationMs) {
    quote.reason = state.phase === 'ready' ? '请先开始本轮交易' : '当前已封盘，不能买卖';
    quote.code = 'MARKET_CLOSED';
  } else if (side === 'buy' && units(trader.balance) < totalUnits) {
    quote.reason = '可用积分不足';
    quote.code = 'INSUFFICIENT_BALANCE';
  } else {
    const cashAfter = units(state.market.cash) + (side === 'buy' ? totalUnits : -totalUnits);
    const largestPayout = Math.max(...Object.values(qAfter)) * POINT_PRECISION;
    if (cashAfter < largestPayout || cashAfter < 0) {
      quote.reason = '做市储备不足以覆盖所有可能兑付，交易未执行';
      quote.code = 'INSUFFICIENT_RESERVE';
    } else quote.canExecute = true;
  }
  return quote;
}

function applyTrade(state, traderId, quote) {
  const trader = findTrader(state, traderId);
  const { color, side, shares, total } = quote;
  const totalUnits = units(total);
  let removedBasis = 0;
  let realizedChange = 0;
  if (side === 'buy') {
    trader.balance = points(units(trader.balance) - totalUnits);
    trader.costBasis[color] = money(trader.costBasis[color] + total);
    trader.holdings[color] += shares;
    state.market.q[color] += shares;
    state.market.cash = points(units(state.market.cash) + totalUnits);
  } else {
    const removedUnits = shares === trader.holdings[color] ? units(trader.costBasis[color])
      : Math.floor(units(trader.costBasis[color]) * shares / trader.holdings[color]);
    removedBasis = points(removedUnits);
    realizedChange = points(totalUnits - removedUnits);
    trader.balance = points(units(trader.balance) + totalUnits);
    trader.costBasis[color] = points(units(trader.costBasis[color]) - removedUnits);
    trader.realizedPnl = money(trader.realizedPnl + realizedChange);
    trader.holdings[color] -= shares;
    state.market.q[color] -= shares;
    state.market.cash = points(units(state.market.cash) - totalUnits);
  }
  trader.tradeCount += 1;
  state.tradeCount += 1;
  const entry = {
    id: state._nextTradeId++, timeMs: state.elapsedMs, traderId, participantId: traderId,
    color, side, shares, gross: quote.gross, fee: quote.fee, total,
    averagePrice: quote.averagePrice, spotPrice: quote.spotPrice,
    removedBasis, realizedPnl: realizedChange,
  };
  state.trades.push(entry);
  if (state.trades.length > MAX_RECORDS) state.trades.splice(0, state.trades.length - MAX_RECORDS);
  event(state, 'trade', `${trader.name}${side === 'buy' ? '买入' : '卖出'} ${shares} 份${{ red: '红', black: '黑', green: '绿' }[color]}`, entry);
  updateStats(state);
  snapshot(state);
}

export function executeTrade(state, traderId, color, side, shares) {
  const quote = quoteTrade(state, traderId, color, side, shares);
  if (!quote.canExecute) fail(quote.code || 'TRADE_REJECTED', quote.reason);
  const next = copy(state);
  applyTrade(next, traderId, quote);
  return next;
}

const shiftAllowed = (state, delta) => !state.heatLimit || Math.abs(state.heat + delta - state.baseline) <= state.heatLimit;

function applyAction(state, trader, delta) {
  trader.tickets -= 1;
  state.heat += delta;
  event(state, 'action', `${trader.name}${delta > 0 ? '加热 +1' : '降温 −1'}`, { traderId: trader.id, participantId: trader.id, delta, heat: state.heat });
  snapshot(state);
  updateStats(state);
}

export function playerAction(state, delta) {
  if (state.phase !== 'trading' || state.elapsedMs >= state.tradingDurationMs) fail('ACTION_CLOSED', '当前已封盘，不能行动');
  if (delta !== 1 && delta !== -1) fail('INVALID_ACTION', '行动只支持 +1 加热或 −1 降温');
  if (findTrader(state, 'player').tickets <= 0) fail('NO_TICKETS', '本轮行动券已用完');
  if (!shiftAllowed(state, delta)) fail('HEAT_LIMIT', `全场热度最多偏离基准 ±${state.heatLimit}`);
  const next = copy(state);
  applyAction(next, findTrader(next, 'player'), delta);
  return next;
}

function botDecision(state, bot) {
  const activity = random(state);
  if (activity > (state.botCount === 20 ? 0.38 : 0.67)) return;
  const prices = marketPrices(state);
  const odds = scenarioOdds(state);
  const previous = state.history.findLast(point => point.timeMs <= state.elapsedMs - 3000) ?? state.history[0];
  const forecast = { ...odds };
  if (bot.strategy === 'momentum') {
    const trend = prices.red - (previous?.prices.red ?? prices.red);
    forecast.red = Math.max(0.005, odds.red + Math.max(-0.15, Math.min(0.15, trend * 2.4)));
    forecast.black = Math.max(0.005, odds.black - Math.max(-0.15, Math.min(0.15, trend * 2.4)));
    const sum = COLORS.reduce((total, color) => total + forecast[color], 0);
    for (const color of COLORS) forecast[color] /= sum;
  }
  const ranked = COLORS.map(color => ({ color, edge: forecast[color] - prices[color] }));
  const sells = ranked.filter(item => bot.holdings[item.color] > 0 && item.edge < -0.025)
    .sort((a, b) => a.edge - b.edge);
  const buy = [...ranked].sort((a, b) => b.edge - a.edge)[0];
  const sale = sells[0];
  const side = sale ? 'sell' : 'buy';
  const color = sale?.color ?? buy.color;
  const desired = 5 + Math.floor(random(state) * (state.botCount === 20 ? 13 : 22));
  const shares = side === 'sell' ? Math.min(desired, bot.holdings[color]) : desired;
  if (sale || (buy.edge > 0.017 && bot.holdings[color] < 160)) {
    const quote = quoteTrade(state, bot.id, color, side, shares);
    if (quote.canExecute && (side === 'sell' || quote.total <= Math.min(bot.balance * 0.12, 70))) applyTrade(state, bot.id, quote);
  }
  if (bot.tickets > 0 && state.elapsedMs >= 10000 && random(state) < 0.025) {
    const preference = bot.holdings.red - bot.holdings.black;
    const delta = preference !== 0 ? Math.sign(preference)
      : bot.holdings.green > 0 && state.heat !== state.baseline ? -Math.sign(state.heat - state.baseline) : 0;
    if (delta !== 0 && shiftAllowed(state, delta)) applyAction(state, bot, delta);
  }
}

const drawNoise = state => Math.floor(random(state, '_noiseRngState') * (2 * state.noiseRange + 1)) - state.noiseRange;

function settle(state, noise) {
  const actionHeat = state.heat;
  const closingPrices = marketPrices(state);
  const finalHeat = actionHeat + noise;
  const color = colorOf(state, finalHeat);
  const totalPayout = state.participants.reduce((sum, trader) => sum + trader.holdings[color], 0);
  if (units(state.market.cash) < totalPayout * POINT_PRECISION) fail('INSUFFICIENT_RESERVE', '结算储备不足，无法兑付');
  const payouts = {};
  const profits = {};
  for (const trader of state.participants) {
    const payout = trader.holdings[color];
    const residualBasis = COLORS.reduce((sum, item) => sum + units(trader.costBasis[item]), 0);
    trader.balance = points(units(trader.balance) + payout * POINT_PRECISION);
    trader.realizedPnl = points(units(trader.realizedPnl) + payout * POINT_PRECISION - residualBasis);
    payouts[trader.id] = payout;
    profits[trader.id] = money(trader.balance - state._roundStartBalances[trader.id]);
    trader.holdings = emptyPosition();
    trader.costBasis = emptyPosition();
  }
  state.market.cash = points(units(state.market.cash) - totalPayout * POINT_PRECISION);
  state.market.q = emptyPosition();
  state.phase = 'settled';
  state.heat = finalHeat;
  state.result = { round: state.round, color, finalHeat, actionHeat, noise, closingPrices, payouts, profits, totalPayout, tradeCount: state.tradeCount, marketCash: state.market.cash };
  if (state.mode === 'chain') {
    const { startBlock, windowBlocks, busy, baseline } = state.event;
    state.result.event = { startBlock, endBlock: startBlock + windowBlocks, busy, baseline };
  }
  state.results.push(copy(state.result));
  event(state, 'settled', `结算完成：${{ red: '红', black: '黑', green: '绿' }[color]}命中，每份兑付 1 积分`, { color, noise, finalHeat, totalPayout });
  updateStats(state);
  snapshot(state);
}

function runBots(state) {
  const bots = state.participants.slice(1);
  const offset = (state.block - 1) % bots.length;
  for (let index = 0; index < bots.length; index += 1) botDecision(state, bots[(index + offset) % bots.length]);
}

export function advance(state, dtMs) {
  if (typeof dtMs !== 'number' || !Number.isFinite(dtMs) || dtMs < 0) fail('INVALID_TIME', '时间增量必须是非负有限数字');
  if (state.mode === 'chain' || (state.phase !== 'trading' && state.phase !== 'locked') || dtMs === 0) return state;
  const next = copy(state);
  const end = Math.min(next.durationMs, next.elapsedMs + dtMs);
  while (next._nextTickMs <= end) {
    clock(next, next._nextTickMs);
    next.block += 1;
    next._nextTickMs += BLOCK_DURATION_MS;
    if (next.elapsedMs >= next.tradingDurationMs && next.phase === 'trading') {
      next.phase = 'locked';
      event(next, 'locked', '最后 5 秒已封盘：停止交易和行动，等待独立情景扰动');
    }
    if (next.phase === 'trading') runBots(next);
    updateStats(next);
    snapshot(next);
  }
  clock(next, end);
  if (end >= next.durationMs) settle(next, drawNoise(next));
  return next;
}

/** Arms the event from the most recent contiguous blocks; the window starts after the last one. */
export function armChainEvent(state, blocks) {
  if (state.mode !== 'chain') fail('NOT_CHAIN_EVENT', '只有区块事件场可以读取基准区块');
  if (state.phase !== 'ready') fail('INVALID_PHASE', '只有准备中的回合可以更新基准');
  if (!Array.isArray(blocks) || !blocks.every(block => Number.isSafeInteger(block?.number) && Number.isInteger(block.tx) && block.tx >= 0)) {
    fail('INVALID_BLOCKS', '区块数据无效');
  }
  const baseline = baselineFromBlocks(blocks);
  if (!baseline) fail('BASELINE_TOO_SHORT', '基准区块不足，暂不能开始');
  const next = copy(state);
  next.event = {
    windowBlocks: EVENT_WINDOW_BLOCKS, lockBlocks: EVENT_LOCK_BLOCKS, tolerance: EVENT_TOLERANCE, busyTxMin: BUSY_TX_MIN,
    startBlock: blocks.at(-1).number, observed: 0, busy: 0, series: [],
    rate: baseline.rate, baseline: baseline.expected, sampleBlocks: baseline.sampleBlocks, sampleBusy: baseline.busyBlocks,
  };
  next.history = [];
  applyPrior(next);
  snapshot(next);
  return next;
}

/** Feeds consecutive blocks after the start block; one block is one bot tick and one clock step. */
export function ingestBlocks(state, blocks) {
  if (state.mode !== 'chain' || !state.event) fail('NOT_CHAIN_EVENT', '当前不是区块事件场');
  if (state.phase !== 'trading' && state.phase !== 'locked') return state;
  const first = state.event.startBlock + state.event.observed + 1;
  const fresh = blocks.filter(block => block.number >= first);
  if (!fresh.length) return state;
  fresh.forEach((block, index) => {
    if (block.number !== first + index) fail('BLOCK_GAP', `区块不连续：期望 #${first + index}，收到 #${block.number}`);
    if (!Number.isInteger(block.tx) || block.tx < 0) fail('INVALID_BLOCKS', '区块交易数无效');
  });
  const next = copy(state);
  const e = next.event;
  for (const block of fresh) {
    if (next.phase === 'settled') break;
    e.observed += 1;
    if (isBusy(block.tx)) e.busy += 1;
    e.series.push(e.busy);
    clock(next, e.observed * CHAIN_BLOCK_MS);
    next.block = e.observed;
    if (e.observed >= e.lockBlocks && next.phase === 'trading') {
      next.phase = 'locked';
      event(next, 'locked', `已封盘：第 ${e.lockBlocks} 个区块已出，停止交易和行动，等待统计窗口结束`);
    }
    if (next.phase === 'trading') runBots(next);
    updateStats(next);
    snapshot(next);
    if (e.observed >= e.windowBlocks) settle(next, e.busy - e.baseline);
  }
  return next;
}

/** Ends a chain round whose data stopped; open positions are refunded at their cost basis (fees included). */
export function voidRound(state, reason = '链上数据中断') {
  if (state.mode !== 'chain') fail('NOT_CHAIN_EVENT', '当前不是区块事件场');
  if (state.phase !== 'trading' && state.phase !== 'locked') fail('INVALID_PHASE', '只有进行中的回合可以作废');
  reason = String(reason).replace(/[。.]+$/, '');
  const next = copy(state);
  let refundUnits = 0;
  for (const trader of next.participants) {
    const basisUnits = COLORS.reduce((sum, color) => sum + units(trader.costBasis[color]), 0);
    refundUnits += basisUnits;
    trader.balance = points(units(trader.balance) + basisUnits);
    trader.holdings = emptyPosition();
    trader.costBasis = emptyPosition();
  }
  if (units(next.market.cash) < refundUnits) fail('INSUFFICIENT_RESERVE', '做市储备不足，无法退回成本');
  next.market.cash = points(units(next.market.cash) - refundUnits);
  next.market.q = emptyPosition();
  const profits = Object.fromEntries(next.participants.map(trader => [trader.id, money(trader.balance - next._roundStartBalances[trader.id])]));
  next.phase = 'settled';
  next.result = {
    voided: true, reason, round: next.round, profits, refunded: points(refundUnits),
    observed: next.event.observed, tradeCount: next.tradeCount, marketCash: next.market.cash,
  };
  event(next, 'voided', `本轮作废：${reason}。未平仓份额已按含费成本退回，已平仓交易的损益保留`, { reason });
  updateStats(next);
  snapshot(next);
  return next;
}

export function nextRound(state) {
  if (state.phase !== 'settled') fail('ROUND_NOT_SETTLED', '请先完成当前回合');
  if (state.market.cash < MIN_ROUND_RESERVE) fail('RESERVE_EXHAUSTED', '做市储备不足 1 积分，请重置试玩');
  const next = copy(state);
  next.round += 1;
  next.phase = 'ready';
  next.heat = next.baseline;
  next.elapsedMs = 0;
  next.remainingMs = next.durationMs;
  next.block = 0;
  next.tradeCount = 0;
  next.result = null;
  next.market.q = emptyPosition();
  next.market.b = Math.min(DEFAULT_B, 0.8 * next.market.cash / Math.log(10));
  next.history = [];
  next.events = [];
  next.trades = [];
  next.event = null;
  next._nextTickMs = BLOCK_DURATION_MS;
  for (const trader of next.participants) {
    trader.tickets = next.actionLimit;
    trader.holdings = emptyPosition();
    trader.costBasis = emptyPosition();
  }
  next._roundStartBalances = Object.fromEntries(next.participants.map(trader => [trader.id, trader.balance]));
  applyPrior(next);
  snapshot(next);
  event(next, 'round_ready', `第 ${next.round} 轮已准备；余额、做市储备和累计盈亏保留`);
  return next;
}
