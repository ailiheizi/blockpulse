import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePriceEvent, pollPriceEvent, PriceSourceError } from '../dist/price-source.js';

const minute = 60_000;
const iso = ms => new Date(ms).toISOString();
const row = (timeSec, { low = 104, high = 106, open = 105, close = 105, volume = 10 } = {}) => [timeSec, low, high, open, close, volume];
const jsonResponse = value => ({ ok: true, json: async () => value });

function makeFetcher({ epoch, ticker, candles, onRequest } = {}) {
  const calls = [];
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    onRequest?.(url, init);
    if (url.pathname === '/time') return jsonResponse({ epoch });
    if (url.pathname.endsWith('/ticker')) return jsonResponse(ticker ?? { price: '105.25', time: iso(epoch * 1000) });
    if (url.pathname.endsWith('/candles')) return jsonResponse(typeof candles === 'function' ? candles(url) : (candles ?? []));
    return { ok: false, json: async () => ({}) };
  };
  return { fetcher, calls };
}

function expectedTimes(epoch) {
  const startTimeMs = Math.floor(epoch * 1000);
  const aligned = Math.floor(startTimeMs / minute) * minute;
  return { startTimeMs, aligned, referenceTimeMs: aligned - minute, targetTimeMs: aligned + 2 * minute };
}

test('prepares a frozen spec from the exact prior completed candle and JSON-roundtrips', async () => {
  const epoch = 1_800_000_030;
  const times = expectedTimes(epoch);
  const mock = makeFetcher({
    epoch,
    candles: [
      row((times.referenceTimeMs / 1000) + 60, { close: 999 }),
      row((times.referenceTimeMs / 1000) - 60, { close: 888 }),
      row(times.referenceTimeMs / 1000, { low: 104, high: 106, open: 105, close: 104.83 }),
    ],
  });
  const spec = await preparePriceEvent({ fetcher: mock.fetcher });
  assert.deepEqual(JSON.parse(JSON.stringify(spec)), {
    mode: 'price', title: 'SOL/USD 到期价格', source: 'Coinbase Exchange SOL-USD', product: 'SOL-USD',
    startTimeMs: times.startTimeMs, cutoffTimeMs: times.targetTimeMs - 15_000,
    targetTimeMs: times.targetTimeMs, referenceTimeMs: times.referenceTimeMs,
    referenceMicros: 104_830_000,
    lowerMicros: Math.floor(104_830_000 * 9998 / 10000),
    upperMicros: Math.ceil(104_830_000 * 10002 / 10000),
    bandBps: 2, settlementDelayMs: 10_000,
  });
  assert.equal(Object.isFrozen(spec), true);
  assert.deepEqual(mock.calls.map(call => call.url.pathname), ['/time', '/products/SOL-USD/candles']);
  assert.equal(mock.calls[1].url.searchParams.get('granularity'), '60');
  assert.equal(mock.calls[1].url.searchParams.get('start'), iso(times.referenceTimeMs));
  assert.equal(mock.calls[1].url.searchParams.get('end'), iso(times.referenceTimeMs + minute));
  assert.ok(mock.calls.every(call => call.init.cache === 'no-store' && call.init.credentials === 'omit'));
});

test('preparation refuses absent, incomplete, malformed, or out-of-range reference buckets', async () => {
  const epoch = 1_800_000_030;
  const { referenceTimeMs } = expectedTimes(epoch);
  for (const candles of [
    [row(referenceTimeMs / 1000 + 60)],
    [[referenceTimeMs / 1000, 104, 106, 105, 105]],
    [[referenceTimeMs / 1000, 106, 104, 105, 105, 1]],
    [[referenceTimeMs / 1000, 104, 106, 105, Number.NaN, 1]],
  ]) {
    const mock = makeFetcher({ epoch, candles });
    await assert.rejects(preparePriceEvent({ fetcher: mock.fetcher }), error => error instanceof PriceSourceError);
  }
});

test('poll exposes a live ticker only before maturity and does not treat it as settlement', async () => {
  const epoch = 1_800_000_030;
  const times = expectedTimes(epoch);
  const spec = await preparePriceEvent({ fetcher: makeFetcher({ epoch, candles: [row(times.referenceTimeMs / 1000)] }).fetcher });
  let pollEpoch = (times.targetTimeMs + 9_999) / 1000;
  const mock = makeFetcher({ epoch: pollEpoch, ticker: { price: '106.2', time: iso(pollEpoch * 1000) }, candles: [] });
  const observation = await pollPriceEvent(JSON.parse(JSON.stringify(spec)), { fetcher: mock.fetcher });
  assert.deepEqual(observation, {
    mode: 'price', source: 'Coinbase Exchange SOL-USD', product: 'SOL-USD',
    serverTimeMs: times.targetTimeMs + 9_999, priceMicros: 106_200_000,
    priceTimeMs: times.targetTimeMs + 9_999, verified: false,
  });
  assert.deepEqual(mock.calls.map(call => call.url.pathname), ['/time', '/products/SOL-USD/ticker']);
});

test('only settles after server time plus delay from the exact target candle close', async () => {
  const epoch = 1_800_000_030;
  const times = expectedTimes(epoch);
  const spec = await preparePriceEvent({ fetcher: makeFetcher({ epoch, candles: [row(times.referenceTimeMs / 1000)] }).fetcher });
  const targetBucket = times.targetTimeMs - minute;
  const tooEarly = makeFetcher({ epoch: (times.targetTimeMs + 9_999) / 1000, ticker: { price: '777', time: iso((times.targetTimeMs + 9_999)) }, candles: [] });
  assert.equal((await pollPriceEvent(spec, { fetcher: tooEarly.fetcher })).verified, false);
  assert.equal(tooEarly.calls.some(call => call.url.pathname.endsWith('/candles')), false);

  const mature = makeFetcher({
    epoch: (times.targetTimeMs + 10_000) / 1000,
    ticker: { price: '777', time: iso(times.targetTimeMs + 10_000) },
    candles: [
      row(targetBucket / 1000 + 60, { close: 999 }),
      row(targetBucket / 1000 - 60, { close: 888 }),
      row(targetBucket / 1000, { low: 104, high: 106, open: 105, close: 104.79 }),
    ],
  });
  const result = await pollPriceEvent(spec, { fetcher: mature.fetcher });
  assert.deepEqual(result, {
    mode: 'price', source: 'Coinbase Exchange SOL-USD', product: 'SOL-USD',
    serverTimeMs: times.targetTimeMs + 10_000,
    priceMicros: 104_790_000, priceTimeMs: times.targetTimeMs, verified: true,
    targetTimeMs: times.targetTimeMs, candleTimeMs: targetBucket, closeMicros: 104_790_000,
  });
  const candleRequest = mature.calls.find(call => call.url.pathname.endsWith('/candles'));
  assert.equal(candleRequest.url.searchParams.get('start'), iso(targetBucket));
  assert.equal(candleRequest.url.searchParams.get('end'), iso(times.targetTimeMs));
});

test('maturity stays pending on a missing exact bucket, even when other candles and ticker exist', async () => {
  const epoch = 1_800_000_030;
  const times = expectedTimes(epoch);
  const spec = await preparePriceEvent({ fetcher: makeFetcher({ epoch, candles: [row(times.referenceTimeMs / 1000)] }).fetcher });
  const mock = makeFetcher({
    epoch: (times.targetTimeMs + 10_000) / 1000,
    ticker: { price: '1000', time: iso(times.targetTimeMs + 10_000) },
    candles: [row((times.targetTimeMs - minute) / 1000 + 60, { close: 999 })],
  });
  await assert.rejects(pollPriceEvent(spec, { fetcher: mock.fetcher }), { code: 'CANDLE_MISSING' });
});

test('rejects changed threshold/time fields before issuing network reads', async () => {
  const epoch = 1_800_000_030;
  const times = expectedTimes(epoch);
  const spec = await preparePriceEvent({ fetcher: makeFetcher({ epoch, candles: [row(times.referenceTimeMs / 1000)] }).fetcher });
  const mock = makeFetcher({ epoch, ticker: { price: '105', time: iso(epoch * 1000) } });
  await assert.rejects(pollPriceEvent({ ...spec, upperMicros: spec.upperMicros + 1 }, { fetcher: mock.fetcher }), { code: 'INVALID_SPEC' });
  await assert.rejects(pollPriceEvent({ ...spec, targetTimeMs: spec.targetTimeMs + minute }, { fetcher: mock.fetcher }), { code: 'INVALID_SPEC' });
  assert.equal(mock.calls.length, 0);
});

test('unavailable source can be retried and malformed or stale ticker remains an error', async () => {
  const epoch = 1_800_000_030;
  const times = expectedTimes(epoch);
  const spec = await preparePriceEvent({ fetcher: makeFetcher({ epoch, candles: [row(times.referenceTimeMs / 1000)] }).fetcher });
  const failing = async () => { throw new Error('offline'); };
  await assert.rejects(pollPriceEvent(spec, { fetcher: failing }), { code: 'UNAVAILABLE' });
  const retry = makeFetcher({ epoch, ticker: { price: '105.1', time: iso(epoch * 1000) } });
  assert.equal((await pollPriceEvent(JSON.parse(JSON.stringify(spec)), { fetcher: retry.fetcher })).verified, false);
  const stale = makeFetcher({ epoch, ticker: { price: '105.1', time: iso(epoch * 1000 - 30_001) } });
  await assert.rejects(pollPriceEvent(spec, { fetcher: stale.fetcher }), { code: 'TICKER_STALE' });
  const badPrice = makeFetcher({ epoch, ticker: { price: '0x69', time: iso(epoch * 1000) } });
  await assert.rejects(pollPriceEvent(spec, { fetcher: badPrice.fetcher }), { code: 'TICKER_DATA' });
});

test('parses Coinbase ticker decimal-string schema including fractional-second timestamps', async () => {
  const epoch = 1_800_000_030;
  const times = expectedTimes(epoch);
  const spec = await preparePriceEvent({ fetcher: makeFetcher({ epoch, candles: [row(times.referenceTimeMs / 1000)] }).fetcher });
  const mock = makeFetcher({
    epoch,
    ticker: { price: '104.83', time: iso(epoch * 1000).replace('.000Z', '.635907864Z') },
  });
  const observation = await pollPriceEvent(spec, { fetcher: mock.fetcher });
  assert.equal(observation.priceMicros, 104_830_000);
  assert.equal(observation.verified, false);
  for (const price of ['', ' 104.83', '0x68.534', 'Infinity', 'NaN', '0', '-1', '+1', '1e2', null]) {
    const invalid = makeFetcher({ epoch, ticker: { price, time: iso(epoch * 1000) } });
    await assert.rejects(pollPriceEvent(spec, { fetcher: invalid.fetcher }), { code: 'TICKER_DATA' });
  }
});

test('propagates external abort promptly, including when fetch ignores AbortSignal', async () => {
  const epoch = 1_800_000_030;
  const times = expectedTimes(epoch);
  const spec = await preparePriceEvent({ fetcher: makeFetcher({ epoch, candles: [row(times.referenceTimeMs / 1000)] }).fetcher });
  const controller = new AbortController();
  const pending = pollPriceEvent(spec, { signal: controller.signal, fetcher: () => new Promise(() => {}) });
  controller.abort();
  await assert.rejects(pending, { code: 'ABORTED' });
});

test('has a hard eight-second timeout even if fetcher ignores AbortSignal', { timeout: 10_000 }, async () => {
  await assert.rejects(preparePriceEvent({ fetcher: () => new Promise(() => {}) }), { code: 'TIMEOUT' });
});
