import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, placeBet, startRound, advance, playerAction,
  settleRound, nextRound, resetGame, GameError,
} from '../dist/game.js';

const find = (state, id = 'player') => state.participants.find(p => p.id === id);
const begin = (seed = 42, color = 'red', stake = 100) => startRound(placeBet(createGame(seed), color, stake));
const conserved = state => assert.equal(
  state.participants.reduce((sum, p) => sum + p.balance, 0) + state.pool, 3000,
);
const rejects = (fn, code) => assert.throws(fn, error => error instanceof GameError && error.code === code);

test('initial and reset state contain three independent 1000-point participants', () => {
  const first = createGame(0);
  const second = createGame(0);
  assert.equal(first.phase, 'betting');
  assert.equal(first.round, 1);
  assert.equal(first.heat, 100);
  assert.equal(first.remainingMs, 15000);
  assert.deepEqual(first, second);
  assert.notEqual(first.participants, second.participants);
  assert.deepEqual(resetGame(0), first);
  conserved(first);
});

test('placing a bet locks only the stake and never mutates previous state', () => {
  const before = createGame();
  const snapshot = structuredClone(before);
  const after = placeBet(before, 'green', 50);
  assert.deepEqual(before, snapshot);
  assert.equal(find(after).balance, 950);
  assert.deepEqual(find(after).bet, { color: 'green', stake: 50 });
  assert.equal(after.pool, 50);
  rejects(() => placeBet(after, 'red', 20), 'BET_ALREADY_LOCKED');
  rejects(() => placeBet(before, 'blue', 50), 'INVALID_COLOR');
  rejects(() => placeBet(before, 'red', 25), 'INVALID_STAKE');
  rejects(() => startRound(before), 'BET_REQUIRED');
  conserved(after);
});

test('bots lock matching stakes capped by available points; betting closes', () => {
  const state = createGame(2);
  find(state, 'momentum').balance = 10;
  find(state, 'reversion').balance = 1990;
  const active = startRound(placeBet(state, 'black', 100));
  assert.equal(active.phase, 'active');
  assert.equal(find(active, 'momentum').bet.stake, 10);
  assert.equal(find(active, 'momentum').balance, 0);
  assert.equal(find(active, 'reversion').bet.stake, 100);
  assert.equal(active.pool, 210);
  assert.ok(active.participants.every(p => p.tickets === 3));
  rejects(() => placeBet(active, 'red', 20), 'BETTING_CLOSED');
  conserved(active);
});

test('actions use a maximum of three tickets and never charge points', () => {
  const initial = begin();
  const one = playerAction(initial, 1);
  const two = playerAction(one, -1);
  const three = playerAction(two, 1);
  assert.equal(initial.heat, 100);
  assert.equal(two.heat, 100);
  assert.equal(three.heat, 101);
  assert.equal(find(three).tickets, 0);
  assert.equal(find(three).balance, find(initial).balance);
  rejects(() => playerAction(three, -1), 'NO_TICKETS');
  rejects(() => playerAction(initial, 0), 'INVALID_ACTION');
  rejects(() => playerAction(createGame(), 1), 'ACTION_CLOSED');
  conserved(three);
});

test('seeded schedules and settlement are independent of timer frame rate', () => {
  const initial = begin(1234, 'black', 50);
  const snapshot = structuredClone(initial);
  const oneStep = advance(initial, 15000);
  let manySteps = initial;
  for (let time = 0; time < 15000; time += 37) {
    manySteps = advance(manySteps, Math.min(37, 15000 - time));
  }
  assert.deepEqual(oneStep, manySteps);
  assert.deepEqual(initial, snapshot);
  assert.equal(oneStep.phase, 'settled');
  assert.equal(oneStep.block, 30);
  assert.equal(oneStep.history.filter(p => p.timeMs > 0 && p.timeMs % 500 === 0).length, 30);
  assert.ok(oneStep.events.every((entry, index, list) => index === 0 || entry.timeMs >= list[index - 1].timeMs));
  assert.ok(oneStep.participants.every(p => p.tickets >= 0 && p.tickets <= 3));
  assert.ok(oneStep._botSchedule.every(entry => entry.done));
  assert.ok(oneStep.events.some(entry => entry.type === 'hold'));
  conserved(oneStep);
});

test('zero time and repeated settlement are idempotent; early settlement fails', () => {
  const initial = begin();
  assert.equal(advance(initial, 0), initial);
  rejects(() => settleRound(initial), 'ROUND_NOT_FINISHED');
  rejects(() => advance(initial, -1), 'INVALID_TIME');
  const settled = advance(initial, 999999);
  assert.equal(settleRound(settled), settled);
  assert.equal(advance(settled, 1000), settled);
  assert.equal(settled.results.length, 1);
  rejects(() => playerAction(settled, 1), 'ACTION_CLOSED');
  conserved(settled);
});

// Isolate distribution with already-locked stakes, including partial bot stakes.
function payoutFixture(bets, finalHeat) {
  const state = createGame(1);
  state.phase = 'active';
  state.elapsedMs = 15000;
  state.timeMs = 15000;
  state.remainingMs = 0;
  state.heat = finalHeat;
  state.pool = 0;
  state.participants.forEach((p, index) => {
    p.bet = bets[index];
    p.balance -= p.bet.stake;
    state.pool += p.bet.stake;
  });
  return state;
}

test('proportional payouts distribute integer remainders and conserve all 3000 points', () => {
  const settled = settleRound(payoutFixture([
    { color: 'red', stake: 20 },
    { color: 'red', stake: 50 },
    { color: 'black', stake: 20 },
  ], 101));
  assert.equal(settled.result.color, 'red');
  assert.equal(settled.result.pool, 90);
  assert.deepEqual(settled.result.payouts, { player: 26, momentum: 64, reversion: 0 });
  assert.deepEqual(settled.result.profits, { player: 6, momentum: 14, reversion: -20 });
  assert.equal(Object.values(settled.result.profits).reduce((a, b) => a + b, 0), 0);
  assert.equal(settled.pool, 0);
  conserved(settled);
});

test('equal fractional remainders resolve in participant order without burning points', () => {
  const settled = settleRound(payoutFixture([
    { color: 'black', stake: 20 },
    { color: 'black', stake: 20 },
    { color: 'green', stake: 1 },
  ], 99));
  assert.deepEqual(settled.result.payouts, { player: 21, momentum: 20, reversion: 0 });
  conserved(settled);
});

test('no winning color refunds every stake with zero profits', () => {
  const settled = settleRound(payoutFixture([
    { color: 'red', stake: 20 },
    { color: 'red', stake: 50 },
    { color: 'black', stake: 100 },
  ], 100));
  assert.equal(settled.result.color, 'green');
  assert.equal(settled.result.refund, true);
  assert.deepEqual(settled.result.payouts, settled.result.stakes);
  assert.ok(Object.values(settled.result.profits).every(profit => profit === 0));
  assert.ok(settled.participants.every(p => p.balance === 1000));
  conserved(settled);
});

test('green is reachable with no actions and with a +1/-1 pair, without forced nine actions', () => {
  // Select a reproducible seed whose precommitted bots both hold all opportunities.
  let initial;
  for (let seed = 0; seed < 50000; seed += 1) {
    const candidate = begin(seed, 'green', 20);
    if (candidate._botSchedule.every(entry => !entry.willAct)) {
      initial = candidate;
      break;
    }
  }
  assert.ok(initial, 'a seeded all-hold round must be available');
  const quiet = advance(initial, 15000);
  const paired = advance(playerAction(playerAction(initial, 1), -1), 15000);
  assert.equal(quiet.result.color, 'green');
  assert.equal(paired.result.color, 'green');
  assert.equal(find(quiet).tickets, 3);
  assert.equal(find(paired).tickets, 1);
  conserved(quiet);
  conserved(paired);
});

test('next round preserves bankrolls and completed results while resetting heat and tickets', () => {
  const settled = advance(playerAction(begin(22), 1), 15000);
  const next = nextRound(settled);
  assert.equal(next.round, 2);
  assert.equal(next.phase, 'betting');
  assert.equal(next.heat, 100);
  assert.equal(next.remainingMs, 15000);
  assert.equal(next.block, 0);
  assert.equal(next.result, null);
  assert.deepEqual(next.results, settled.results);
  assert.deepEqual(next.participants.map(p => p.balance), settled.participants.map(p => p.balance));
  assert.ok(next.participants.every(p => p.bet === null && p.tickets === 3));
  assert.deepEqual(next.history, [{ timeMs: 0, heat: 100, block: 0 }]);
  rejects(() => nextRound(next), 'ROUND_NOT_SETTLED');
  conserved(next);
});

test('insufficient player bankroll cannot create an unfunded bet', () => {
  const state = createGame();
  find(state).balance = 10;
  find(state, 'momentum').balance = 1990;
  rejects(() => placeBet(state, 'red', 20), 'INSUFFICIENT_BALANCE');
  conserved(state);
});

test('many seeds and rounds preserve integer nonnegative bankrolls without minting points', () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    let state = createGame(seed);
    for (let round = 0; round < 20; round += 1) {
      if (find(state).balance < 20) break;
      state = startRound(placeBet(state, ['red', 'black', 'green'][round % 3], 20));
      state = advance(state, 7000);
      state = playerAction(state, round % 2 ? 1 : -1);
      state = advance(state, 8000);
      conserved(state);
      assert.ok(state.participants.every(p => Number.isInteger(p.balance) && p.balance >= 0));
      assert.equal(Object.values(state.result.payouts).reduce((a, b) => a + b, 0), state.result.pool);
      state = nextRound(state);
    }
  }
});
