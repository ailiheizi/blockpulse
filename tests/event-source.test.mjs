import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareMonadEvent, pollMonadEvent } from '../dist/event-source.js';

const hash = n => `0x${n.toString(16).padStart(64, '0')}`;
const block = (n, txs = []) => ({ number: `0x${n.toString(16)}`, hash: hash(n), transactions: txs.map(tx => typeof tx === 'string' ? tx : hash(tx)) });
function mockRpc(handler = () => {}) {
  const calls = [];
  const fetcher = async (_url, init) => {
    const req = JSON.parse(init.body); calls.push(req);
    const result = await handler(req, calls.length);
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: req.id, result }) };
  };
  return { fetcher, calls };
}
function prepMock({ chain = '0x279f', latest = 1000 } = {}) {
  return mockRpc(req => {
    if (req.method === 'eth_chainId') return chain;
    const tag = req.params[0];
    if (tag === 'latest') return block(latest);
    const n = Number(BigInt(tag));
    return block(n, Array.from({ length: 10 }, (_, i) => i));
  });
}

test('prepares fixed future target and fixed low/high bounds from the latest eight blocks', async () => {
  const { fetcher, calls } = prepMock();
  const spec = await prepareMonadEvent({ fetcher });
  assert.deepEqual({ startBlock: spec.startBlock, closeBlock: spec.closeBlock, targetBlock: spec.targetBlock, baseline: spec.baseline, lower: spec.lower, upper: spec.upper, confirmations: spec.confirmations },
    { startBlock: 1000, closeBlock: 1130, targetBlock: 1150, baseline: 10, lower: 9, upper: 11, confirmations: 2 });
  assert.equal(calls.filter(c => c.method === 'eth_getBlockByNumber').length, 9);
  assert.ok(calls.every(c => c.method !== 'eth_sendTransaction'));
});

test('rejects wrong chain and invalid RPC response IDs', async () => {
  await assert.rejects(prepareMonadEvent({ fetcher: prepMock({ chain: '0x1' }).fetcher }), { code: 'WRONG_CHAIN' });
  const { fetcher } = prepMock();
  await assert.rejects(prepareMonadEvent({ fetcher: async (url, init) => {
    const response = await fetcher(url, init); const body = await response.json(); body.id += 9;
    return { ok: true, json: async () => body };
  } }), { code: 'RPC_RESPONSE' });
});

test('poll waits for confirmations, then reads exact target and validates stable hash', async () => {
  const spec = await prepareMonadEvent({ fetcher: prepMock().fetcher });
  const pending = mockRpc(req => req.method === 'eth_chainId' ? '0x279f' : block(1151));
  assert.equal((await pollMonadEvent(spec, { fetcher: pending.fetcher })).verified, false);
  const { fetcher, calls } = mockRpc((req, callNo) => {
    if (req.method === 'eth_chainId') return '0x279f';
    if (req.params[0] === 'latest') return block(1152);
    assert.equal(req.params[0], '0x47e');
    return { ...block(1150, [1, 2, 3].map(hash)), hash: hash(callNo < 4 ? 1150 : 1150) };
  });
  const result = await pollMonadEvent(spec, { fetcher });
  assert.equal(result.verified, true); assert.equal(result.blockNumber, 1150); assert.equal(result.txCount, 3);
  assert.equal(calls.filter(c => c.method === 'eth_getBlockByNumber' && c.params[0] !== 'latest').length, 2);
});

test('rejects missing transactions and target block hash changes', async () => {
  const spec = await prepareMonadEvent({ fetcher: prepMock().fetcher });
  const bad = mockRpc(req => req.method === 'eth_chainId' ? '0x279f' : req.params[0] === 'latest' ? block(1152) : { ...block(1150), transactions: null });
  await assert.rejects(pollMonadEvent(spec, { fetcher: bad.fetcher }), { code: 'RPC_TRANSACTIONS' });
  let reads = 0;
  // Return a distinct hash on the second exact-target read.
  const changing = mockRpc(req => {
    if (req.method === 'eth_chainId') return '0x279f';
    if (req.params[0] === 'latest') return block(1152);
    reads++; return { ...block(1150, [1].map(hash)), hash: hash(1150 + reads) };
  });
  await assert.rejects(pollMonadEvent(spec, { fetcher: changing.fetcher }), { code: 'REORG' });
});

test('failure can be retried, external abort cancels reads, and specs survive JSON roundtrip with fixed bounds', async () => {
  const spec = await prepareMonadEvent({ fetcher: prepMock().fetcher });
  const failing = mockRpc(() => { throw new Error('offline'); });
  await assert.rejects(pollMonadEvent(spec, { fetcher: failing.fetcher }), { code: 'RPC_UNAVAILABLE' });
  const retry = mockRpc(req => req.method === 'eth_chainId' ? '0x279f' : block(1001));
  const restored = JSON.parse(JSON.stringify(spec));
  assert.equal((await pollMonadEvent(restored, { fetcher: retry.fetcher })).verified, false);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(pollMonadEvent(spec, { fetcher: retry.fetcher, signal: controller.signal }), { code: 'ABORTED' });
  const altered = { ...spec, upper: spec.upper + 1 };
  await assert.rejects(pollMonadEvent(altered, { fetcher: retry.fetcher }), { code: 'INVALID_SPEC' });
  const extra = { ...restored, note: 'changed' };
  await assert.rejects(pollMonadEvent(extra, { fetcher: retry.fetcher }), { code: 'INVALID_SPEC' });
});
