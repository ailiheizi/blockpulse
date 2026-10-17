import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  createGame, resetGame, startRound, advance, executeTrade, quoteTrade,
  playerAction, nextRound, marketPrices, scenarioOdds, participantStats, GameError,
} from '../dist/game.js';

const trader = (state, id = 'player') => state.participants.find(item => item.id === id);
const close = (actual, expected, tolerance = 0.000002) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const rejects = (fn, code) => assert.throws(fn, error => error instanceof GameError && error.code === code && Boolean(error.reason));

function invariants(state) {
  close(state.participants.reduce((sum, item) => sum + item.balance, 0) + state.market.cash, state.initialTotal);
  assert.ok(state.market.cash >= 0);
  for (const color of ['red', 'black', 'green']) {
    assert.equal(state.market.q[color], state.participants.reduce((sum, item) => sum + item.holdings[color], 0));
    assert.ok(state.market.cash >= state.market.q[color]);
  }
  for (const item of state.participants) {
    assert.ok(item.balance >= 0);
    assert.ok(item.tickets >= 0 && item.tickets <= 3);
    assert.ok(item.maxDrawdown >= 0 && item.maxDrawdown <= 1);
    const stats = participantStats(state, item.id);
    close(stats.pnl, stats.realizedPnl + stats.unrealizedPnl);
  }
}

test('new sessions expose schema, modes and an explicit independent maker reserve', () => {
  const state = createGame(0);
  assert.equal(state.schemaVersion, 2);
  assert.equal(state.phase, 'ready');
  assert.equal(state.initialTotal, 4000);
  assert.equal(state.participants.length, 3);
  assert.equal(state.noiseRange, 12);
  assert.equal(state.remainingMs, 60000);
  assert.deepEqual(resetGame(0), state);
  const crowd = createGame(0, { botCount: 20 });
  assert.equal(crowd.participants.length, 21);
  assert.equal(new Set(crowd.participants.map(item => item.id)).size, 21);
  assert.equal(crowd.initialTotal, 22000);
  assert.equal(crowd.noiseRange, 66);
  assert.deepEqual(marketPrices(state), { red: 0.45, black: 0.45, green: 0.1 });
  rejects(() => createGame(NaN), 'INVALID_SEED');
  rejects(() => createGame(1, { botCount: 3 }), 'INVALID_BOT_COUNT');
  invariants(state);
  invariants(crowd);
});

test('ready previews are pure and cost reflects depth, price impact and fees', () => {
  const state = createGame(42);
  const before = structuredClone(state);
  const quote = quoteTrade(state, 'player', 'red', 'buy', 100);
  assert.deepEqual(state, before);
  assert.equal(quote.canExecute, false);
  assert.equal(quote.code, 'MARKET_CLOSED');
  assert.ok(quote.averagePrice > 1 / 3);
  assert.ok(quote.pricesAfter.red > quote.spotPrice);
  assert.ok(quote.fee > 0);
  close(quote.total, quote.gross + quote.fee);
  assert.equal(quote.winPayout, 100);
  close(quote.winProfit, 100 - quote.total);
  const huge = structuredClone(state);
  huge.market.q.red = 1000000;
  assert.ok(Number.isFinite(quoteTrade(huge, 'player', 'red', 'buy', 1).gross));
  rejects(() => quoteTrade(state, 'unknown', 'red', 'buy', 1), 'INVALID_TRADER');
  rejects(() => quoteTrade(state, 'player', 'blue', 'buy', 1), 'INVALID_COLOR');
  rejects(() => quoteTrade(state, 'player', 'red', 'short', 1), 'INVALID_SIDE');
  for (const value of [0, -1, 1.5, 1001, Infinity, NaN, '5']) rejects(() => quoteTrade(state, 'player', 'red', 'buy', value), 'INVALID_SHARES');
});

test('buy/sell round trip loses its fees and cannot mint points; no short selling', () => {
  const initial = startRound(createGame());
  const before = structuredClone(initial);
  const buyQuote = quoteTrade(initial, 'player', 'red', 'buy', 100);
  const bought = executeTrade(initial, 'player', 'red', 'buy', 100);
  assert.deepEqual(initial, before);
  close(trader(bought).balance, 1000 - buyQuote.total);
  close(trader(bought).costBasis.red, buyQuote.total);
  assert.equal(bought.market.q.red, 100);
  assert.equal(trader(bought).holdings.red, 100);
  rejects(() => executeTrade(bought, 'player', 'red', 'sell', 101), 'INSUFFICIENT_HOLDINGS');
  const sellQuote = quoteTrade(bought, 'player', 'red', 'sell', 100);
  const sold = executeTrade(bought, 'player', 'red', 'sell', 100);
  assert.ok(trader(sold).balance < 1000);
  close(1000 - trader(sold).balance, buyQuote.total - sellQuote.total);
  assert.ok(1000 - trader(sold).balance >= buyQuote.fee + sellQuote.fee - 0.000001);
  assert.equal(trader(sold).costBasis.red, 0);
  assert.equal(trader(sold).holdings.red, 0);
  close(trader(sold).realizedPnl, trader(sold).balance - 1000);
  assert.deepEqual(marketPrices(sold), marketPrices(initial));
  invariants(bought);
  invariants(sold);
});

test('extreme legal inventory cannot create zero-cost positive buy shares', () => {
  let state = startRound(createGame(42, { botCount: 20 }));
  for (const { id } of state.participants) state = executeTrade(state, id, 'red', 'buy', 995);
  assert.equal(state.market.q.red, 20895);
  const quote = quoteTrade(state, 'player', 'black', 'buy', 1);
  assert.equal(quote.canExecute, true);
  assert.ok(quote.gross >= 0.000001);
  assert.ok(quote.fee >= 0.000001);
  assert.ok(quote.total > 0);
  assert.ok(Number.isFinite(quote.roi));
  const bought = executeTrade(state, 'player', 'black', 'buy', 1);
  assert.ok(trader(bought).balance < trader(state).balance);
  assert.ok(participantStats(bought, 'player').equity < participantStats(state, 'player').equity);
  invariants(bought);
});

test('partial sales remove average cost and net liquidation is separate from realized profit', () => {
  let state = startRound(createGame());
  state = executeTrade(state, 'player', 'black', 'buy', 100);
  const originalBasis = trader(state).costBasis.black;
  state = executeTrade(state, 'player', 'black', 'sell', 40);
  close(trader(state).costBasis.black, originalBasis * 0.6);
  assert.equal(trader(state).holdings.black, 60);
  const stats = participantStats(state, 'player');
  assert.ok(stats.positionValue > 0);
  close(stats.equity, trader(state).balance + stats.positionValue);
  close(stats.pnl, stats.realizedPnl + stats.unrealizedPnl);
  invariants(state);
});

test('own buying cannot fabricate a positive liquidation P&L or equity peak', () => {
  const initial = startRound(createGame());
  const bought = executeTrade(initial, 'player', 'red', 'buy', 100);
  const stats = participantStats(bought, 'player');
  const sale = quoteTrade(bought, 'player', 'red', 'sell', 100);
  close(stats.positionValue, sale.total);
  close(stats.equity, trader(bought).balance + sale.total);
  assert.ok(stats.pnl < 0);
  assert.ok(stats.markPositionValue > stats.positionValue);
  assert.equal(trader(bought).peakEquity, 1000);
  close(trader(bought).maxDrawdown, (1000 - stats.equity) / 1000, 0.00000001);
  const sold = executeTrade(bought, 'player', 'red', 'sell', 100);
  close(participantStats(sold, 'player').equity, stats.equity);
  close(trader(sold).maxDrawdown, trader(bought).maxDrawdown, 0.00000001);
  invariants(sold);
});

test('multi-color liquidation in legal chunks matches actual executable proceeds', () => {
  let state = startRound(createGame(18));
  for (const [color, shares] of [['red', 1000], ['red', 100], ['black', 25], ['green', 40]]) {
    state = executeTrade(state, 'player', color, 'buy', shares);
  }
  const snapshot = structuredClone(state);
  const estimate = participantStats(state, 'player');
  assert.deepEqual(state, snapshot);
  assert.equal(trader(state).holdings.red, 1100);
  assert.ok(estimate.pnl < 0);
  const startingCash = trader(state).balance;
  for (const color of ['red', 'black', 'green']) {
    while (trader(state).holdings[color] > 0) {
      state = executeTrade(state, 'player', color, 'sell', Math.min(1000, trader(state).holdings[color]));
    }
  }
  close(trader(state).balance - startingCash, estimate.positionValue);
  close(trader(state).balance, estimate.equity);
  close(participantStats(state, 'player').pnl, estimate.pnl);
  assert.deepEqual(trader(state).holdings, { red: 0, black: 0, green: 0 });
  invariants(state);
});

test('insufficient cash and collateral reject transactions before state changes', () => {
  const state = startRound(createGame());
  trader(state).balance = 0;
  assert.equal(quoteTrade(state, 'player', 'red', 'buy', 1).code, 'INSUFFICIENT_BALANCE');
  rejects(() => executeTrade(state, 'player', 'red', 'buy', 1), 'INSUFFICIENT_BALANCE');
  trader(state).balance = 1000;
  state.market.cash = 0;
  const snapshot = structuredClone(state);
  rejects(() => executeTrade(state, 'player', 'red', 'buy', 100), 'INSUFFICIENT_RESERVE');
  assert.deepEqual(state, snapshot);
});

test('tickets are limited, quotes do not draw randomness, and all actions close at 55 seconds', () => {
  const initial = startRound(createGame(5));
  let state = initial;
  for (let index = 0; index < 3; index += 1) state = playerAction(state, 1);
  assert.equal(state.heat, 103);
  assert.equal(trader(initial).tickets, 3);
  rejects(() => playerAction(state, -1), 'NO_TICKETS');
  rejects(() => playerAction(initial, 0), 'INVALID_ACTION');
  const locked = advance(initial, 55000);
  assert.equal(locked.phase, 'locked');
  assert.equal(locked.remainingMs, 5000);
  rejects(() => executeTrade(locked, 'player', 'red', 'buy', 1), 'MARKET_CLOSED');
  rejects(() => playerAction(locked, 1), 'ACTION_CLOSED');
  const before = structuredClone(locked);
  quoteTrade(locked, 'player', 'red', 'buy', 10);
  assert.deepEqual(locked, before);
  const almostDone = advance(locked, 4999);
  assert.equal(almostDone.tradeCount, locked.tradeCount);
  assert.equal(almostDone.heat, locked.heat);
  assert.equal(almostDone.phase, 'locked');
  invariants(almostDone);
});

test('scenario odds count discrete green band and legal actions cannot force a color', () => {
  const state = createGame();
  assert.deepEqual(scenarioOdds(state), { red: 10 / 25, black: 10 / 25, green: 5 / 25 });
  for (const botCount of [2, 20]) {
    const game = createGame(3, { botCount });
    for (const delta of [-1, 1]) {
      game.heat = game.baseline + delta * game.participants.length * 3;
      const odds = scenarioOdds(game);
      close(odds.red + odds.black + odds.green, 1);
      assert.ok(odds.red > 0 && odds.black > 0 && odds.green > 0);
      assert.ok(odds.red < 1 && odds.black < 1 && odds.green < 1);
    }
  }
});

test('settlement noise is independent of quote, trade and bot RNG consumption', () => {
  const base = startRound(createGame(1234));
  let traded = executeTrade(base, 'player', 'red', 'buy', 10);
  for (let index = 0; index < 20; index += 1) quoteTrade(traded, 'player', 'red', 'sell', 1);
  traded._rngState = 933;
  const left = advance(base, 60000);
  const right = advance(traded, 60000);
  assert.equal(left.result.noise, right.result.noise);
  assert.ok(!('noise' in base));
});

test('settlement pays winning shares exactly one, clears inventory and books full P&L', () => {
  let state = startRound(createGame(91));
  state = executeTrade(state, 'player', 'red', 'buy', 40);
  state = executeTrade(state, 'player', 'black', 'buy', 30);
  state = executeTrade(state, 'player', 'green', 'buy', 20);
  const locked = advance(state, 55000);
  const beforeBalance = trader(locked).balance;
  const beforeHoldings = structuredClone(trader(locked).holdings);
  const beforeCash = locked.market.cash;
  const closingPrices = marketPrices(locked);
  const settled = advance(locked, 5000);
  assert.equal(settled.phase, 'settled');
  assert.equal(settled.result.payouts.player, beforeHoldings[settled.result.color]);
  close(trader(settled).balance - beforeBalance, beforeHoldings[settled.result.color]);
  close(beforeCash - settled.market.cash, settled.result.totalPayout);
  assert.deepEqual(trader(settled).holdings, { red: 0, black: 0, green: 0 });
  assert.deepEqual(trader(settled).costBasis, { red: 0, black: 0, green: 0 });
  close(trader(settled).realizedPnl, trader(settled).balance - 1000);
  assert.equal(settled.result.finalHeat, settled.result.actionHeat + settled.result.noise);
  assert.deepEqual(settled.result.closingPrices, closingPrices);
  assert.equal(marketPrices(settled)[settled.result.color], 1);
  assert.deepEqual(scenarioOdds(settled), marketPrices(settled));
  assert.deepEqual(settled.history.at(-1).prices, marketPrices(settled));
  assert.equal(advance(settled, 1000), settled);
  assert.equal(settled.results.length, 1);
  invariants(settled);
});

test('seeded decisions, ledger, metrics and payout are invariant to frame step', () => {
  const initial = executeTrade(startRound(createGame(8)), 'player', 'green', 'buy', 30);
  const before = structuredClone(initial);
  const coarse = advance(initial, 60000);
  let fine = initial;
  while (fine.phase !== 'settled') fine = advance(fine, Math.min(137, fine.remainingMs));
  assert.deepEqual(coarse, fine);
  assert.deepEqual(initial, before);
  assert.equal(coarse.block, 120);
  assert.equal(advance(initial, 0), initial);
  rejects(() => advance(initial, -1), 'INVALID_TIME');
  rejects(() => advance(initial, NaN), 'INVALID_TIME');
  invariants(coarse);
});

test('new rounds retain actual funds/stats and adapt depth when maker capital shrinks', () => {
  const settled = advance(startRound(createGame(21)), 60000);
  const next = nextRound(settled);
  assert.equal(next.round, 2);
  assert.equal(next.phase, 'ready');
  assert.equal(next.market.cash, settled.market.cash);
  assert.equal(next.result, null);
  assert.equal(next.tradeCount, 0);
  assert.deepEqual(next.results, settled.results);
  assert.deepEqual(next.participants.map(item => [item.balance, item.realizedPnl, item.tradeCount]), settled.participants.map(item => [item.balance, item.realizedPnl, item.tradeCount]));
  const depleted = structuredClone(settled);
  const transfer = depleted.market.cash - 10;
  depleted.market.cash = 10;
  trader(depleted).balance += transfer;
  const shallow = nextRound(depleted);
  assert.equal(shallow.market.cash, 10);
  assert.ok(shallow.market.b < 150);
  assert.ok(shallow.market.b * Math.log(10) <= 0.8 * 10);
  let started = startRound(shallow);
  started = executeTrade(started, 'player', 'red', 'buy', 5);
  started = executeTrade(started, 'player', 'red', 'sell', 5);
  close(started.participants.reduce((sum, item) => sum + item.balance, 0) + started.market.cash, started.initialTotal);
  depleted.market.cash = 0.5;
  rejects(() => nextRound(depleted), 'RESERVE_EXHAUSTED');
  rejects(() => nextRound(next), 'ROUND_NOT_SETTLED');
  invariants(next);
});

test('crowd bots truly buy and sell with inventories, fees and bounded local performance', () => {
  const start = performance.now();
  const state = advance(startRound(createGame(42, { botCount: 20 })), 60000);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 5000, `20-bot round took ${elapsed.toFixed(0)} ms`);
  assert.ok(state.tradeCount > 100);
  assert.ok(state.participants.slice(1).every(item => item.tradeCount > 0));
  assert.ok(state.trades.some(item => item.side === 'buy'));
  assert.ok(state.trades.some(item => item.side === 'sell'));
  assert.ok(state.trades.every(item => item.fee >= 0 && item.total >= 0));
  assert.ok(state.trades.length <= 400 && state.history.length <= 700 && state.events.length <= 400);
  assert.equal(state.participants.reduce((sum, item) => sum + item.tradeCount, 0), state.tradeCount);
  invariants(state);
});

test('multiple seeds and rounds preserve collateral, inventories and all funding', () => {
  for (const botCount of [2, 20]) {
    for (let seed = 1; seed <= 4; seed += 1) {
      let state = createGame(seed, { botCount });
      for (let round = 0; round < 5; round += 1) {
        state = startRound(state);
        if (quoteTrade(state, 'player', 'red', 'buy', 20).canExecute) state = executeTrade(state, 'player', 'red', 'buy', 20);
        state = advance(state, 18000);
        if (trader(state).tickets > 0) state = playerAction(state, round % 2 ? 1 : -1);
        invariants(state);
        state = advance(state, 37000);
        invariants(state);
        state = advance(state, 5000);
        invariants(state);
        if (state.market.cash < 1) break;
        state = nextRound(state);
      }
    }
  }
});
