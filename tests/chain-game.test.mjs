import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, startRound, advance, executeTrade, quoteTrade, playerAction, nextRound, marketPrices,
  scenarioOdds, participantStats, armChainEvent, ingestBlocks, voidRound, GameError,
} from '../dist/game.js';

const COLORS = ['red', 'black', 'green'];
const trader = (state, id = 'player') => state.participants.find(item => item.id === id);
const close = (actual, expected, tolerance = 0.000002) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const rejects = (fn, code) => assert.throws(fn, error => error instanceof GameError && error.code === code && Boolean(error.reason));

// 600 baseline blocks with 40% busy: expected count over 180 blocks is 72.
const baseline = (busy = 240, start = 1000) => Array.from({ length: 600 }, (_, index) => ({ number: start + index, tx: index < busy ? 3 : 1 }));
const armed = (options = {}) => armChainEvent(createGame(options.seed ?? 7, { botCount: options.botCount ?? 2, mode: 'chain' }), baseline(options.busy));
// Blocks after the start block: the first `busy` are busy, the rest are quiet.
const window = (state, busy, count = 180) => Array.from({ length: count }, (_, index) => ({ number: state.event.startBlock + 1 + index, tx: index < busy ? 3 : 1 }));
const quiet = state => { const copy = structuredClone(state); for (const item of copy.participants) item.tickets = 0; return copy; };
const run = (state, busy) => ingestBlocks(state, window(state, busy));

function invariants(state) {
  close(state.participants.reduce((sum, item) => sum + item.balance, 0) + state.market.cash, state.initialTotal);
  assert.ok(state.market.cash >= 0);
  for (const color of COLORS) {
    assert.equal(state.market.q[color], state.participants.reduce((sum, item) => sum + item.holdings[color], 0));
    assert.ok(state.market.cash >= state.market.q[color]);
  }
  for (const item of state.participants) {
    assert.ok(item.balance >= 0);
    const stats = participantStats(state, item.id);
    close(stats.pnl, stats.realizedPnl + stats.unrealizedPnl);
  }
}

test('chain games use a block clock, widened green band, capped actions and no local noise', () => {
  const state = createGame(1, { mode: 'chain' });
  assert.equal(state.mode, 'chain');
  assert.equal(state.event, null);
  assert.equal(state.durationMs, 180 * 300);
  assert.equal(state.tradingDurationMs, 165 * 300);
  assert.deepEqual(state.greenBand, [97, 103]);
  assert.equal(state.heatLimit, 3);
  assert.equal(state.noiseRange, 0);
  assert.deepEqual(marketPrices(state), { red: 1 / 3, black: 1 / 3, green: 1 / 3 });
  assert.equal(createGame(1).mode, 'local');
  assert.equal(createGame(1).heatLimit, null);
  rejects(() => createGame(1, { mode: 'dice' }), 'INVALID_MODE');
  rejects(() => startRound(state), 'EVENT_NOT_ARMED');
  assert.equal(advance(state, 1000), state);
  assert.equal(advance(startRound(armed()), 60000).phase, 'trading');
});

test('arming fixes the baseline and opens prices at the prior without creating shares', () => {
  const ready = createGame(7, { mode: 'chain' });
  const before = structuredClone(ready);
  const state = armChainEvent(ready, baseline());
  assert.deepEqual(ready, before);
  assert.equal(state.event.startBlock, 1599);
  assert.equal(state.event.baseline, 72);
  assert.equal(state.event.rate, 0.4);
  assert.equal(state.event.observed, 0);
  const prices = marketPrices(state), odds = scenarioOdds(state);
  for (const color of COLORS) close(prices[color], odds[color], 1e-9);
  close(COLORS.reduce((sum, color) => sum + prices[color], 0), 1, 1e-9);
  assert.ok(prices.green > 0.2 && prices.green < 0.6);
  assert.deepEqual(state.market.q, { red: 0, black: 0, green: 0 });
  assert.equal(state.history.length, 1);
  close(state.history[0].prices.red, prices.red, 1e-12);
  const rearmed = armChainEvent(state, baseline(300, 5000));
  assert.equal(rearmed.event.baseline, 90);
  assert.equal(rearmed.event.startBlock, 5599);
  assert.equal(rearmed.history.length, 1);
  rejects(() => armChainEvent(createGame(1), baseline()), 'NOT_CHAIN_EVENT');
  rejects(() => armChainEvent(ready, baseline().slice(0, 100)), 'BASELINE_TOO_SHORT');
  rejects(() => armChainEvent(ready, [{ number: 1, tx: -1 }, ...baseline()]), 'INVALID_BLOCKS');
  rejects(() => armChainEvent(startRound(state), baseline()), 'INVALID_PHASE');
  invariants(state);
});

test('opening quotes are fair to the prior: the first small buy pays about the prior plus the fee', () => {
  const state = startRound(armed());
  const prior = marketPrices(state).red;
  const quote = quoteTrade(state, 'player', 'red', 'buy', 10);
  assert.ok(quote.averagePrice >= prior && quote.averagePrice < prior * 1.05);
  assert.ok(quote.canExecute);
  const bought = executeTrade(state, 'player', 'red', 'buy', 10);
  assert.equal(bought.market.q.red, 10);
  invariants(bought);
  const sold = executeTrade(bought, 'player', 'red', 'sell', 10);
  assert.ok(trader(sold).balance < 1000);
  for (const color of COLORS) close(marketPrices(sold)[color], marketPrices(state)[color], 1e-9);
});

test('blocks advance the clock, count busy blocks, lock at 165 and settle at 180', () => {
  const state = startRound(armed());
  const half = ingestBlocks(state, window(state, 40, 100));
  assert.equal(half.event.observed, 100);
  assert.equal(half.event.busy, 40);
  assert.equal(half.block, 100);
  assert.equal(half.elapsedMs, 100 * 300);
  assert.equal(half.phase, 'trading');
  assert.deepEqual(half.event.series.slice(38, 42), [39, 40, 40, 40]);
  const locked = ingestBlocks(half, window(state, 40, 165));
  assert.equal(locked.event.observed, 165);
  assert.equal(locked.phase, 'locked');
  rejects(() => executeTrade(locked, 'player', 'red', 'buy', 1), 'MARKET_CLOSED');
  rejects(() => playerAction(locked, 1), 'ACTION_CLOSED');
  const done = ingestBlocks(locked, window(state, 40, 180));
  assert.equal(done.phase, 'settled');
  assert.equal(done.event.observed, 180);
  assert.equal(done.remainingMs, 0);
  assert.equal(ingestBlocks(done, window(state, 40, 180)), done);
  assert.equal(done.results.length, 1);
  invariants(done);
});

test('chunking the same blocks any way gives an identical ledger and result', () => {
  const base = startRound(armed({ botCount: 20 }));
  const all = window(base, 90);
  const whole = ingestBlocks(base, all);
  let pieces = base;
  for (let index = 0; index < all.length; index += 7) pieces = ingestBlocks(pieces, all.slice(index, index + 7));
  let single = base;
  for (const block of all) single = ingestBlocks(single, [block]);
  assert.deepEqual(whole, pieces);
  assert.deepEqual(whole, single);
  const overlap = ingestBlocks(ingestBlocks(base, all.slice(0, 50)), all.slice(20));
  assert.deepEqual(whole, overlap);
});

test('gaps and bad counts are rejected before any state changes', () => {
  const state = startRound(armed());
  const snapshot = structuredClone(state);
  const blocks = window(state, 10, 20);
  rejects(() => ingestBlocks(state, blocks.slice(1)), 'BLOCK_GAP');
  rejects(() => ingestBlocks(state, [blocks[0], blocks[2]]), 'BLOCK_GAP');
  rejects(() => ingestBlocks(state, [{ ...blocks[0], tx: -3 }]), 'INVALID_BLOCKS');
  rejects(() => ingestBlocks(state, [{ ...blocks[0], tx: 1.5 }]), 'INVALID_BLOCKS');
  assert.deepEqual(state, snapshot);
  assert.equal(ingestBlocks(state, [{ number: state.event.startBlock, tx: 9 }]), state);
  rejects(() => ingestBlocks(createGame(1), blocks), 'NOT_CHAIN_EVENT');
  const ready = armed();
  assert.equal(ingestBlocks(ready, blocks), ready);
});

test('settlement colors follow X minus baseline and the widened band edges', () => {
  const cases = [[72, 'green'], [75, 'green'], [69, 'green'], [76, 'red'], [68, 'black'], [150, 'red'], [0, 'black']];
  for (const [busy, color] of cases) {
    const settled = run(quiet(startRound(armed())), busy);
    assert.equal(settled.result.color, color, `X=${busy}`);
    assert.equal(settled.result.noise, busy - 72);
    assert.equal(settled.result.finalHeat, 100 + busy - 72);
    assert.deepEqual(settled.result.event, { startBlock: 1599, endBlock: 1779, busy, baseline: 72 });
    assert.equal(marketPrices(settled)[color], 1);
    invariants(settled);
  }
});

test('action heat shifts the thresholds but is capped at plus or minus three', () => {
  let state = startRound(armed());
  for (let index = 0; index < 3; index += 1) state = playerAction(state, 1);
  assert.equal(state.heat, 103);
  rejects(() => playerAction(state, 1), 'NO_TICKETS');
  const settled = run(state, 73);
  assert.equal(settled.result.actionHeat, 103);
  assert.equal(settled.result.finalHeat, 104);
  assert.equal(settled.result.color, 'red');
  let low = startRound(armed());
  low = playerAction(playerAction(low, -1), -1);
  low.participants[0].tickets = 3;
  low = playerAction(low, -1);
  low.participants[0].tickets = 3;
  rejects(() => playerAction(low, -1), 'HEAT_LIMIT');
  assert.equal(low.heat, 97);
  low = playerAction(low, 1);
  assert.equal(low.heat, 98);
});

test('twenty bots cannot push heat past the cap and still trade as blocks arrive', () => {
  for (const seed of [1, 2, 3]) {
    let state = startRound(armed({ botCount: 20, seed }));
    for (const block of window(state, 72)) {
      state = ingestBlocks(state, [block]);
      assert.ok(Math.abs(state.heat - 100) <= 3);
    }
    assert.equal(state.phase, 'settled');
    assert.ok(state.tradeCount > 50);
    assert.ok(state.participants.slice(1).some(item => item.tradeCount > 0));
    invariants(state);
  }
});

test('scenario odds track the remaining blocks exactly and collapse at the end', () => {
  const state = quiet(startRound(armed()));
  const start = scenarioOdds(state);
  close(start.red + start.black + start.green, 1, 1e-12);
  const hot = ingestBlocks(state, window(state, 100, 100));
  assert.ok(scenarioOdds(hot).red > 0.99);
  const cold = ingestBlocks(state, window(state, 0, 100));
  assert.ok(scenarioOdds(cold).black > 0.9);
  const nearlyDone = ingestBlocks(state, window(state, 72, 179));
  const odds = scenarioOdds(nearlyDone);
  close(odds.red + odds.black + odds.green, 1, 1e-12);
  assert.ok(odds.green > 0.99);
  const shifted = structuredClone(nearlyDone);
  shifted.heat = 103;
  close(scenarioOdds(shifted).red, 0.4, 1e-9);
  close(scenarioOdds(shifted).green, 0.6, 1e-9);
});

test('winners are paid one point per share and losers nothing after a chain settlement', () => {
  let state = startRound(armed());
  state = executeTrade(state, 'player', 'red', 'buy', 40);
  state = executeTrade(state, 'player', 'black', 'buy', 30);
  state = executeTrade(state, 'player', 'green', 'buy', 20);
  const before = trader(state).balance;
  const holdings = structuredClone(trader(state).holdings);
  const settled = run(state, 100);
  assert.equal(settled.result.color, 'red');
  close(trader(settled).balance - before, holdings.red);
  assert.equal(settled.result.payouts.player, holdings.red);
  assert.deepEqual(trader(settled).holdings, { red: 0, black: 0, green: 0 });
  close(trader(settled).realizedPnl, trader(settled).balance - 1000);
  invariants(settled);
});

test('a voided round refunds open positions at their cost basis and leaves no result record', () => {
  let state = startRound(armed({ botCount: 20 }));
  state = ingestBlocks(state, window(state, 20, 60));
  state = executeTrade(state, 'player', 'red', 'buy', 100);
  state = executeTrade(state, 'player', 'green', 'buy', 50);
  const untouched = state;
  state = executeTrade(state, 'player', 'red', 'sell', 40);
  const basis = trader(state).costBasis.red + trader(state).costBasis.green;
  const cash = trader(state).balance;
  const voided = voidRound(state, 'test outage');
  assert.equal(voided.phase, 'settled');
  assert.equal(voided.result.voided, true);
  assert.equal(voided.result.reason, 'test outage');
  close(trader(voided).balance, cash + basis);
  assert.deepEqual(trader(voided).holdings, { red: 0, black: 0, green: 0 });
  assert.deepEqual(trader(voided).costBasis, { red: 0, black: 0, green: 0 });
  assert.deepEqual(voided.market.q, { red: 0, black: 0, green: 0 });
  assert.equal(voided.results.length, 0);
  // Only the closed 40 shares keep their result; the open ones come back at cost.
  close(voided.result.profits.player, trader(voided).balance - 1000);
  close(trader(voided).realizedPnl, voided.result.profits.player);
  close(trader(voidRound(untouched, 'no sales')).balance, 1000);
  for (const color of COLORS) assert.ok(Number.isFinite(marketPrices(voided)[color]));
  invariants(voided);
  const next = nextRound(voided);
  assert.equal(next.event, null);
  assert.equal(next.phase, 'ready');
  rejects(() => voidRound(next, 'again'), 'INVALID_PHASE');
  rejects(() => voidRound(createGame(1), 'local'), 'NOT_CHAIN_EVENT');
});

test('the next chain round needs a fresh baseline and keeps funds and stats', () => {
  const settled = run(executeTrade(startRound(armed()), 'player', 'green', 'buy', 30), 72);
  const next = nextRound(settled);
  assert.equal(next.event, null);
  assert.equal(next.round, 2);
  assert.equal(next.market.cash, settled.market.cash);
  assert.equal(next.mode, 'chain');
  assert.deepEqual(next.market.q, { red: 0, black: 0, green: 0 });
  rejects(() => startRound(next), 'EVENT_NOT_ARMED');
  const again = armChainEvent(next, baseline(120, 9000));
  assert.equal(again.event.baseline, 36);
  close(marketPrices(again).red, scenarioOdds(again).red, 1e-9);
  invariants(startRound(again));
});

test('local rounds are untouched: uniform open, seeded noise and no event fields in play', () => {
  const state = createGame(5);
  assert.deepEqual(marketPrices(state), { red: 1 / 3, black: 1 / 3, green: 1 / 3 });
  const settled = advance(startRound(state), 60000);
  assert.equal(settled.phase, 'settled');
  assert.ok(Math.abs(settled.result.noise) <= settled.noiseRange);
  assert.equal(settled.result.event, undefined);
  rejects(() => ingestBlocks(settled, []), 'NOT_CHAIN_EVENT');
});
