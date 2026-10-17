import { MONAD_TESTNET, MonadError } from './monad.js';
import { MARKET_ARTIFACT } from './monad-market-artifact.js';

export const MARKET_RULES = Object.freeze({
  shareWei: 1000000000000000n,
  tradingSeconds: 55,
  roundSeconds: 60,
  maxShares: 1000,
  tickets: 3,
  baseHeat: 100,
  greenBand: Object.freeze([98, 102]),
  noiseRange: 12,
  maxHeatShift: 9,
  feeBps: 30,
  minDelay: 20,
  maxDelay: 2000,
  blockhashWindow: 256,
  // Monad lets an account under its 10 MON reserve send value only once per 3 blocks.
  reserveBlocks: 3,
});

// Shared market for the hosted page; a ?market= link or a locally saved address overrides it.
export const DEFAULT_MARKET_ADDRESS = '';

export const MARKET_COLORS = Object.freeze(['red', 'black', 'green']);
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const ADDRESS = /^0x[\da-f]{40}$/i;
const HASH = /^0x[\da-f]{64}$/i;
const WORD = 64;
const MAX_WORD = 1n << 256n;
const WAD = 1e18;

export const isMarketAddress = value => typeof value === 'string' && ADDRESS.test(value) && !/^0x0{40}$/i.test(value);

const MARKET_ERRORS = Object.freeze({
  NotOwner: '只有合约管理者可以执行这个操作。',
  Reentrancy: '合约正在处理另一笔调用，请稍后重试。',
  InvalidDelay: '随机区块延迟超出合约允许范围。',
  RoundActive: '回合进行中，结算后才能取回储备。',
  RoundNotReady: '本轮还没有到结算时间，或随机区块尚未产出。',
  MarketClosed: '本轮已封盘或尚未开局，现在不能交易或行动。',
  InvalidColor: '请选择红、黑或绿。',
  InvalidShares: '份数必须是 1 至 1,000 的整数。',
  InsufficientPayment: '报价在确认期间上涨，支付额度不够，请重新下单。',
  InsufficientHoldings: '链上持仓不足，不能卖空。',
  InsufficientReserve: '做市储备不足以覆盖所有可能兑付，交易未执行。',
  SlippageExceeded: '成交价变化超过可接受范围，交易未执行。',
  NoTickets: '本轮行动券已用完。',
  HeatLimit: '热度已到达本轮可调整的上下限。',
  HouseTooSmall: '做市储备低于 0.02 MON，请先为市场注资。',
  NothingToClaim: '当前没有可领取的兑付。',
  TransferFailed: 'MON 转账失败，请稍后重试。',
});

function word(value) {
  let number = typeof value === 'boolean' ? BigInt(value) : BigInt(value);
  if (number < 0n) number += MAX_WORD;
  if (number < 0n || number >= MAX_WORD) throw new MonadError('ENCODE', '合约参数超出范围。');
  return number.toString(16).padStart(WORD, '0');
}

export function encodeCall(name, args = []) {
  const selector = MARKET_ARTIFACT.functions[name];
  if (!selector) throw new MonadError('ENCODE', `未知合约方法：${name}`);
  return selector + args.map(word).join('');
}

export function decodeWords(hex) {
  if (typeof hex !== 'string' || !/^0x(?:[\da-f]{64})*$/i.test(hex)) {
    throw new MonadError('INVALID_RESPONSE', '合约返回了无效数据，请确认合约地址与网络。');
  }
  const words = [];
  for (let index = 2; index < hex.length; index += WORD) words.push(BigInt(`0x${hex.slice(index, index + WORD)}`));
  return words;
}

export const toSigned = value => (value >= MAX_WORD >> 1n ? value - MAX_WORD : value);

export function deployData(delay) {
  if (!Number.isInteger(delay) || delay < MARKET_RULES.minDelay || delay > MARKET_RULES.maxDelay) {
    throw new MonadError('ENCODE', '随机区块延迟超出合约允许范围。');
  }
  return MARKET_ARTIFACT.bytecode + word(delay);
}

/** Maps a custom error selector found anywhere in a wallet or RPC error to readable text. */
export function marketErrorMessage(error) {
  let text = '';
  try { text = JSON.stringify(error, (_, value) => (typeof value === 'bigint' ? value.toString() : value)) ?? ''; } catch { /* Cyclic wallet errors fall through. */ }
  text += ` ${error?.message ?? ''}`;
  for (const match of text.matchAll(/0x[\da-f]{8}/gi)) {
    const name = MARKET_ARTIFACT.errors[match[0].toLowerCase()];
    if (name) return MARKET_ERRORS[name];
  }
  return '';
}

export function parseSnapshot(words, readAt = Date.now()) {
  if (!Array.isArray(words) || words.length !== 31) throw new MonadError('INVALID_RESPONSE', '合约快照格式不符，请确认合约版本。');
  const count = index => Number(words[index]);
  const wad = index => Number(words[index]) / WAD;
  const byColor = (start, read) => Object.freeze(Object.fromEntries(MARKET_COLORS.map((color, index) => [color, read(start + index)])));
  if (words[6] > 2n) throw new MonadError('INVALID_RESPONSE', '合约返回了无效结果。');
  return Object.freeze({
    round: count(0),
    startTime: count(1),
    randomBlock: words[2],
    liquidity: wad(3),
    heat: Number(toSigned(words[4])),
    settled: words[5] === 1n,
    result: MARKET_COLORS[count(6)],
    finalHeat: Number(toSigned(words[7])),
    trades: count(8),
    q: byColor(9, count),
    prices: byColor(12, wad),
    houseCash: words[15],
    unclaimed: words[16],
    randomDelay: count(17),
    blockNumber: words[18],
    timestamp: count(19),
    holdings: byColor(20, count),
    ticketsUsed: count(23),
    claimable: words[24],
    basis: byColor(25, index => words[index]),
    owner: `0x${words[28].toString(16).padStart(40, '0')}`,
    nextLiquidity: wad(29),
    startBlock: words[30],
    readAt,
  });
}

/** Phase from the chain's own clock; nowSeconds should be extrapolated from the last read. */
export function marketPhase(snapshot, nowSeconds = snapshot.timestamp, head = snapshot.blockNumber) {
  if (!snapshot.round) return 'idle';
  if (snapshot.settled) return 'settled';
  if (nowSeconds < snapshot.startTime + MARKET_RULES.tradingSeconds && head < snapshot.randomBlock) return 'trading';
  if (nowSeconds >= snapshot.startTime + MARKET_RULES.roundSeconds && head > snapshot.randomBlock) return 'settleable';
  return 'locked';
}

export function scenarioOdds(heat) {
  const counts = { red: 0, black: 0, green: 0 };
  const [low, high] = MARKET_RULES.greenBand;
  for (let noise = -MARKET_RULES.noiseRange; noise <= MARKET_RULES.noiseRange; noise += 1) {
    const value = heat + noise;
    counts[value > high ? 'red' : value < low ? 'black' : 'green'] += 1;
  }
  const total = 2 * MARKET_RULES.noiseRange + 1;
  return Object.fromEntries(MARKET_COLORS.map(color => [color, counts[color] / total]));
}

export function createRpc({ url = MONAD_TESTNET.rpcUrl, fetcher = (...args) => globalThis.fetch(...args), timeoutMs = 8000 } = {}) {
  let nextId = 0;
  return async function request(method, params = [], { signal } = {}) {
    const controller = new AbortController();
    const id = ++nextId;
    let timedOut = false;
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      if (controller.signal.aborted) throw new MonadError('ABORTED', '已取消读取。');
      const response = await fetcher(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
      });
      if (!response.ok) throw new MonadError('RPC_HTTP', response.status === 429 ? '测试网 RPC 繁忙，请稍后重试。' : '测试网 RPC 暂不可用，请稍后重试。');
      const body = await response.json();
      if (body?.jsonrpc !== '2.0' || body.id !== id) throw new MonadError('RPC_RESPONSE', '测试网 RPC 返回错误，请稍后重试。');
      if (body.error) {
        const error = new MonadError('RPC_ERROR', marketErrorMessage(body.error) || '测试网 RPC 拒绝了请求，请稍后重试。');
        error.data = body.error.data;
        throw error;
      }
      if (!Object.hasOwn(body, 'result')) throw new MonadError('RPC_RESPONSE', '测试网 RPC 返回错误，请稍后重试。');
      return body.result;
    } catch (error) {
      if (signal?.aborted) throw new MonadError('ABORTED', '已取消读取。');
      if (timedOut) throw new MonadError('RPC_TIMEOUT', '测试网 RPC 读取超时，请检查网络后重试。');
      if (error instanceof MonadError) throw error;
      throw new MonadError('RPC_UNAVAILABLE', '无法连接测试网 RPC，请检查网络或稍后重试。');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };
}

export function createMarketClient({ address, rpc = createRpc() }) {
  if (!isMarketAddress(address)) throw new MonadError('INVALID_ADDRESS', '请输入有效的合约地址。');
  const to = address.toLowerCase();
  const call = async (name, args, options) => decodeWords(await rpc('eth_call', [{ to, data: encodeCall(name, args) }, 'latest'], options));
  return Object.freeze({
    address: to,
    async verify(options) {
      const code = await rpc('eth_getCode', [to, 'latest'], options);
      return typeof code === 'string' && code.toLowerCase() === MARKET_ARTIFACT.runtime.toLowerCase();
    },
    async snapshot(user, options) {
      return parseSnapshot(await call('snapshot', [isMarketAddress(user) ? user : ZERO_ADDRESS], options));
    },
    async quote(color, side, shares, options) {
      const index = MARKET_COLORS.indexOf(color);
      if (index < 0 || (side !== 'buy' && side !== 'sell')) throw new MonadError('ENCODE', '请选择颜色和方向。');
      const [gross, fee, total, priceAfter, solvent] = await call('quote', [index, side === 'buy', shares], options);
      return Object.freeze({ gross, fee, total, priceAfter: Number(priceAfter) / WAD, solvent: solvent === 1n });
    },
    /** Reads Trade logs for one round, newest window first, within the public RPC's 100-block log range. */
    async trades(round, fromBlock, toBlock, { maxWindows = 4, ...options } = {}) {
      const trades = [];
      let end = BigInt(toBlock);
      const start = BigInt(fromBlock);
      for (let window = 0; window < maxWindows && end >= start; window += 1) {
        const from = end - 99n > start ? end - 99n : start;
        const logs = await rpc('eth_getLogs', [{
          address: to, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${end.toString(16)}`,
          topics: [MARKET_ARTIFACT.events.Trade, `0x${word(round)}`],
        }], options);
        if (!Array.isArray(logs)) throw new MonadError('RPC_RESPONSE', '成交记录格式无效。');
        for (const log of logs.reverse()) {
          const [color, isBuy, shares, total, fee] = decodeWords(log.data);
          if (color > 2n || !HASH.test(log.transactionHash ?? '')) continue;
          trades.push(Object.freeze({
            trader: `0x${String(log.topics?.[2] ?? '').slice(-40)}`,
            color: MARKET_COLORS[Number(color)], side: isBuy === 1n ? 'buy' : 'sell',
            shares: Number(shares), total, fee, blockNumber: BigInt(log.blockNumber), hash: log.transactionHash,
          }));
        }
        end = from - 1n;
      }
      return trades;
    },
  });
}

export const marketCalls = Object.freeze({
  start: () => ({ data: encodeCall('startRound') }),
  settle: () => ({ data: encodeCall('settle') }),
  claim: () => ({ data: encodeCall('claim') }),
  act: heatUp => ({ data: encodeCall('act', [heatUp]) }),
  buy: (color, shares, value) => ({ data: encodeCall('buy', [MARKET_COLORS.indexOf(color), shares]), value }),
  sell: (color, shares, minProceeds) => ({ data: encodeCall('sell', [MARKET_COLORS.indexOf(color), shares, minProceeds]) }),
  fund: value => ({ data: encodeCall('fund'), value }),
  withdraw: amount => ({ data: encodeCall('withdrawHouse', [amount]) }),
});

export async function sendTransaction(provider, { from, to, data, value = 0n }) {
  const params = { from, data, ...(to ? { to } : {}), ...(value > 0n ? { value: `0x${value.toString(16)}` } : {}) };
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [params] });
  if (typeof hash !== 'string' || !HASH.test(hash)) throw new MonadError('INVALID_RESPONSE', '钱包没有返回有效的交易哈希。');
  return hash;
}

export async function waitForReceipt(rpc, hash, { timeoutMs = 90000, intervalMs = 700, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    let receipt = null;
    try { receipt = await rpc('eth_getTransactionReceipt', [hash]); } catch { /* Transient RPC errors keep polling until the deadline. */ }
    if (receipt && typeof receipt === 'object') {
      return Object.freeze({
        ok: receipt.status === '0x1',
        blockNumber: BigInt(receipt.blockNumber),
        contractAddress: isMarketAddress(receipt.contractAddress) ? receipt.contractAddress : null,
        hash,
      });
    }
    await sleep(intervalMs);
  }
  throw new MonadError('TX_TIMEOUT', '交易已提交，但 90 秒内未确认，可在浏览器中按哈希查看。');
}

/** Blocks for about 57 s, so the random block lands between trading close (55 s) and round end (60 s). */
export async function estimateRandomDelay(rpc, sample = 200) {
  const latest = await rpc('eth_getBlockByNumber', ['latest', false]);
  const head = BigInt(latest?.number ?? '0x0');
  const span = head > BigInt(sample) ? BigInt(sample) : head;
  if (span < 2n) return 150;
  const older = await rpc('eth_getBlockByNumber', [`0x${(head - span).toString(16)}`, false]);
  const seconds = Number(BigInt(latest.timestamp) - BigInt(older.timestamp));
  const blockTime = seconds > 0 ? seconds / Number(span) : 0.4;
  return Math.min(MARKET_RULES.maxDelay, Math.max(MARKET_RULES.minDelay, Math.ceil(57 / blockTime)));
}

export function formatMonPrecise(wei, digits = 4) {
  if (typeof wei !== 'bigint' || wei < 0n) return '—';
  const scale = 10n ** BigInt(18 - digits);
  const rounded = (wei + scale / 2n) / scale;
  if (wei > 0n && rounded === 0n) return `<0.${'0'.repeat(digits - 1)}1`;
  const base = 10n ** BigInt(digits);
  return `${(rounded / base).toLocaleString('en-US')}.${(rounded % base).toString().padStart(digits, '0')}`;
}

export function parseMon(text) {
  if (typeof text !== 'string' || !/^\d{1,9}(?:\.\d{1,18})?$/.test(text.trim())) return null;
  const [whole, fraction = ''] = text.trim().split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}
