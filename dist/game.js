/** Local-only three-outcome LMSR simulator. Points cannot be redeemed.
 * Immutable reducers; bots run on deterministic 500 ms ticks, not frames.
 * Seeded settlement noise is a simulation, not secure blockchain randomness.
 */
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
  if (state.phase === 'settled' && state.result) {
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
  const odds = emptyPosition();
  for (let noise = -state.noiseRange; noise <= state.noiseRange; noise += 1) {
    const finalHeat = state.heat + noise;
    odds[finalHeat > state.greenBand[1] ? 'red' : finalHeat < state.greenBand[0] ? 'black' : 'green'] += 1;
  }
  const count = 2 * state.noiseRange + 1;
  return Object.fromEntries(COLORS.map(color => [color, odds[color] / count]));
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
  const normalizedSeed = Math.trunc(seed) >>> 0;
  const participants = [participant('player', '你', 'player')];
  for (let index = 0; index < botCount; index += 1) {
    const momentum = index % 2 === 0;
    participants.push(participant(index === 0 ? 'momentum' : index === 1 ? 'value' : `bot-${index + 1}`,
      `${momentum ? '动量' : '价值'} Bot${index > 1 ? ` ${index + 1}` : ''}`, momentum ? 'momentum' : 'value'));
  }
  const state = {
    schemaVersion: 2, phase: 'ready', round: 1, seed: normalizedSeed, botCount,
    durationMs: ROUND_DURATION_MS, tradingDurationMs: TRADING_DURATION_MS,
    elapsedMs: 0, remainingMs: ROUND_DURATION_MS, block: 0,
    heat: 100, baseline: 100, greenBand: [98, 102], actionLimit: 3,
    noiseRange: participants.length * 3 + 3,
    market: { q: emptyPosition(), cash: 1000, initialReserve: 1000, b: DEFAULT_B, feeRate: 0.003, priors: { ...DEFAULT_PRIORS } },
    participants, initialTotal: participants.length * 1000 + 1000,
    history: [], events: [], trades: [], results: [], result: null, tradeCount: 0,
    _rngState: normalizedSeed, _noiseRngState: (normalizedSeed ^ 0x9e3779b9) >>> 0,
    _nextTickMs: BLOCK_DURATION_MS, _nextEventId: 1, _nextTradeId: 1,
    _roundStartBalances: Object.fromEntries(participants.map(trader => [trader.id, trader.balance])),
  };
  snapshot(state);
  event(state, 'round_ready', '本地份额市场已准备：命中每份兑付 1 积分，积分不可兑换');
  return state;
}

export function resetGame(seed = 20261017, options = {}) {
  return createGame(seed, options);
}

export function startRound(state) {
  if (state.phase !== 'ready') fail('INVALID_PHASE', '只有准备中的回合可以开始');
  if (state.market.cash < MIN_ROUND_RESERVE) fail('RESERVE_EXHAUSTED', '做市储备不足 1 积分，请重置试玩');
  const next = copy(state);
  next.phase = 'trading';
  next._roundStartBalances = Object.fromEntries(next.participants.map(trader => [trader.id, trader.balance]));
  event(next, 'round_started', '交易开始：前 55 秒可买卖和行动，最后 5 秒封盘等待结算');
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
    if (preference !== 0) applyAction(state, bot, Math.sign(preference));
    else if (bot.holdings.green > 0 && state.heat !== state.baseline) applyAction(state, bot, -Math.sign(state.heat - state.baseline));
  }
}

function settle(state) {
  const actionHeat = state.heat;
  const closingPrices = marketPrices(state);
  const noise = Math.floor(random(state, '_noiseRngState') * (2 * state.noiseRange + 1)) - state.noiseRange;
  const finalHeat = actionHeat + noise;
  const color = finalHeat > state.greenBand[1] ? 'red' : finalHeat < state.greenBand[0] ? 'black' : 'green';
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
  state.results.push(copy(state.result));
  event(state, 'settled', `结算完成：${{ red: '红', black: '黑', green: '绿' }[color]}命中，每份兑付 1 积分`, { color, noise, finalHeat, totalPayout });
  updateStats(state);
  snapshot(state);
}

export function advance(state, dtMs) {
  if (typeof dtMs !== 'number' || !Number.isFinite(dtMs) || dtMs < 0) fail('INVALID_TIME', '时间增量必须是非负有限数字');
  if ((state.phase !== 'trading' && state.phase !== 'locked') || dtMs === 0) return state;
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
    if (next.phase === 'trading') {
      const bots = next.participants.slice(1);
      const offset = (next.block - 1) % bots.length;
      for (let index = 0; index < bots.length; index += 1) botDecision(next, bots[(index + offset) % bots.length]);
    }
    updateStats(next);
    snapshot(next);
  }
  clock(next, end);
  if (end >= next.durationMs) settle(next);
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
  next._nextTickMs = BLOCK_DURATION_MS;
  for (const trader of next.participants) {
    trader.tickets = next.actionLimit;
    trader.holdings = emptyPosition();
    trader.costBasis = emptyPosition();
  }
  next._roundStartBalances = Object.fromEntries(next.participants.map(trader => [trader.id, trader.balance]));
  snapshot(next);
  event(next, 'round_ready', `第 ${next.round} 轮已准备；余额、做市储备和累计盈亏保留`);
  return next;
}
