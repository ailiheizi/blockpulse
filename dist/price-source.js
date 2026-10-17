const BASE_URL = 'https://api.exchange.coinbase.com';
const PRODUCT = 'SOL-USD';
const SOURCE = 'Coinbase Exchange SOL-USD';
const TITLE = 'SOL/USD 到期价格';
const REQUEST_TIMEOUT_MS = 8000;
const SETTLEMENT_DELAY_MS = 10000;
const MAX_TICKER_AGE_MS = 30000;
const BAND_BPS = 2;
const MICROS_PER_USD = 1_000_000;
const MINUTE_MS = 60_000;
const SPEC_KEYS = [
  'mode', 'title', 'source', 'product', 'startTimeMs', 'cutoffTimeMs',
  'targetTimeMs', 'referenceTimeMs', 'referenceMicros', 'lowerMicros',
  'upperMicros', 'bandBps', 'settlementDelayMs',
];

export class PriceSourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PriceSourceError';
    this.code = code;
  }
}

function fail(code, message) { throw new PriceSourceError(code, message); }

function createRequestContext(signal) {
  const controller = new AbortController();
  let timedOut = false;
  let aborted = false;
  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  // The deadline promise remains observed by each request race; callers still get
  // a hard eight-second bound when a custom fetcher ignores AbortSignal.
  deadline.catch(() => {});
  const relayAbort = () => {
    aborted = true;
    controller.abort();
    rejectDeadline(new PriceSourceError('ABORTED', '已取消 Coinbase 行情读取。'));
  };
  if (signal?.aborted) relayAbort();
  else signal?.addEventListener('abort', relayAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectDeadline(new PriceSourceError('TIMEOUT', 'Coinbase 行情读取超过 8 秒，请稍后重试。'));
  }, REQUEST_TIMEOUT_MS);
  return {
    signal: controller.signal,
    check() {
      if (aborted || signal?.aborted) fail('ABORTED', '已取消 Coinbase 行情读取。');
      if (timedOut) fail('TIMEOUT', 'Coinbase 行情读取超过 8 秒，请稍后重试。');
    },
    race(promise) { return Promise.race([promise, deadline]); },
    async fetchJson(fetcher, url, label) {
      this.check();
      let response;
      try {
        response = await this.race(fetcher(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        }));
      } catch (error) {
        this.check();
        if (error instanceof PriceSourceError) throw error;
        fail('UNAVAILABLE', `Coinbase ${label}暂不可用，请检查网络后重试。`);
      }
      this.check();
      if (!response?.ok) fail('HTTP', `Coinbase ${label}请求失败，请稍后重试。`);
      try {
        const value = await this.race(response.json());
        this.check();
        return value;
      } catch (error) {
        this.check();
        if (error instanceof PriceSourceError) throw error;
        fail('JSON', `Coinbase ${label}返回的数据无法解析，请重试。`);
      }
    },
    close() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', relayAbort);
    },
  };
}

function assertFetcher(fetcher) {
  if (typeof fetcher !== 'function') fail('FETCHER', '无法读取 Coinbase 行情，请检查浏览器网络支持。');
}

function positiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('DATA', `${label}格式无效。`);
  return value;
}

function parseServerTime(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || typeof body.epoch !== 'number' || !Number.isFinite(body.epoch) || body.epoch <= 0) {
    fail('TIME_RESPONSE', 'Coinbase server time格式无效，事件保持待准备。');
  }
  const timeMs = Math.floor(body.epoch * 1000);
  return positiveSafeInteger(timeMs, 'Coinbase server time');
}

function asMicros(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) fail('CANDLE_DATA', `${label}价格无效。`);
  const micros = Math.round(value * MICROS_PER_USD);
  return positiveSafeInteger(micros, `${label}微美元价格`);
}

function tickerMicros(value) {
  // Coinbase Exchange serializes ticker prices as decimal strings. Reject
  // whitespace, exponents, hex, signs, and non-finite spellings explicitly.
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    fail('TICKER_DATA', 'Coinbase ticker价格格式无效。');
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) fail('TICKER_DATA', 'Coinbase ticker价格无效。');
  return asMicros(numeric, 'ticker');
}

function candleFromRow(row, label) {
  if (!Array.isArray(row) || row.length !== 6) fail('CANDLE_DATA', `Coinbase ${label}K线格式无效。`);
  const timeSec = row[0];
  if (!Number.isSafeInteger(timeSec) || timeSec < 0) fail('CANDLE_DATA', `Coinbase ${label}K线时间无效。`);
  const low = asMicros(row[1], `${label}最低`);
  const high = asMicros(row[2], `${label}最高`);
  const open = asMicros(row[3], `${label}开盘`);
  const close = asMicros(row[4], `${label}收盘`);
  if (typeof row[5] !== 'number' || !Number.isFinite(row[5]) || row[5] < 0) fail('CANDLE_DATA', `Coinbase ${label}K线成交量无效。`);
  if (low > high || open < low || open > high || close < low || close > high) fail('CANDLE_DATA', `Coinbase ${label}K线OHLC边界不一致。`);
  return { timeSec, lowMicros: low, highMicros: high, openMicros: open, closeMicros: close };
}

function findExactCandle(rows, bucketStartMs, label) {
  if (!Array.isArray(rows)) fail('CANDLE_RESPONSE', `Coinbase ${label}K线响应格式无效。`);
  const bucketStartSec = bucketStartMs / 1000;
  const matches = rows.filter(row => Array.isArray(row) && row[0] === bucketStartSec);
  if (matches.length !== 1) fail('CANDLE_MISSING', `Coinbase尚未提供目标${label}分钟收盘K线，请稍后重试。`);
  return candleFromRow(matches[0], label);
}

function isoRange(startMs) {
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + MINUTE_MS).toISOString(),
  };
}

function candleUrl(startMs) {
  const range = isoRange(startMs);
  const query = new URLSearchParams({ granularity: '60', start: range.start, end: range.end });
  return `${BASE_URL}/products/${PRODUCT}/candles?${query}`;
}

async function getServerTime(ctx, fetcher) {
  const json = await ctx.fetchJson(fetcher, `${BASE_URL}/time`, 'server time');
  return parseServerTime(json);
}

async function getCandles(ctx, fetcher, startMs, label) {
  const rows = await ctx.fetchJson(fetcher, candleUrl(startMs), `${label}K线`);
  return findExactCandle(rows, startMs, label);
}

function calculateBounds(referenceMicros) {
  return {
    lowerMicros: Math.floor(referenceMicros * (10_000 - BAND_BPS) / 10_000),
    upperMicros: Math.ceil(referenceMicros * (10_000 + BAND_BPS) / 10_000),
  };
}

function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)
    || Object.keys(spec).length !== SPEC_KEYS.length
    || SPEC_KEYS.some(key => !Object.hasOwn(spec, key))) {
    fail('INVALID_SPEC', '价格事件规格字段不完整或包含未知字段，请重新准备事件。');
  }
  const safePositive = key => Number.isSafeInteger(spec[key]) && spec[key] > 0;
  const alignedMinute = Math.floor(spec.startTimeMs / MINUTE_MS) * MINUTE_MS;
  const expectedReferenceTime = alignedMinute - MINUTE_MS;
  const expectedTargetTime = alignedMinute + 2 * MINUTE_MS;
  const bounds = calculateBounds(spec.referenceMicros);
  if (spec.mode !== 'price' || spec.title !== TITLE || spec.source !== SOURCE || spec.product !== PRODUCT
    || !safePositive('startTimeMs') || !safePositive('cutoffTimeMs') || !safePositive('targetTimeMs')
    || !safePositive('referenceTimeMs') || !safePositive('referenceMicros')
    || !safePositive('lowerMicros') || !safePositive('upperMicros')
    || spec.referenceTimeMs !== expectedReferenceTime
    || spec.targetTimeMs !== expectedTargetTime
    || spec.cutoffTimeMs !== expectedTargetTime - 15_000
    || spec.lowerMicros !== bounds.lowerMicros || spec.upperMicros !== bounds.upperMicros
    || spec.bandBps !== BAND_BPS || spec.settlementDelayMs !== SETTLEMENT_DELAY_MS) {
    fail('INVALID_SPEC', '价格事件来源、固定阈值或目标时间无效，请重新准备事件。');
  }
}

export async function preparePriceEvent({ fetcher = globalThis.fetch, signal } = {}) {
  assertFetcher(fetcher);
  const ctx = createRequestContext(signal);
  try {
    const startTimeMs = await getServerTime(ctx, fetcher);
    const alignedMinute = Math.floor(startTimeMs / MINUTE_MS) * MINUTE_MS;
    const referenceTimeMs = alignedMinute - MINUTE_MS;
    const referenceCandle = await getCandles(ctx, fetcher, referenceTimeMs, '参考');
    const { lowerMicros, upperMicros } = calculateBounds(referenceCandle.closeMicros);
    return Object.freeze({
      mode: 'price', title: TITLE, source: SOURCE, product: PRODUCT,
      startTimeMs,
      cutoffTimeMs: alignedMinute + 2 * MINUTE_MS - 15_000,
      targetTimeMs: alignedMinute + 2 * MINUTE_MS,
      referenceTimeMs,
      referenceMicros: referenceCandle.closeMicros,
      lowerMicros, upperMicros,
      bandBps: BAND_BPS,
      settlementDelayMs: SETTLEMENT_DELAY_MS,
    });
  } finally { ctx.close(); }
}

function parseTicker(body, serverTimeMs) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('TICKER_RESPONSE', 'Coinbase ticker响应格式无效，请稍后重试。');
  const priceMicros = tickerMicros(body.price);
  if (typeof body.time !== 'string') fail('TICKER_RESPONSE', 'Coinbase ticker时间格式无效，请稍后重试。');
  const parsedTime = Date.parse(body.time);
  const priceTimeMs = positiveSafeInteger(parsedTime, 'Coinbase ticker时间');
  if (priceTimeMs > serverTimeMs + 5_000 || serverTimeMs - priceTimeMs > MAX_TICKER_AGE_MS) {
    fail('TICKER_STALE', 'Coinbase ticker时间过旧或超前，事件保持待更新。');
  }
  return { priceMicros, priceTimeMs };
}

export async function pollPriceEvent(spec, { fetcher = globalThis.fetch, signal } = {}) {
  validateSpec(spec);
  assertFetcher(fetcher);
  const ctx = createRequestContext(signal);
  try {
    const serverTimeMs = await getServerTime(ctx, fetcher);
    if (serverTimeMs >= spec.targetTimeMs + spec.settlementDelayMs) {
      const candleTimeMs = spec.targetTimeMs - MINUTE_MS;
      const candle = await getCandles(ctx, fetcher, candleTimeMs, '目标');
      return {
        mode: 'price', source: SOURCE, product: PRODUCT,
        serverTimeMs,
        priceMicros: candle.closeMicros,
        priceTimeMs: spec.targetTimeMs,
        verified: true,
        targetTimeMs: spec.targetTimeMs,
        candleTimeMs,
        closeMicros: candle.closeMicros,
      };
    }
    const ticker = await ctx.fetchJson(fetcher, `${BASE_URL}/products/${PRODUCT}/ticker`, 'ticker');
    const { priceMicros, priceTimeMs } = parseTicker(ticker, serverTimeMs);
    return {
      mode: 'price', source: SOURCE, product: PRODUCT,
      serverTimeMs, priceMicros, priceTimeMs, verified: false,
    };
  } finally { ctx.close(); }
}
