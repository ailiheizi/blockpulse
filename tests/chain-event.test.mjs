import test from 'node:test';
import assert from 'node:assert/strict';
import { baselineFromBlocks, busyPmf, isBusy, BUSY_TX_MIN, EVENT_WINDOW_BLOCKS } from '../dist/chain-event.js';

const blocks = (count, busy) => Array.from({ length: count }, (_, index) => ({ number: 100 + index, tx: index < busy ? BUSY_TX_MIN : 1 }));

test('busy means at least the threshold of transactions', () => {
  assert.equal(isBusy(BUSY_TX_MIN - 1), false);
  assert.equal(isBusy(BUSY_TX_MIN), true);
  assert.equal(isBusy(810), true);
  assert.equal(isBusy(-1), false);
  assert.equal(isBusy(2.5), false);
  assert.equal(isBusy('3'), false);
});

test('baseline uses the latest blocks, rounds the expected count and refuses short samples', () => {
  assert.equal(baselineFromBlocks(blocks(299, 100)), null);
  const result = baselineFromBlocks(blocks(600, 246));
  assert.equal(result.sampleBlocks, 600);
  assert.equal(result.busyBlocks, 246);
  assert.equal(result.rate, 0.41);
  assert.equal(result.expected, Math.round(0.41 * EVENT_WINDOW_BLOCKS));
  const long = [...blocks(200, 0), ...blocks(600, 600)];
  assert.equal(baselineFromBlocks(long).busyBlocks, 600);
});

test('a single huge block cannot move the baseline more than one busy block', () => {
  const calm = blocks(600, 240);
  const spike = calm.map((block, index) => (index === 599 ? { ...block, tx: 810 } : block));
  assert.equal(baselineFromBlocks(spike).busyBlocks, 241);
  assert.equal(baselineFromBlocks(calm).busyBlocks, 240);
});

test('baseline rate is clamped so extreme samples keep every outcome possible', () => {
  assert.equal(baselineFromBlocks(blocks(600, 0)).rate, 0.05);
  assert.equal(baselineFromBlocks(blocks(600, 600)).rate, 0.95);
  const pmf = busyPmf(EVENT_WINDOW_BLOCKS, 0.05);
  assert.ok(pmf.every(value => Number.isFinite(value) && value >= 0));
});

test('busy count distribution is a proper binomial', () => {
  for (const [n, rate] of [[180, 0.41], [10, 0.5], [0, 0.3], [1, 0.8]]) {
    const pmf = busyPmf(n, rate);
    assert.equal(pmf.length, n + 1);
    assert.ok(Math.abs(pmf.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
    const mean = pmf.reduce((sum, value, index) => sum + value * index, 0);
    assert.ok(Math.abs(mean - n * rate) < 1e-9, `${n}:${rate} mean ${mean}`);
  }
  const small = busyPmf(2, 0.5);
  assert.ok(Math.abs(small[0] - 0.25) < 1e-12 && Math.abs(small[1] - 0.5) < 1e-12);
});
