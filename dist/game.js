/**
 * BlockPulse local simulator. No chain, money, redemption, or balance guarantee.
 * Reducers are immutable. Invalid actions throw GameError; harmless timer and
 * settlement repetitions return the same state. Bots use a seeded plan prepared
 * at round start, with at most three actions each. This is not a balanced game.
 */

export const COLORS = Object.freeze(['red', 'black', 'green']);
export const STAKES = Object.freeze([20, 50, 100]);
export const ROUND_DURATION_MS = 15000;
export const BLOCK_DURATION_MS = 500;

export class GameError extends Error {
  constructor(code, reason) {
    super(reason);
    this.name = 'GameError';
    this.code = code;
    this.reason = reason;
  }
}

const fail = (code, reason) => { throw new GameError(code, reason); };
const copy = state => structuredClone(state);
const colorOf = heat => heat > 100 ? 'red' : heat < 100 ? 'black' : 'green';
const playerOf = state => state.participants.find(p => p.id === 'player');

function random(state) {
  state._rngState = (state._rngState + 0x6d2b79f5) >>> 0;
  let value = state._rngState;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

function event(state, type, message, detail = {}) {
  state.events.push({
    id: state._nextEventId++, timeMs: state.elapsedMs, type, message, ...detail,
  });
}

function point(state) {
  state.history.push({ timeMs: state.elapsedMs, heat: state.heat, block: state.block });
}

function clock(state, timeMs) {
  state.elapsedMs = timeMs;
  state.timeMs = timeMs;
  state.remainingMs = Math.max(0, state.durationMs - timeMs);
}

function applyAction(state, participant, delta) {
  participant.tickets -= 1;
  state.heat += delta;
  point(state);
  event(state, 'action', `${participant.name}${delta > 0 ? '加热 +1' : '降温 −1'}，热度 ${state.heat}`, {
    participantId: participant.id, delta, heat: state.heat,
  });
}

function botAction(state, entry) {
  const bot = state.participants.find(p => p.id === entry.participantId);
  if (!entry.willAct || bot.tickets <= 0 || (bot.id === 'reversion' && state.heat === state.baseline)) {
    event(state, 'hold', `${bot.name}选择保留行动券`, { participantId: bot.id });
    return;
  }
  const trend = Math.sign(state.heat - state.baseline);
  const delta = bot.id === 'momentum'
    ? trend || (bot.bet?.color === 'black' ? -1 : 1)
    : -trend;
  applyAction(state, bot, delta);
}

/** Start a fresh deterministic simulation. All three accounts begin with 1000. */
export function createGame(seed = 20261017) {
  if (typeof seed !== 'number' || !Number.isFinite(seed)) fail('INVALID_SEED', '种子必须是有限数字');
  const normalizedSeed = Math.trunc(seed) >>> 0;
  const state = {
    phase: 'betting', round: 1, seed: normalizedSeed,
    heat: 100, baseline: 100, remainingMs: ROUND_DURATION_MS,
    durationMs: ROUND_DURATION_MS, elapsedMs: 0, timeMs: 0, block: 0, pool: 0,
    participants: [
      { id: 'player', name: '你', balance: 1000, bet: null, tickets: 3 },
      { id: 'momentum', name: '动量 Bot', balance: 1000, bet: null, tickets: 3 },
      { id: 'reversion', name: '回归 Bot', balance: 1000, bet: null, tickets: 3 },
    ],
    history: [{ timeMs: 0, heat: 100, block: 0 }],
    events: [], results: [], result: null,
    _rngState: normalizedSeed, _botSchedule: [], _nextBlockMs: BLOCK_DURATION_MS,
    _nextEventId: 1,
  };
  event(state, 'round_ready', '模拟回合已准备：选择预测和积分；所有积分均不可兑现');
  return state;
}

/** Lock the player's selected stake. A locked bet cannot be changed. */
export function placeBet(state, color, stake) {
  if (state.phase !== 'betting') fail('BETTING_CLOSED', '当前已封盘，不能改注');
  if (!COLORS.includes(color)) fail('INVALID_COLOR', '请选择红、黑或绿');
  if (!STAKES.includes(stake)) fail('INVALID_STAKE', '押注积分只能是 20、50 或 100');
  const player = playerOf(state);
  if (player.bet) fail('BET_ALREADY_LOCKED', '本轮押注已锁定');
  if (player.balance < stake) fail('INSUFFICIENT_BALANCE', '可用积分不足');
  const next = copy(state);
  const nextPlayer = playerOf(next);
  nextPlayer.balance -= stake;
  nextPlayer.bet = { color, stake };
  next.pool += stake;
  event(next, 'bet', `你锁定 ${stake} 模拟积分`, { participantId: 'player', color, stake });
  return next;
}

/** Close betting, lock the bots' stakes, and precompute their action schedule. */
export function startRound(state) {
  if (state.phase !== 'betting') fail('INVALID_PHASE', '只有准备中的回合可以开始');
  if (!playerOf(state).bet) fail('BET_REQUIRED', '请先选择并锁定押注');
  const next = copy(state);
  const previous = next.results.at(-1);
  const previousHeat = previous?.finalHeat ?? next.baseline;
  const direction = Math.sign(previousHeat - next.baseline);
  const momentumColor = direction > 0 ? 'red' : direction < 0 ? 'black'
    : random(next) < 0.5 ? 'red' : 'black';
  const reversionColor = Math.abs(previousHeat - next.baseline) <= 1 ? 'green'
    : direction > 0 ? 'black' : 'red';
  for (const bot of next.participants.filter(p => p.id !== 'player')) {
    const stake = Math.min(playerOf(next).bet.stake, bot.balance);
    if (stake > 0) {
      const color = bot.id === 'momentum' ? momentumColor : reversionColor;
      bot.balance -= stake;
      bot.bet = { color, stake };
      next.pool += stake;
      event(next, 'bet', `${bot.name}锁定 ${stake} 模拟积分`, { participantId: bot.id, color, stake });
    } else {
      event(next, 'no_bet', `${bot.name}无积分，本轮不下注`, { participantId: bot.id });
    }
  }
  const scheduled = [
    ['momentum', 1800], ['reversion', 3300],
    ['momentum', 6200], ['reversion', 8200],
    ['momentum', 11200], ['reversion', 13700],
  ];
  next._botSchedule = scheduled.map(([participantId, center]) => ({
    participantId,
    timeMs: center + Math.floor(random(next) * 601) - 300,
    // Decided now, independent of future player actions and frame rate.
    willAct: random(next) < 0.78,
    done: false,
  })).sort((a, b) => a.timeMs - b.timeMs);
  next.phase = 'active';
  event(next, 'round_started', '封盘：15 秒行动开始，每人最多 3 张券，可以保留');
  return next;
}

/** Spend one action ticket. It never charges additional points. */
export function playerAction(state, delta) {
  if (state.phase !== 'active' || state.remainingMs <= 0) fail('ACTION_CLOSED', '当前不在行动时间内');
  if (delta !== 1 && delta !== -1) fail('INVALID_ACTION', '行动只支持 +1 加热或 −1 降温');
  if (playerOf(state).tickets <= 0) fail('NO_TICKETS', '本轮行动券已用完');
  const next = copy(state);
  applyAction(next, playerOf(next), delta);
  return next;
}

/**
 * Advance simulated time. Bots run at scheduled times, never once per frame.
 * Every 500 ms adds a block/path point. At 15 seconds settlement is automatic.
 */
export function advance(state, dtMs) {
  if (typeof dtMs !== 'number' || !Number.isFinite(dtMs) || dtMs < 0) {
    fail('INVALID_TIME', '时间增量必须是非负有限数字');
  }
  if (state.phase !== 'active' || dtMs === 0) return state;
  const next = copy(state);
  const end = Math.min(next.durationMs, next.elapsedMs + dtMs);
  for (;;) {
    const scheduled = next._botSchedule.find(entry => !entry.done);
    const actionTime = scheduled?.timeMs ?? Infinity;
    const due = Math.min(next._nextBlockMs, actionTime);
    if (due > end) break;
    clock(next, due);
    if (next._nextBlockMs <= actionTime) {
      next.block += 1;
      next._nextBlockMs += BLOCK_DURATION_MS;
      point(next);
    } else {
      scheduled.done = true;
      botAction(next, scheduled);
    }
  }
  clock(next, end);
  if (end >= next.durationMs) return settleRound(next);
  return next;
}

/**
 * Distribute only the locked pool. Integer remainders go to winning stakes in
 * descending fractional-remainder order, then participant order for ties.
 * If nobody wins, refund every stake. Settlement is idempotent.
 */
export function settleRound(state) {
  if (state.phase === 'settled') return state;
  if (state.phase !== 'active' || state.elapsedMs < state.durationMs) {
    fail('ROUND_NOT_FINISHED', '行动时间结束后才能结算');
  }
  const next = copy(state);
  const color = colorOf(next.heat);
  const stakes = Object.fromEntries(next.participants.map(p => [p.id, p.bet?.stake ?? 0]));
  const pool = Object.values(stakes).reduce((sum, amount) => sum + amount, 0);
  const winners = next.participants.filter(p => p.bet?.color === color && p.bet.stake > 0);
  const payouts = Object.fromEntries(next.participants.map(p => [p.id, 0]));
  if (!winners.length) {
    for (const p of next.participants) payouts[p.id] = stakes[p.id];
  } else {
    const winningStake = winners.reduce((sum, p) => sum + p.bet.stake, 0);
    const shares = winners.map((p, index) => ({
      id: p.id, index,
      base: Math.floor(pool * p.bet.stake / winningStake),
      remainder: (pool * p.bet.stake) % winningStake,
    }));
    for (const share of shares) payouts[share.id] = share.base;
    let remainder = pool - shares.reduce((sum, share) => sum + share.base, 0);
    shares.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (let index = 0; remainder > 0; index += 1, remainder -= 1) {
      payouts[shares[index % shares.length].id] += 1;
    }
  }
  const profits = {};
  for (const participant of next.participants) {
    participant.balance += payouts[participant.id];
    profits[participant.id] = payouts[participant.id] - stakes[participant.id];
  }
  next.phase = 'settled';
  next.pool = 0;
  next.remainingMs = 0;
  next.result = {
    round: next.round, color, finalHeat: next.heat, pool, stakes, payouts, profits,
    refund: !winners.length, winnerIds: winners.map(p => p.id),
    roundingPolicy: 'largest-remainder-then-participant-order',
  };
  next.results.push(copy(next.result));
  event(next, 'settled', !winners.length ? '无人命中：所有押注积分原数退回'
    : '回合结算：命中者按押注比例分享积分池；没有新增积分', {
    color, pool, refund: !winners.length,
  });
  return next;
}

/** Keep bankrolls and completed results; reset this round's path and actions. */
export function nextRound(state) {
  if (state.phase !== 'settled') fail('ROUND_NOT_SETTLED', '请先完成当前回合');
  const next = copy(state);
  next.round += 1;
  next.phase = 'betting';
  next.heat = next.baseline;
  next.remainingMs = next.durationMs;
  next.elapsedMs = 0;
  next.timeMs = 0;
  next.block = 0;
  next.pool = 0;
  next.result = null;
  next.history = [{ timeMs: 0, heat: next.baseline, block: 0 }];
  next.events = [];
  next._botSchedule = [];
  next._nextBlockMs = BLOCK_DURATION_MS;
  for (const participant of next.participants) {
    participant.bet = null;
    participant.tickets = 3;
  }
  event(next, 'round_ready', `第 ${next.round} 轮已准备；积分余额与历史结果保留`);
  return next;
}

export function resetGame(seed = 20261017) {
  return createGame(seed);
}
