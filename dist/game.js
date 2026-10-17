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
const SIM_EVENT = Object.freeze({ mode: 'simulation', title: '未来目标区块交易笔数', startBlock: 0, closeBlock: 110,
  targetBlock: 120, headBlock: 0, baseline: 100, lower: 98, upper: 102, txCount: null, status: 'ready', source: '本地模拟事件' });
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
  if (state.event?.mode === 'monad') return { red: 1 / 3, black: 1 / 3, green: 1 / 3 };
  const odds = emptyPosition();
  for (let noise = -state.noiseRange; noise <= state.noiseRange; noise += 1) {
    const pressure = Math.max(-3, Math.min(3, state.heat - state.baseline));
    const projectedCount = Math.max(0, Math.round(state.event.baseline + pressure * 3) + noise);
    odds[projectedCount > state.event.upper ? 'red' : projectedCount < state.event.lower ? 'black' : 'green'] += 1;
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
    schemaVersion: 3, mode, heatLimit: chain ? EVENT_TOLERANCE : null,
    phase: 'ready', round: 1, seed: normalizedSeed, botCount,
    durationMs: chain ? EVENT_WINDOW_BLOCKS * CHAIN_BLOCK_MS : ROUND_DURATION_MS,
    tradingDurationMs: chain ? EVENT_LOCK_BLOCKS * CHAIN_BLOCK_MS : TRADING_DURATION_MS,
    elapsedMs: 0, remainingMs: chain ? EVENT_WINDOW_BLOCKS * CHAIN_BLOCK_MS : ROUND_DURATION_MS, block: 0,
    heat: 100, baseline: 100, greenBand: chain ? [100 - EVENT_TOLERANCE, 100 + EVENT_TOLERANCE] : [98, 102], actionLimit: 3,
    noiseRange: chain ? 0 : participants.length * 3 + 3,
    market: { q: emptyPosition(), cash: 1000, initialReserve: 1000, b: DEFAULT_B, feeRate: 0.003, priors: { ...DEFAULT_PRIORS } },
    participants, initialTotal: participants.length * 1000 + 1000,
    history: [], events: [], trades: [], results: [], result: null, tradeCount: 0,
    event: chain ? null : { ...SIM_EVENT }, _rngState: normalizedSeed, _noiseRngState: (normalizedSeed ^ 0x9e3779b9) >>> 0,
    _eventRngState: (normalizedSeed ^ 0x85ebca6b) >>> 0,
    automation: { enabled: false, strategy: 'value', orderShares: 10, maxPosition: 150, edge: 0.04, tradeCount: 0,
      lastDecision: { timeMs: 0, action: 'idle', reason: '尚未启用' }, decisions: [] },
    _nextAutomationMs: 1000, _nextTickMs: BLOCK_DURATION_MS, _nextEventId: 1, _nextTradeId: 1,
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

export function configureEvent(state, spec) {
  if (state.mode !== 'local') fail('NOT_LOCAL_EVENT', 'Monad目标区块模式只可用于本地事件回合');
  if (state.phase !== 'ready') fail('INVALID_PHASE', '只有准备中的回合可以更换事件');
  if (spec?.mode === 'simulation') {
    const next = copy(state);
    next.event = { ...SIM_EVENT };
    event(next, 'event_configured', '已切换到本地模拟事件');
    return next;
  }
  if (!spec || spec.mode !== 'monad' || spec.chainId !== 10143 || !Number.isSafeInteger(spec.startBlock) ||
      !Number.isSafeInteger(spec.closeBlock) || !Number.isSafeInteger(spec.targetBlock) ||
      spec.closeBlock < spec.startBlock || spec.targetBlock <= spec.closeBlock ||
      !Number.isFinite(spec.baseline) || !Number.isSafeInteger(spec.lower) || !Number.isSafeInteger(spec.upper) ||
      spec.lower < 0 || spec.upper <= spec.lower || !Number.isSafeInteger(spec.confirmations) || spec.confirmations < 1 ||
      typeof spec.title !== 'string' || typeof spec.source !== 'string') {
    fail('INVALID_EVENT_SPEC', '真实事件规格无效，请重新读取 Monad 目标区块');
  }
  const next = copy(state);
  next.event = { ...spec, mode: 'monad', headBlock: spec.startBlock, txCount: null, blockHash: null, status: 'ready' };
  event(next, 'event_configured', `已配置真实事件：${spec.title}`, { targetBlock: spec.targetBlock, lower: spec.lower, upper: spec.upper });
  return next;
}

function classifyEvent(eventSpec, txCount) {
  return txCount > eventSpec.upper ? 'red' : txCount < eventSpec.lower ? 'black' : 'green';
}

export function observeEvent(state, observation) {
  if (state.mode !== 'local') fail('NOT_LOCAL_EVENT', '忙区块事件请使用 ingestBlocks 记录');
  if (state.phase === 'settled') return state;
  const spec = state.event;
  if (spec.mode !== 'monad' || !observation || observation.mode !== 'monad' ||
      (observation.chainId !== undefined && observation.chainId !== spec.chainId) ||
      !Number.isSafeInteger(observation.headBlock) || observation.headBlock < spec.headBlock) {
    fail('INVALID_EVENT_OBSERVATION', '事件观察与当前 Monad 目标不匹配');
  }
  const next = copy(state);
  next.event.headBlock = observation.headBlock;
  if (next.phase === 'ready' && observation.headBlock >= spec.closeBlock && observation.verified !== true) {
    next.event.status = 'expired';
    return next;
  }
  if (observation.headBlock >= spec.closeBlock && next.phase === 'trading') {
    next.phase = 'locked';
    next.automation.enabled = false;
    recordDecision(next, 'stop', '真实事件达到封盘区块，自动策略已停止');
    event(next, 'locked', '已到真实事件封盘区块，停止交易并等待目标区块确认');
  }
  if (observation.verified === true) {
    if (observation.chainId !== spec.chainId || observation.blockNumber !== spec.targetBlock || observation.headBlock < spec.targetBlock + spec.confirmations ||
        !Number.isSafeInteger(observation.txCount) || observation.txCount < 0 ||
        typeof observation.blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(observation.blockHash)) {
      fail('INVALID_EVENT_OBSERVATION', '目标区块结果缺少有效区块号、交易笔数、哈希或确认数');
    }
    if (next.phase === 'trading') {
      next.phase = 'locked';
      next.automation.enabled = false;
      recordDecision(next, 'stop', '目标区块已确认，自动策略已停止');
      event(next, 'locked', '目标区块已确认，停止交易并按链上笔数结算');
    }
    next.event = { ...next.event, txCount: observation.txCount, blockHash: observation.blockHash, status: 'verified' };
    if (next.phase !== 'ready') settle(next, { txCount: observation.txCount, blockHash: observation.blockHash });
  }
  return next;
}

function recordDecision(state, action, reason, detail = {}) {
  const decision = { timeMs: state.elapsedMs, action, reason, ...detail };
  state.automation.lastDecision = decision;
  state.automation.decisions.push(decision);
  if (state.automation.decisions.length > MAX_RECORDS) state.automation.decisions.splice(0, state.automation.decisions.length - MAX_RECORDS);
}

export function configureAutomation(state, patch) {
  if (!patch || typeof patch !== 'object') fail('INVALID_AUTOMATION', '自动策略设置无效');
  const next = copy(state);
  const config = { ...next.automation, ...patch };
  if (typeof config.enabled !== 'boolean' || !['value', 'momentum'].includes(config.strategy) ||
      !Number.isInteger(config.orderShares) || config.orderShares < 1 || config.orderShares > 50 ||
      !Number.isInteger(config.maxPosition) || config.maxPosition < 10 || config.maxPosition > 500 ||
      !Number.isFinite(config.edge) || config.edge < 0.01 || config.edge > 0.2) {
    fail('INVALID_AUTOMATION', '策略、份数、持仓上限或触发优势超出范围');
  }
  if (config.enabled && (state.phase !== 'trading' || state.event?.mode === 'monad' && state.event.headBlock >= state.event.closeBlock)) {
    fail('AUTOMATION_CLOSED', '仅可在本轮开放交易时启用自动策略');
  }
  next.automation = { ...config };
  if (!config.enabled) recordDecision(next, 'stop', '已手动停止自动策略');
  else recordDecision(next, 'start', `自动策略已启用：${config.strategy}`);
  return next;
}

export function actionPreview(state, delta) {
  if (delta !== 1 && delta !== -1) fail('INVALID_ACTION', '行动只支持 +1 加热或 −1 降温');
  const before = scenarioOdds(state);
  if (state.event?.mode === 'monad') return { delta, before, after: before, canExecute: false, reason: '本地操作不会改变真实链事件' };
  if (!shiftAllowed(state, delta)) {
    return { delta, before, after: before, canExecute: false, reason: '本地事件压力已达到 +3 / −3 上限' };
  }
  if (findTrader(state, 'player').tickets <= 0) return { delta, before, after: before, canExecute: false, reason: '本轮行动券已用完' };
  const simulated = copy(state);
  simulated.heat += delta;
  return { delta, before, after: scenarioOdds(simulated), canExecute: state.phase === 'trading' && state.elapsedMs < state.tradingDurationMs,
    reason: state.phase === 'trading' ? '' : '当前不能行动' };
}

export function startRound(state) {
  if (state.phase !== 'ready') fail('INVALID_PHASE', '只有准备中的回合可以开始');
  if (state.event?.mode === 'monad' && (state.event.status === 'expired' || state.event.status === 'verified' ||
      state.event.headBlock >= state.event.closeBlock)) fail('EVENT_EXPIRED', '真实事件已到封盘区块，请重新准备目标区块');
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
  if (!['buy', 'sell', 'short', 'cover'].includes(side)) fail('INVALID_SIDE', '请选择买入、卖出、做空或平仓');
  if (!Number.isInteger(shares) || shares < 1 || shares > 1000) fail('INVALID_SHARES', '份数必须是 1 至 1000 的整数');
  if (side === 'short' || side === 'cover') {
    const legs = COLORS.filter(item => item !== color);
    let simulated = copy(state);
    const quotes = [];
    let firstFailure = null;
    for (const legColor of legs) {
      const leg = quoteTrade(simulated, traderId, legColor, side === 'short' ? 'buy' : 'sell', shares);
      quotes.push({ color: legColor, side: leg.side, shares, gross: leg.gross, fee: leg.fee, total: leg.total, canExecute: leg.canExecute, reason: leg.reason, code: leg.code });
      if (!leg.canExecute && !firstFailure) firstFailure = leg;
      // Price both legs for a useful preview even when the overall order is
      // closed or underfunded. This simulation is isolated from caller state.
      if (leg.code !== 'INSUFFICIENT_HOLDINGS') applyTrade(simulated, traderId, leg);
    }
    const gross = quotes.reduce((sum, leg) => sum + leg.gross, 0);
    const fee = quotes.reduce((sum, leg) => sum + leg.fee, 0);
    const total = quotes.reduce((sum, leg) => sum + leg.total, 0);
    const spotPrice = 1 - marketPrices(state)[color];
    return { side, color, shares, legs: quotes, spotPrice, averagePrice: gross / shares, gross, fee, total,
      pricesAfter: marketPrices(simulated), winPayout: shares, winProfit: shares - total,
      roi: total > 0 ? (shares - total) / total : 0, canExecute: !firstFailure,
      reason: firstFailure?.reason ?? '', code: firstFailure?.code ?? '' };
  }
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
    removedBasis, realizedPnl: realizedChange, source: quote.source ?? 'manual',
    ...(quote.comboColor ? { comboColor: quote.comboColor, comboSide: quote.comboSide, groupId: quote.groupId } : {}),
  };
  state.trades.push(entry);
  if (quote.source === 'strategy' && traderId === 'player') state.automation.tradeCount += 1;
  if (state.trades.length > MAX_RECORDS) state.trades.splice(0, state.trades.length - MAX_RECORDS);
  event(state, 'trade', `${trader.name}${side === 'buy' ? '买入' : '卖出'} ${shares} 份${{ red: '红', black: '黑', green: '绿' }[color]}`, entry);
  updateStats(state);
  snapshot(state);
}

export function executeTrade(state, traderId, color, side, shares) {
  const quote = quoteTrade(state, traderId, color, side, shares);
  if (!quote.canExecute) fail(quote.code || 'TRADE_REJECTED', quote.reason);
  if (side === 'short' || side === 'cover') {
    const next = copy(state);
    if (traderId === 'player' && side === 'cover' && next.automation.enabled) {
      next.automation.enabled = false;
      recordDecision(next, 'stop', '手动平仓，自动策略已停止');
    }
    const groupId = next._nextTradeId;
    for (const legColor of COLORS.filter(item => item !== color)) {
      const legSide = side === 'short' ? 'buy' : 'sell';
      const leg = quoteTrade(next, traderId, legColor, legSide, shares);
      if (!leg.canExecute) fail(leg.code || 'TRADE_REJECTED', leg.reason);
      applyTrade(next, traderId, { ...leg, comboColor: color, comboSide: side, groupId });
    }
    return next;
  }
  const next = copy(state);
  if (traderId === 'player' && side === 'sell' && next.automation.enabled) {
    next.automation.enabled = false;
    recordDecision(next, 'stop', '手动卖出，自动策略已停止');
  }
  applyTrade(next, traderId, quote);
  return next;
}

const shiftAllowed = (state, delta) => state.mode === 'chain'
  ? !state.heatLimit || Math.abs(state.heat + delta - state.baseline) <= state.heatLimit
  : Math.abs(state.heat + delta - state.baseline) <= 3;

/** Find the largest whole-share opening order that stays within a points budget. */
export function quoteBudget(state, traderId, color, budget, side = 'buy') {
  findTrader(state, traderId);
  if (!COLORS.includes(color)) fail('INVALID_COLOR', '请选择红、黑或绿');
  if (side !== 'buy' && side !== 'short') fail('INVALID_SIDE', '预算只支持买入或做空 NO 组合');
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 1 || budget > 1000) fail('INVALID_BUDGET', '预算必须是 1 至 1000 积分');
  let low = 0;
  let high = 1000;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (quoteTrade(state, traderId, color, side, middle).total <= budget) low = middle;
    else high = middle - 1;
  }
  if (low === 0) {
    const minimum = quoteTrade(state, traderId, color, side, 1);
    return { ...minimum, shares: 0, total: 0, gross: 0, fee: 0, winPayout: 0, winProfit: 0, roi: 0,
      canExecute: false, reason: '预算不足以买入 1 份', code: 'BUDGET_TOO_SMALL', budget, unusedBudget: budget };
  }
  const quote = quoteTrade(state, traderId, color, side, low);
  return { ...quote, budget, unusedBudget: points(units(budget) - units(quote.total)) };
}

function applyAction(state, trader, delta) {
  if (!shiftAllowed(state, delta)) return false;
  trader.tickets -= 1;
  state.heat += delta;
  event(state, 'action', `${trader.name}${delta > 0 ? '加热 +1' : '降温 −1'}`, { traderId: trader.id, participantId: trader.id, delta, heat: state.heat });
  snapshot(state);
  updateStats(state);
  return true;
}

export function playerAction(state, delta) {
  if (state.event?.mode === 'monad') fail('REAL_EVENT_CONTROL_DISABLED', '本地操作不会改变真实链事件');
  if (delta !== 1 && delta !== -1) fail('INVALID_ACTION', '行动只支持 +1 加热或 −1 降温');
  if (state.phase !== 'trading' || state.elapsedMs >= state.tradingDurationMs) fail('ACTION_CLOSED', '当前已封盘，不能行动');
  if (state.mode === 'chain' && findTrader(state, 'player').tickets <= 0) fail('NO_TICKETS', '本轮行动券已用完');
  if (!shiftAllowed(state, delta)) fail(state.mode === 'chain' ? 'HEAT_LIMIT' : 'ACTION_LIMIT', state.mode === 'chain'
    ? `全场热度最多偏离基准 ±${state.heatLimit}` : '本地事件压力已达到 +3 / −3 上限');
  if (state.mode !== 'chain' && findTrader(state, 'player').tickets <= 0) fail('NO_TICKETS', '本轮行动券已用完');
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
  if (state.event.mode !== 'monad' && bot.tickets > 0 && state.elapsedMs >= 10000 && random(state) < 0.025) {
    const preference = bot.holdings.red - bot.holdings.black;
    const delta = preference !== 0 ? Math.sign(preference)
      : bot.holdings.green > 0 && state.heat !== state.baseline ? -Math.sign(state.heat - state.baseline) : 0;
    if (delta !== 0 && shiftAllowed(state, delta)) applyAction(state, bot, delta);
  }
}

function playerAutomationDecision(state) {
  const automation = state.automation;
  if (!automation.enabled || state.phase !== 'trading' || state.elapsedMs >= state.tradingDurationMs) return;
  if (state.event.mode === 'monad') {
    recordDecision(state, 'hold', '真实事件暂无校准概率模型，自动策略保持观望');
    return;
  }
  const trader = findTrader(state, 'player');
  const prices = marketPrices(state);
  const estimates = scenarioOdds(state);
  const forecast = { ...estimates };
  if (automation.strategy === 'momentum') {
    const previous = state.history.findLast(point => point.timeMs <= state.elapsedMs - 3000) ?? state.history[0];
    for (const color of COLORS) {
      const trend = prices[color] - (previous?.prices[color] ?? prices[color]);
      forecast[color] = Math.max(0.005, estimates[color] + Math.max(-0.12, Math.min(0.12, trend * 2.4)));
    }
    const sum = COLORS.reduce((total, color) => total + forecast[color], 0);
    for (const color of COLORS) forecast[color] /= sum;
  }
  const ranked = COLORS.map(color => ({ color, edge: forecast[color] - prices[color] })).sort((a, b) => b.edge - a.edge);
  const heldToSell = COLORS.map(color => ({ color, edge: forecast[color] - prices[color] }))
    .filter(item => trader.holdings[item.color] > 0 && item.edge < -automation.edge).sort((a, b) => a.edge - b.edge)[0];
  if (heldToSell) {
    const shares = Math.min(automation.orderShares, trader.holdings[heldToSell.color]);
    const quote = quoteTrade(state, trader.id, heldToSell.color, 'sell', shares);
    const netSalePrice = quote.total / shares;
    if (quote.canExecute && netSalePrice > forecast[heldToSell.color] + automation.edge) {
      applyTrade(state, trader.id, { ...quote, source: 'strategy' });
      recordDecision(state, 'sell', '扣除费用后，卖出价格仍高于预估价值', { color: heldToSell.color, shares, edge: netSalePrice - forecast[heldToSell.color] });
    } else recordDecision(state, 'hold', quote.reason || '卖出条件未满足', { color: heldToSell.color });
    return;
  }
  const candidate = ranked[0];
  if (candidate.edge < automation.edge) {
    recordDecision(state, 'hold', '当前优势不足，继续观察', { color: candidate.color, edge: candidate.edge });
    return;
  }
  const totalHeld = COLORS.reduce((sum, color) => sum + trader.holdings[color], 0);
  const room = automation.maxPosition - totalHeld;
  if (room < 1) {
    recordDecision(state, 'hold', '该颜色已达到持仓上限', { color: candidate.color });
    return;
  }
  const shares = Math.min(automation.orderShares, room);
  const quote = quoteTrade(state, trader.id, candidate.color, 'buy', shares);
  const netEdge = forecast[candidate.color] - quote.total / shares;
  if (quote.canExecute && netEdge >= automation.edge) {
    applyTrade(state, trader.id, { ...quote, source: 'strategy' });
    recordDecision(state, 'buy', '扣除费用后仍有足够的预估优势，执行买入', { color: candidate.color, shares, edge: netEdge });
  } else recordDecision(state, 'hold', quote.reason || '扣除费用后的预估优势不足或报价不可执行', { color: candidate.color, edge: netEdge });
}

const drawNoise = state => Math.floor(random(state, '_noiseRngState') * (2 * state.noiseRange + 1)) - state.noiseRange;

function settle(state, resolution = null) {
  const actionHeat = state.heat;
  const closingPrices = marketPrices(state);
  const busyChain = state.mode === 'chain';
  const noise = busyChain ? (typeof resolution === 'number' ? resolution : state.event.busy - state.event.baseline) : drawNoise(state);
  const finalHeat = actionHeat + noise;
  let txCount = null;
  let color;
  if (busyChain) {
    color = colorOf(state, finalHeat);
  } else {
    const verifiedEvent = resolution && typeof resolution === 'object' ? resolution : null;
    txCount = verifiedEvent?.txCount ?? state.event.txCount;
    if (txCount === null || txCount === undefined) {
      const pressure = Math.max(-3, Math.min(3, state.heat - state.baseline));
      const expected = state.event.baseline + pressure * 3;
      const eventNoise = Math.floor(random(state, '_eventRngState') * (2 * state.noiseRange + 1)) - state.noiseRange;
      txCount = Math.max(0, Math.round(expected) + eventNoise);
      state.event = { ...state.event, txCount, headBlock: state.event.targetBlock, status: 'simulated' };
    }
    color = classifyEvent(state.event, txCount);
  }
  const supportCounts = Object.fromEntries(COLORS.map(item => [item,
    state.participants.filter(trader => trader.holdings[item] > 0).length]));
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
  state.automation.enabled = false;
  state.heat = finalHeat;
  let rank = 0;
  let previousProfit;
  const ranking = state.participants.map(trader => ({ id: trader.id, name: trader.name, profit: profits[trader.id] }))
    .sort((a, b) => b.profit - a.profit).map((entry, index) => {
      if (index === 0 || entry.profit !== previousProfit) rank = index + 1;
      previousProfit = entry.profit;
      return { ...entry, rank };
    });
  state.result = { round: state.round, color, finalHeat, actionHeat, noise, closingPrices, payouts, profits, totalPayout,
    tradeCount: state.tradeCount, marketCash: state.market.cash, supportCounts, ranking };
  if (busyChain) {
    const { startBlock, windowBlocks, busy, baseline } = state.event;
    state.result.event = { startBlock, endBlock: startBlock + windowBlocks, busy, baseline };
  } else {
    const verifiedEvent = resolution && typeof resolution === 'object' ? resolution : null;
    state.result.eventTitle = state.event.title;
    state.result.eventMode = state.event.mode;
    state.result.eventValue = txCount;
    state.result.eventLower = state.event.lower;
    state.result.eventUpper = state.event.upper;
    state.result.targetBlock = state.event.targetBlock;
    state.result.eventSource = state.event.source;
    if (verifiedEvent?.blockHash) state.result.eventHash = verifiedEvent.blockHash;
  }
  state.results.push(copy(state.result));
  event(state, 'settled', `结算完成：${{ red: '红', black: '黑', green: '绿' }[color]}命中，每份兑付 1 积分`,
    { color, noise, finalHeat, totalPayout, ...(txCount === null ? {} : { eventValue: txCount }) });
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
      next.automation.enabled = false;
      recordDecision(next, 'stop', '到达封盘时间，自动策略已停止');
      event(next, 'locked', next.event?.mode === 'monad' ? '已到交易时限，停止交易并等待真实目标区块确认' : '最后 5 秒已封盘：停止交易和行动，等待事件结果');
    }
    if (next.phase === 'trading') runBots(next);
    if (next.event?.mode === 'simulation') next.event.headBlock = next.block;
    while (next._nextAutomationMs <= next.elapsedMs) {
      if (next.phase === 'trading') playerAutomationDecision(next);
      next._nextAutomationMs += 1000;
    }
    updateStats(next);
    snapshot(next);
  }
  clock(next, end);
  if (end >= next.durationMs && next.event?.mode === 'simulation') settle(next);
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
      next.automation.enabled = false;
      recordDecision(next, 'stop', '达到区块封盘点，自动策略已停止');
      event(next, 'locked', `已封盘：第 ${e.lockBlocks} 个区块已出，停止交易和行动，等待统计窗口结束`);
    }
    if (next.phase === 'trading') runBots(next);
    while (next._nextAutomationMs <= next.elapsedMs) {
      if (next.phase === 'trading') playerAutomationDecision(next);
      next._nextAutomationMs += 1000;
    }
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
  next.automation.enabled = false;
  recordDecision(next, 'stop', '区块事件作废，自动策略已停止');
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
  next.event = next.mode === 'chain' ? null : { ...SIM_EVENT };
  next.automation.enabled = false;
  next.automation.tradeCount = 0;
  next.automation.lastDecision = { timeMs: 0, action: 'idle', reason: '尚未启用' };
  next.automation.decisions = [];
  next.market.q = emptyPosition();
  next.market.b = Math.min(DEFAULT_B, 0.8 * next.market.cash / Math.log(10));
  next.history = [];
  next.events = [];
  next.trades = [];
  next._nextTickMs = BLOCK_DURATION_MS;
  next._nextAutomationMs = 1000;
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
