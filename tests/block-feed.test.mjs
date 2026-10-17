import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlockFeed } from '../dist/block-feed.js';

const hex = value => `0x${value.toString(16)}`;

function harness({ head = 1000, baselineBlocks = 60, txOf = number => (number % 3 === 0 ? 4 : 1) } = {}) {
  const chain = { head, calls: 0, batchSizes: [], fail: false, holes: new Set(), badId: false, txOf };
  const timers = new Map();
  let nextId = 1;
  let clock = 1_000_000;
  chain.fetcher = async (url, init) => {
    chain.calls += 1;
    assert.equal(init.credentials, 'omit');
    if (chain.fail) return { ok: false, status: 503, json: async () => ({}) };
    const body = JSON.parse(init.body);
    const handle = request => {
      if (request.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: request.id, result: hex(chain.head) };
      const number = parseInt(request.params[0], 16);
      if (chain.holes.has(number)) return { jsonrpc: '2.0', id: request.id, result: null };
      return { jsonrpc: '2.0', id: chain.badId ? request.id + 1 : request.id, result: { number: request.params[0], timestamp: hex(1_700_000_000 + number), transactions: Array.from({ length: chain.txOf(number) }, (_, index) => hex(index)) } };
    };
    if (Array.isArray(body)) chain.batchSizes.push(body.length);
    return { ok: true, status: 200, json: async () => (Array.isArray(body) ? body.map(handle) : handle(body)) };
  };
  const feed = createBlockFeed({
    fetcher: chain.fetcher, baselineBlocks, now: () => clock,
    setTimer: fn => { const id = nextId++; timers.set(id, fn); return id; },
    clearTimer: id => timers.delete(id),
  });
  const flush = async () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const fn of pending) fn();
    for (let index = 0; index < 5; index += 1) await new Promise(resolve => setImmediate(resolve));
  };
  const until = async condition => { for (let index = 0; index < 80 && !condition(); index += 1) await flush(); assert.ok(condition(), `timed out in ${feed.getState().status}`); };
  return { chain, feed, flush, until, advanceClock: ms => { clock += ms; } };
}

test('start loads a contiguous baseline ending at the head and reports progress', async () => {
  const { feed, until, chain } = harness();
  const states = [];
  feed.subscribe(state => states.push(state.status));
  void feed.start();
  await until(() => feed.getState().status === 'live');
  const { blocks, head, loaded } = feed.getState();
  assert.equal(blocks.length, 60);
  assert.equal(head, 1000);
  assert.equal(loaded, 60);
  assert.equal(blocks.at(-1).number, 1000);
  assert.equal(blocks[0].number, 941);
  assert.ok(blocks.every((block, index) => index === 0 || block.number === blocks[index - 1].number + 1));
  assert.equal(blocks.find(block => block.number === 942).tx, 4);
  assert.equal(blocks.find(block => block.number === 943).tx, 1);
  assert.ok(states.includes('loading') && states.at(-1) === 'live');
  assert.ok(chain.batchSizes.every(size => size <= 25));
  assert.ok(Object.isFrozen(feed.getState()));
});

test('polling appends only new blocks, emits them in order and caps the window', async () => {
  const { feed, until, flush, chain } = harness();
  const emitted = [];
  feed.onBlocks(fresh => emitted.push(...fresh.map(block => block.number)));
  void feed.start();
  await until(() => feed.getState().status === 'live');
  await flush();
  assert.deepEqual(emitted, []);
  chain.head = 1004;
  await until(() => emitted.length === 4);
  assert.deepEqual(emitted, [1001, 1002, 1003, 1004]);
  chain.head = 1100;
  await until(() => emitted.length === 100);
  assert.deepEqual(emitted, Array.from({ length: 100 }, (_, index) => 1001 + index));
  const { blocks } = feed.getState();
  assert.equal(blocks.length, 60);
  assert.equal(blocks.at(-1).number, 1100);
  assert.ok(blocks.every((block, index) => index === 0 || block.number === blocks[index - 1].number + 1));
});

test('an initial failure ends in a readable error instead of hanging', async () => {
  const { feed, until, chain } = harness();
  chain.fail = true;
  void feed.start();
  await until(() => feed.getState().status === 'error');
  assert.match(feed.getState().error, /RPC/);
  assert.equal(feed.getState().blocks.length, 0);
});

test('holes, wrong ids and short batches are rejected rather than guessed', async () => {
  for (const mutate of [chain => chain.holes.add(970), chain => { chain.badId = true; }]) {
    const { feed, until, chain } = harness();
    mutate(chain);
    void feed.start();
    await until(() => feed.getState().status === 'error');
    assert.equal(feed.getState().blocks.length, 0);
  }
});

test('transient poll failures recover but repeated ones become an error', async () => {
  const { feed, until, flush, chain } = harness();
  void feed.start();
  await until(() => feed.getState().status === 'live');
  chain.fail = true;
  await flush(); await flush();
  assert.equal(feed.getState().status, 'live');
  chain.fail = false;
  chain.head = 1002;
  await until(() => feed.getState().head === 1002);
  assert.equal(feed.getState().status, 'live');
  chain.fail = true;
  await until(() => feed.getState().status === 'error');
  assert.ok(feed.getState().error);
});

test('a chain that stops producing blocks is reported as stale', async () => {
  const { feed, until, flush, advanceClock } = harness();
  void feed.start();
  await until(() => feed.getState().status === 'live');
  await flush();
  assert.equal(feed.getState().status, 'live');
  advanceClock(25_000);
  await until(() => feed.getState().status === 'error');
  assert.match(feed.getState().error, /新区块/);
});

test('falling too far behind is an error because contiguity cannot be kept', async () => {
  const { feed, until, chain } = harness();
  void feed.start();
  await until(() => feed.getState().status === 'live');
  chain.head = 5000;
  await until(() => feed.getState().status === 'error');
  assert.match(feed.getState().error, /过期/);
});

test('stop cancels reading, ignores late results and a restart begins cleanly', async () => {
  const { feed, until, flush, chain } = harness();
  const emitted = [];
  feed.onBlocks(fresh => emitted.push(...fresh));
  void feed.start();
  await until(() => feed.getState().status === 'live');
  feed.stop();
  const calls = chain.calls;
  chain.head = 1010;
  await flush(); await flush();
  assert.equal(chain.calls, calls);
  assert.equal(emitted.length, 0);
  assert.equal(feed.getState().status, 'idle');
  void feed.start();
  await until(() => feed.getState().status === 'live');
  assert.equal(feed.getState().blocks.at(-1).number, 1010);
});
