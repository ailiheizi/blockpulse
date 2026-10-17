import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, startRound, advance, executeTrade, quoteTrade, scenarioOdds,
  configureEvent, observeEvent, armChainEvent, ingestBlocks, GameError,
} from '../dist/game.js';

const rejects = (fn, code) => assert.throws(fn, error => error instanceof GameError && error.code === code && Boolean(error.reason));

test('busy-block gameplay and its former event APIs are disabled', () => {
  rejects(() => createGame(1, { mode: 'chain' }), 'LEGACY_EVENT_DISABLED');
  rejects(() => configureEvent(null, { mode: 'monad' }), 'LEGACY_EVENT_DISABLED');
  rejects(() => observeEvent(null, {}), 'LEGACY_EVENT_DISABLED');
  rejects(() => armChainEvent(null, [{ number: 1, tx: 100000 }]), 'LEGACY_EVENT_DISABLED');
  rejects(() => ingestBlocks(null, [{ number: 1, tx: 100000 }]), 'LEGACY_EVENT_DISABLED');
});

test('market orders and quotes cannot change the independent practice price path or result', () => {
  let idle = startRound(createGame(9182, { botCount: 2 }));
  let traded = startRound(createGame(9182, { botCount: 2 }));
  const pathStart = idle.event.priceMicros;
  traded = executeTrade(traded, 'player', 'red', 'buy', 100);
  for (let index = 0; index < 20; index += 1) quoteTrade(traded, 'player', 'red', 'sell', 1);
  idle = advance(idle, 60000);
  traded = advance(traded, 60000);
  assert.equal(idle.event.priceMicros, traded.event.priceMicros);
  assert.equal(idle.event.priceMicros !== pathStart, true);
  assert.equal(idle.result.eventPriceMicros, traded.result.eventPriceMicros);
  assert.equal(idle.result.color, traded.result.color);
});

test('logical certainty from the bounded remaining price range locks all sides before bots trade', () => {
  let state = startRound(createGame(1, { botCount: 2 }));
  state = executeTrade(state, 'player', 'red', 'buy', 10);
  state = executeTrade(state, 'player', 'red', 'short', 10);
  const maxStep = 20000;
  state.event.priceMicros = state.event.upperMicros + 120 * maxStep + 1;
  state = advance(state, 500);
  assert.equal(state.phase, 'locked');
  assert.equal(state.event.certainColor, 'red');
  assert.equal(state.event.status, 'locked');
  assert.equal(state.result, null);
  for (const side of ['buy', 'sell', 'short', 'cover']) {
    const color = side === 'sell' ? 'red' : 'red';
    const quote = quoteTrade(state, 'player', color, side, 1);
    assert.equal(quote.canExecute, false, side);
    assert.equal(quote.code, 'MARKET_CLOSED', side);
    rejects(() => executeTrade(state, 'player', color, side, 1), 'MARKET_CLOSED');
  }
  state = advance(state, 59500);
  assert.equal(state.phase, 'settled');
  assert.equal(state.result.color, 'red');
  assert.equal(state.result.eventPriceMicros, state.event.priceMicros);
});

test('independent scenario odds are unchanged by legacy heat and tickets', () => {
  const state = startRound(createGame(44));
  const odds = scenarioOdds(state);
  const changed = structuredClone(state);
  changed.heat = 999999;
  changed.participants[0].tickets = 3;
  assert.deepEqual(scenarioOdds(changed), odds);
});
