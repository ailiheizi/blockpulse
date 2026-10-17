/** Three-outcome LMSR practice market with an independent price event. */
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
const SIM_REFERENCE_MICROS = 100000000;
const SIM_BAND_BPS = 2;
const SIM_PRICE_STEP_MICROS = 20000;
const MAX_PRICE_OBSERVATION_AGE_MS = 15000;
const MAX_PRICE_CLOCK_SKEW_MS = 15000;
const SIM_EVENT = Object.freeze({
  mode: 'simulation', title: '独立模拟 SOL/USD 价格', source: '本地独立模拟', product: 'SOL-USD',
  startTimeMs: 0, referenceTimeMs: 0, cutoffTimeMs: 55000, targetTimeMs: 60000,
  referenceMicros: SIM_REFERENCE_MICROS,
  lowerMicros: Math.floor(SIM_REFERENCE_MICROS * 9998 / 10000),
  upperMicros: Math.ceil(SIM_REFERENCE_MICROS * 10002 / 10000),
  bandBps: SIM_BAND_BPS, settlementDelayMs: 0, priceMicros: SIM_REFERENCE_MICROS,
  priceTimeMs: 0, serverTimeMs: 0, status: 'simulation', series: [],
});
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
  if (state.phase === 'settled' && state.result && !state.result.voided) {
    return Object.fromEntries(COLORS.map(color => [color, color === state.result.color ? 1 : 0]));
  }
  const values = COLORS.map(color => state.market.q[color] / state.market.b);
  const maximum = Math.max(...values);
  const weights = COLORS.map((color, index) => (state.market.priors?.[color] ?? 1 / 3) * Math.exp(values[index] - maximum));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return Object.fromEntries(COLORS.map((color, index) => [color, weights[index] / total]));
}

/** Approximate event odds; never used as a guarantee or to change the price path. */
export function scenarioOdds(state) {
  if (state.phase === 'settled' && state.result) return marketPrices(state);
  const eventSpec = state.event;
  if (!eventSpec) return { red: 1 / 3, black: 1 / 3, green: 1 / 3 };
  if (eventSpec.mode === 'price') return { red: 1 / 3, black: 1 / 3, green: 1 / 3 };
  const remaining = Math.max(0, Math.ceil((eventSpec.targetTimeMs - (eventSpec.startTimeMs + state.elapsedMs)) / BLOCK_DURATION_MS));
  const variancePerStep = SIM_PRICE_STEP_MICROS * (SIM_PRICE_STEP_MICROS + 1) / 3;
  const sigma = Math.sqrt(Math.max(1, remaining * variancePerStep));
  const cdf = value => 1 / (1 + Math.exp(-1.702 * value));
  const black = cdf((eventSpec.lowerMicros - eventSpec.priceMicros) / sigma);
  const red = 1 - cdf((eventSpec.upperMicros - eventSpec.priceMicros) / sigma);
  const raw = { red: Math.max(0.005, red), black: Math.max(0.005, black), green: Math.max(0.005, 1 - red - black) };
  const total = COLORS.reduce((sum, color) => sum + raw[color], 0);
  return Object.fromEntries(COLORS.map(color => [color, raw[color] / total]));
}

function classifyPrice(eventSpec, priceMicros) {
  return priceMicros > eventSpec.upperMicros ? 'red' : priceMicros < eventSpec.lowerMicros ? 'black' : 'green';
}

function marketLocked(state) {
  if (state.phase !== 'trading' || state.elapsedMs >= state.tradingDurationMs) return true;
  if (state.mode === 'price') return !priceObservationFresh(state.event) || state.event.priceTimeMs >= state.event.targetTimeMs;
  return state.event?.mode === 'simulation' && possiblePracticeColor(state) !== null;
}

function priceObservationFresh(eventSpec, nowMs = Date.now()) {
  return Number.isSafeInteger(eventSpec?.serverTimeMs) && Number.isSafeInteger(nowMs) &&
    nowMs < eventSpec.cutoffTimeMs && nowMs - eventSpec.serverTimeMs <= MAX_PRICE_OBSERVATION_AGE_MS &&
    eventSpec.serverTimeMs - nowMs <= MAX_PRICE_CLOCK_SKEW_MS;
}

function possiblePracticeColor(state) {
  const eventSpec = state.event;
  const remaining = Math.max(0, Math.ceil((eventSpec.targetTimeMs - (eventSpec.startTimeMs + state.elapsedMs)) / BLOCK_DURATION_MS));
  const spread = remaining * SIM_PRICE_STEP_MICROS;
  const low = Math.max(1, eventSpec.priceMicros - spread);
  const high = eventSpec.priceMicros + spread;
  const lowColor = classifyPrice(eventSpec, low);
  return lowColor === classifyPrice(eventSpec, high) ? lowColor : null;
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

const nextTickAfter = timeMs => Math.floor(timeMs / BLOCK_DURATION_MS) * BLOCK_DURATION_MS + BLOCK_DURATION_MS;
const nextAutomationAfter = timeMs => Math.floor(timeMs / 1000) * 1000 + 1000;

function participant(id, name, strategy) {
  return {
    id, name, strategy, balance: 1000, holdings: emptyPosition(), costBasis: emptyPosition(),
    realizedPnl: 0, tickets: 0, tradeCount: 0, peakEquity: 1000, maxDrawdown: 0,
  };
}

export function createGame(seed = 20261017, options = {}) {
  if (typeof seed !== 'number' || !Number.isFinite(seed)) fail('INVALID_SEED', '种子必须是有限数字');
  const botCount = options.botCount ?? 2;
  if (botCount !== 2 && botCount !== 20) fail('INVALID_BOT_COUNT', '请选择 2 或 20 位 Bot');
  const mode = options.mode ?? 'local';
  if (mode === 'chain') fail('LEGACY_EVENT_DISABLED', '忙区块事件已停用，请使用独立价格事件');
  if (mode !== 'local') fail('INVALID_MODE', '请选择本地模拟或价格事件');
  const normalizedSeed = Math.trunc(seed) >>> 0;
  const participants = [participant('player', '你', 'player')];
  for (let index = 0; index < botCount; index += 1) {
    const momentum = index % 2 === 0;
    participants.push(participant(index === 0 ? 'momentum' : index === 1 ? 'value' : `bot-${index + 1}`,
      `${momentum ? '动量' : '价值'} Bot${index > 1 ? ` ${index + 1}` : ''}`, momentum ? 'momentum' : 'value'));
  }
  const state = {
    schemaVersion: 4, mode, heatLimit: null,
    phase: 'ready', round: 1, seed: normalizedSeed, botCount,
    durationMs: ROUND_DURATION_MS, tradingDurationMs: TRADING_DURATION_MS,
    elapsedMs: 0, remainingMs: ROUND_DURATION_MS, block: 0,
    heat: 100, baseline: 100, greenBand: [98, 102], actionLimit: 0,
    noiseRange: 0,
    market: { q: emptyPosition(), cash: 1000, initialReserve: 1000, b: DEFAULT_B, feeRate: 0.003, priors: { ...DEFAULT_PRIORS } },
    participants, initialTotal: participants.length * 1000 + 1000,
    history: [], events: [], trades: [], results: [], result: null, tradeCount: 0,
    event: { ...SIM_EVENT, series: [] }, _rngState: normalizedSeed, _noiseRngState: (normalizedSeed ^ 0x9e3779b9) >>> 0,
    _eventRngState: (normalizedSeed ^ 0x85ebca6b) >>> 0,
    automation: { enabled: false, strategy: 'value', orderShares: 10, maxPosition: 150, edge: 0.04, tradeCount: 0,
      lastDecision: { timeMs: 0, action: 'idle', reason: '尚未启用' }, decisions: [] },
    _nextAutomationMs: 1000, _nextTickMs: BLOCK_DURATION_MS, _nextEventId: 1, _nextTradeId: 1,
    _roundStartBalances: Object.fromEntries(participants.map(trader => [trader.id, trader.balance])),
  };
  snapshot(state);
  event(state, 'round_ready', '独立价格事件市场已准备；交易改变价格，事件结果由独立价格路径决定');
  return state;
}

export function resetGame(seed = 20261017, options = {}) {
  return createGame(seed, options);
}

function validPriceSpec(spec) {
  const integerFields = ['startTimeMs', 'cutoffTimeMs', 'targetTimeMs', 'referenceTimeMs', 'referenceMicros', 'lowerMicros', 'upperMicros'];
  if (!spec || spec.mode !== 'price' || spec.title !== 'SOL/USD 到期价格' ||
      spec.source !== 'Coinbase Exchange SOL-USD' || spec.product !== 'SOL-USD' ||
      integerFields.some(key => !Number.isSafeInteger(spec[key]) || spec[key] < 0) ||
      spec.referenceMicros < 1 || spec.bandBps !== 2 || spec.settlementDelayMs !== 10000 ||
      spec.cutoffTimeMs !== spec.targetTimeMs - 15000 || spec.referenceTimeMs > spec.startTimeMs ||
      spec.startTimeMs >= spec.cutoffTimeMs || spec.targetTimeMs <= spec.startTimeMs) return false;
  const reference = BigInt(spec.referenceMicros);
  const lower = Number(reference * 9998n / 10000n);
  const upper = Number((reference * 10002n + 9999n) / 10000n);
  return spec.lowerMicros === lower && spec.upperMicros === upper;
}

export function configurePriceEvent(state, spec) {
  if (state.phase !== 'ready') fail('INVALID_PHASE', '只有准备中的回合可以更换事件');
  if (!validPriceSpec(spec)) fail('INVALID_EVENT_SPEC', '价格事件规格无效，请重新读取 Coinbase 数据');
  const next = copy(state);
  next.mode = 'price';
  next.durationMs = spec.targetTimeMs - spec.startTimeMs;
  next.tradingDurationMs = spec.cutoffTimeMs - spec.startTimeMs;
  next.remainingMs = next.durationMs;
  next.elapsedMs = 0;
  next._nextTickMs = BLOCK_DURATION_MS;
  next.event = { ...spec, status: 'ready', serverTimeMs: spec.startTimeMs, priceMicros: spec.referenceMicros,
    priceTimeMs: spec.referenceTimeMs, closeMicros: null, candleTimeMs: null, certainColor: null, series: [] };
  event(next, 'event_configured', `已准备独立价格事件：${spec.title}`, { source: spec.source, targetTimeMs: spec.targetTimeMs });
  snapshot(next);
  return next;
}

export function observePriceEvent(state, observation) {
  if (state.mode !== 'price' || !state.event || state.event.mode !== 'price') fail('NOT_PRICE_EVENT', '当前没有外部价格事件');
  if (state.phase === 'settled') return state;
  const spec = state.event;
  const validPriceTime = observation?.verified
    ? observation.priceTimeMs === spec.targetTimeMs
    : observation?.priceTimeMs >= spec.referenceTimeMs && observation?.priceTimeMs >= spec.priceTimeMs;
  if (!observation || observation.mode !== 'price' || observation.source !== spec.source || observation.product !== spec.product ||
      !Number.isSafeInteger(observation.serverTimeMs) || observation.serverTimeMs < spec.serverTimeMs || observation.serverTimeMs < spec.startTimeMs ||
      observation.serverTimeMs - Date.now() > MAX_PRICE_CLOCK_SKEW_MS ||
      !Number.isSafeInteger(observation.priceMicros) || observation.priceMicros < 1 ||
      !Number.isSafeInteger(observation.priceTimeMs) ||
      observation.priceTimeMs > observation.serverTimeMs + (observation.verified ? 0 : 5000) || !validPriceTime ||
      typeof observation.verified !== 'boolean') {
    fail('INVALID_EVENT_OBSERVATION', '价格事件观察与当前数据源或时间不匹配');
  }
  if (Date.now() - observation.serverTimeMs > MAX_PRICE_OBSERVATION_AGE_MS) {
    fail('STALE_EVENT_OBSERVATION', '价格源数据已过期，等待新数据后再操作');
  }
  if (observation.verified && (observation.serverTimeMs < spec.targetTimeMs + spec.settlementDelayMs ||
      observation.targetTimeMs !== spec.targetTimeMs || observation.candleTimeMs !== spec.targetTimeMs - 60000 ||
      !Number.isSafeInteger(observation.closeMicros) || observation.closeMicros < 1 || observation.priceMicros !== observation.closeMicros)) {
    fail('INVALID_EVENT_OBSERVATION', '到期价格缺少准确目标时间、结算蜡烛或有效收盘价');
  }
  const next = copy(state);
  const eventState = next.event;
  eventState.serverTimeMs = observation.serverTimeMs;
  eventState.priceMicros = observation.priceMicros;
  eventState.priceTimeMs = observation.priceTimeMs;
  eventState.series.push({ timeMs: observation.priceTimeMs, priceMicros: observation.priceMicros });
  if (eventState.series.length > MAX_HISTORY) eventState.series.splice(0, eventState.series.length - MAX_HISTORY);
  const previousElapsed = next.elapsedMs;
  next.elapsedMs = Math.max(next.elapsedMs, Math.min(next.durationMs, observation.serverTimeMs - spec.startTimeMs));
  clock(next, next.elapsedMs);
  if (next.elapsedMs > previousElapsed) {
    // Source clock jumps skip stale work instead of replaying bots or automation in the past.
    next._nextTickMs = Math.max(next._nextTickMs, nextTickAfter(next.elapsedMs));
    next._nextAutomationMs = Math.max(next._nextAutomationMs, nextAutomationAfter(next.elapsedMs));
  }
  if (observation.verified) {
    eventState.closeMicros = observation.closeMicros;
    eventState.candleTimeMs = observation.candleTimeMs;
    eventState.status = 'verified';
    if (next.phase === 'ready') return next;
    if (next.phase !== 'locked') lockRound(next, '到达封盘时间，等待结算蜡烛确认');
    settle(next, { closeMicros: observation.closeMicros, candleTimeMs: observation.candleTimeMs });
    return next;
  }
  if (observation.serverTimeMs >= spec.cutoffTimeMs || observation.priceTimeMs >= spec.targetTimeMs || next.phase === 'locked') {
    eventState.status = next.phase === 'ready' ? 'expired' : 'locked';
    if (next.phase === 'trading') lockRound(next, '已到价格事件封盘时间，等待准确结算蜡烛');
  } else eventState.status = 'live';
  return next;
}

// Busy-block and Monad-count event APIs remain as rejecting compatibility stubs.
export function configureEvent() { fail('LEGACY_EVENT_DISABLED', '忙区块事件已停用，请使用独立价格事件'); }
export function observeEvent() { fail('LEGACY_EVENT_DISABLED', '忙区块事件已停用，请使用独立价格事件'); }

function recordDecision(state, action, reason, detail = {}) {
  const decision = { timeMs: state.elapsedMs, action, reason, ...detail };
  state.automation.lastDecision = decision;
  state.automation.decisions.push(decision);
  if (state.automation.decisions.length > MAX_RECORDS) state.automation.decisions.splice(0, state.automation.decisions.length - MAX_RECORDS);
}

function lockRound(state, reason) {
  if (state.phase !== 'trading') return;
  state.phase = 'locked';
  state.automation.enabled = false;
  recordDecision(state, 'stop', reason);
  if (state.event) state.event.status = 'locked';
  event(state, 'locked', reason);
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
  if (config.enabled && (state.phase !== 'trading' || marketLocked(state))) {
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
  return { delta, before, after: before, canExecute: false, reason: '独立价格事件不受行动券影响' };
}

export function startRound(state, nowMs = Date.now()) {
  if (state.phase !== 'ready') fail('INVALID_PHASE', '只有准备中的回合可以开始');
  if (state.mode === 'price' && (!state.event || state.event.status !== 'live' || !priceObservationFresh(state.event, nowMs))) {
    fail('EVENT_EXPIRED', '行情过期、时间不同步或事件已封盘，请刷新行情或重新准备价格事件');
  }
  if (state.market.cash < MIN_ROUND_RESERVE) fail('RESERVE_EXHAUSTED', '做市储备不足 1 积分，请重置试玩');
  const next = copy(state);
  next.phase = 'trading';
  if (next.mode === 'price') {
    next._nextTickMs = Math.max(next._nextTickMs, nextTickAfter(next.elapsedMs));
    next._nextAutomationMs = Math.max(next._nextAutomationMs, nextAutomationAfter(next.elapsedMs));
  }
  next._roundStartBalances = Object.fromEntries(next.participants.map(trader => [trader.id, trader.balance]));
  if (next.mode === 'price') next.event.status = 'live';
  event(next, 'round_started', next.mode === 'price'
    ? `交易开始：事件来源 ${next.event.source}，价格事件与订单独立，截止 ${next.event.cutoffTimeMs}`
    : '交易开始：交易改变市场价格，独立模拟价格路径决定结算结果');
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
  if (marketLocked(state)) {
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

export function playerAction(state, delta) {
  if (delta !== 1 && delta !== -1) fail('INVALID_ACTION', '行动只支持 +1 加热或 −1 降温');
  fail('EVENT_CONTROL_DISABLED', '独立价格事件不受行动券影响');
}

function botDecision(state, bot) {
  // Real-event odds are intentionally uncalibrated; keep bots out of price mode.
  if (state.mode === 'price') return;
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
}

function playerAutomationDecision(state) {
  const automation = state.automation;
  if (!automation.enabled || state.phase !== 'trading' || state.elapsedMs >= state.tradingDurationMs) return;
  if (state.mode === 'price') {
    recordDecision(state, 'hold', '真实价格源暂无校准概率模型，自动策略保持观望');
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

function settle(state, resolution = null) {
  const closingPrices = marketPrices(state);
  const eventSpec = state.event;
  const priceMicros = resolution?.closeMicros ?? eventSpec.priceMicros;
  const color = classifyPrice(eventSpec, priceMicros);
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
  eventSpec.status = 'settled';
  let rank = 0;
  let previousProfit;
  const ranking = state.participants.map(trader => ({ id: trader.id, name: trader.name, profit: profits[trader.id] }))
    .sort((a, b) => b.profit - a.profit).map((entry, index) => {
      if (index === 0 || entry.profit !== previousProfit) rank = index + 1;
      previousProfit = entry.profit;
      return { ...entry, rank };
    });
  state.result = { round: state.round, color, closingPrices, payouts, profits, totalPayout,
    tradeCount: state.tradeCount, marketCash: state.market.cash, supportCounts, ranking,
    eventTitle: eventSpec.title, eventMode: eventSpec.mode, eventValue: priceMicros,
    eventPriceMicros: priceMicros, eventReferenceMicros: eventSpec.referenceMicros,
    eventLowerMicros: eventSpec.lowerMicros, eventUpperMicros: eventSpec.upperMicros,
    eventSource: eventSpec.source, eventTargetTimeMs: eventSpec.targetTimeMs,
    eventCandleTimeMs: resolution?.candleTimeMs ?? eventSpec.priceTimeMs };
  state.results.push(copy(state.result));
  event(state, 'settled', `结算完成：${{ red: '红', black: '黑', green: '绿' }[color]}命中，每份兑付 1 积分`,
    { color, eventPriceMicros: priceMicros, totalPayout });
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
  if ((state.phase !== 'trading' && state.phase !== 'locked') || dtMs === 0) return state;
  const next = copy(state);
  const end = Math.min(next.durationMs, next.elapsedMs + dtMs);
  while (next._nextTickMs <= end) {
    clock(next, next._nextTickMs);
    next.block += 1;
    next._nextTickMs += BLOCK_DURATION_MS;
    if (next.mode === 'local') {
      const delta = Math.floor(random(next, '_eventRngState') * (SIM_PRICE_STEP_MICROS * 2 + 1)) - SIM_PRICE_STEP_MICROS;
      next.event.priceMicros = Math.max(1, next.event.priceMicros + delta);
      next.event.priceTimeMs = next.event.startTimeMs + next.elapsedMs;
      next.event.series.push({ timeMs: next.event.priceTimeMs, priceMicros: next.event.priceMicros });
      if (next.event.series.length > MAX_HISTORY) next.event.series.splice(0, next.event.series.length - MAX_HISTORY);
      const certainColor = possiblePracticeColor(next);
      if (certainColor && next.phase === 'trading') {
        next.event.certainColor = certainColor;
        lockRound(next, `剩余价格范围已确定${{ red: '红', black: '黑', green: '绿' }[certainColor]}盘，停止交易`);
      }
    }
    if (next.mode === 'price' && !priceObservationFresh(next.event)) lockRound(next, '价格源数据已过期或封盘时间已到，停止交易等待确认');
    if (next.elapsedMs >= next.tradingDurationMs && next.phase === 'trading') lockRound(next, '到达封盘时间，停止交易并等待价格事件结算');
    if (next.phase === 'trading') runBots(next);
    while (next._nextAutomationMs <= next.elapsedMs) {
      if (next.phase === 'trading') playerAutomationDecision(next);
      next._nextAutomationMs += 1000;
    }
    updateStats(next);
    snapshot(next);
  }
  clock(next, end);
  if (end >= next.durationMs && next.mode === 'local') settle(next);
  return next;
}

// Busy-block APIs remain rejecting compatibility stubs; active play has no block-count input.
export function armChainEvent() { fail('LEGACY_EVENT_DISABLED', '忙区块事件已停用，请使用独立价格事件'); }
export function ingestBlocks() { fail('LEGACY_EVENT_DISABLED', '忙区块事件已停用，请使用独立价格事件'); }

/** Refunds open point-market positions if a price source cannot complete. */
export function voidRound(state, reason = '价格数据中断') {
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
  recordDecision(next, 'stop', '价格事件作废，自动策略已停止');
  next.result = {
    voided: true, reason, round: next.round, profits, refunded: points(refundUnits),
    tradeCount: next.tradeCount, marketCash: next.market.cash,
  };
  if (next.event) next.event.status = 'voided';
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
  next.block = 0;
  next.tradeCount = 0;
  next.result = null;
  next.durationMs = ROUND_DURATION_MS;
  next.tradingDurationMs = TRADING_DURATION_MS;
  next.remainingMs = next.durationMs;
  next.event = next.mode === 'price' ? null : { ...SIM_EVENT, series: [] };
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
    trader.tickets = 0;
    trader.holdings = emptyPosition();
    trader.costBasis = emptyPosition();
  }
  next._roundStartBalances = Object.fromEntries(next.participants.map(trader => [trader.id, trader.balance]));
  snapshot(next);
  event(next, 'round_ready', `第 ${next.round} 轮已准备；余额、做市储备和累计盈亏保留${next.mode === 'price' ? '，请准备新的价格事件' : ''}`);
  return next;
}
