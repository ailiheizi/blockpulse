import { MONAD_TESTNET } from './monad.js';

const RPC_TIMEOUT_MS = 8000;
const MAX_PARALLEL = 4;
const SPEC_KEYS = ['mode', 'title', 'chainId', 'source', 'startBlock', 'closeBlock', 'targetBlock', 'baseline', 'lower', 'upper', 'confirmations'];

export class MonadEventError extends Error {
  constructor(code, message) { super(message); this.name = 'MonadEventError'; this.code = code; }
}

function abortError() { return new MonadEventError('ABORTED', '已取消 Monad 事件读取。'); }

async function withRpc({ fetcher, signal }, work) {
  if (typeof fetcher !== 'function') throw new MonadEventError('FETCHER', '无法读取 Monad RPC，请检查网络配置。');
  const controller = new AbortController();
  let timedOut = false;
  const relayAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', relayAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, RPC_TIMEOUT_MS);
  let nextId = 0;
  const rpc = async (method, params) => {
    if (controller.signal.aborted) throw abortError();
    const id = ++nextId;
    const response = await fetcher(MONAD_TESTNET.rpcUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    if (!response?.ok) throw new MonadEventError('RPC_HTTP', 'Monad 测试网 RPC 暂不可用，请稍后重试。');
    let body;
    try { body = await response.json(); } catch { throw new MonadEventError('RPC_RESPONSE', 'Monad RPC 返回的数据无法解析，请重试。'); }
    if (body?.jsonrpc !== '2.0' || body.id !== id || body.error || !Object.hasOwn(body, 'result')) {
      throw new MonadEventError('RPC_RESPONSE', 'Monad RPC 返回错误或请求编号不匹配，请重试。');
    }
    return body.result;
  };
  try { return await work(rpc); }
  catch (error) {
    if (signal?.aborted) throw abortError();
    if (timedOut) throw new MonadEventError('RPC_TIMEOUT', 'Monad RPC 读取超过 8 秒，请稍后重试。');
    if (error instanceof MonadEventError) throw error;
    throw new MonadEventError('RPC_UNAVAILABLE', '无法读取 Monad 测试网，请检查网络后重试。');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
  }
}

function quantity(value, label) {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new MonadEventError('RPC_QUANTITY', `${label}区块数据格式无效，请重试。`);
  const n = Number(BigInt(value));
  if (!Number.isSafeInteger(n) || n < 0) throw new MonadEventError('RPC_QUANTITY', `${label}区块高度超出安全范围。`);
  return n;
}
function validHash(hash) {
  if (typeof hash !== 'string' || !/^0x[\da-f]{64}$/i.test(hash)) throw new MonadEventError('RPC_HASH', 'Monad 返回了无效的区块哈希，请重试。');
  return hash.toLowerCase();
}
function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)
    || Object.keys(spec).length !== SPEC_KEYS.length || SPEC_KEYS.some(key => !Object.hasOwn(spec, key))) {
    throw new MonadEventError('INVALID_SPEC', '事件规格字段不完整或包含未知字段，请重新准备 Monad 事件。');
  }
  const safe = key => Number.isSafeInteger(spec[key]) && spec[key] >= 0;
  const baseline = spec.baseline;
  const lower = Math.max(0, Math.floor(baseline * 0.9));
  const upper = Math.max(lower + 1, Math.ceil(baseline * 1.1));
  if (spec.mode !== 'monad' || spec.title !== 'Monad 未来目标区块交易笔数'
    || spec.source !== 'Monad Testnet RPC' || spec.chainId !== MONAD_TESTNET.chainId
    || !safe('startBlock') || spec.startBlock > Number.MAX_SAFE_INTEGER - 150
    || !safe('closeBlock') || !safe('targetBlock') || !safe('baseline') || baseline < 1
    || !safe('lower') || !safe('upper') || spec.confirmations !== 2
    || spec.closeBlock !== spec.startBlock + 130 || spec.targetBlock !== spec.startBlock + 150
    || spec.lower !== lower || spec.upper !== upper) {
    throw new MonadEventError('INVALID_SPEC', '事件目标区块、网络或固定交易区间无效，请重新准备 Monad 事件。');
  }
}
function parseBlock(block, expectedNumber, includeTransactions = true) {
  if (!block || typeof block !== 'object') throw new MonadEventError('RPC_BLOCK', 'Monad 未返回所需区块，请稍后重试。');
  const number = quantity(block.number, '目标');
  if (expectedNumber !== undefined && number !== expectedNumber) throw new MonadEventError('RPC_BLOCK_NUMBER', 'RPC 返回的区块高度与请求不符，请重试。');
  const hash = validHash(block.hash);
  if (!Array.isArray(block.transactions) || (includeTransactions && block.transactions.some(tx => typeof tx !== 'string' || !/^0x[\da-f]{64}$/i.test(tx)))) {
    throw new MonadEventError('RPC_TRANSACTIONS', '区块交易列表格式无效，无法结算，请重试。');
  }
  return { number, hash, txCount: block.transactions.length };
}
async function assertChain(rpc) {
  const raw = await rpc('eth_chainId', []);
  if (quantity(raw, '网络') !== MONAD_TESTNET.chainId) throw new MonadEventError('WRONG_CHAIN', 'RPC 网络不是 Monad Testnet（chainId 10143），未使用该数据。');
}
async function pool(items, limit, fn) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; await fn(items[i], i); }
  }));
}

export async function prepareMonadEvent({ fetcher = globalThis.fetch, signal } = {}) {
  return withRpc({ fetcher, signal }, async rpc => {
    await assertChain(rpc);
    const latest = parseBlock(await rpc('eth_getBlockByNumber', ['latest', false]), undefined, false);
    if (latest.number < 8 || latest.number + 150 > Number.MAX_SAFE_INTEGER) throw new MonadEventError('RPC_HEAD', 'Monad 当前区块高度不足或超出安全范围，暂时无法创建事件。');
    const counts = Array(8);
    await pool(Array.from({ length: 8 }, (_, i) => latest.number - i), MAX_PARALLEL, async (n, i) => {
      const block = parseBlock(await rpc('eth_getBlockByNumber', [`0x${n.toString(16)}`, false]), n);
      counts[i] = block.txCount;
    });
    const baseline = Math.max(1, Math.round(counts.reduce((a, b) => a + b, 0) / counts.length));
    const lower = Math.max(0, Math.floor(baseline * 0.9));
    const upper = Math.max(lower + 1, Math.ceil(baseline * 1.1));
    const spec = Object.freeze({ mode: 'monad', title: 'Monad 未来目标区块交易笔数', chainId: MONAD_TESTNET.chainId, source: 'Monad Testnet RPC', startBlock: latest.number, closeBlock: latest.number + 130, targetBlock: latest.number + 150, baseline, lower, upper, confirmations: 2 });
    return spec;
  });
}

export async function pollMonadEvent(spec, { fetcher = globalThis.fetch, signal } = {}) {
  validateSpec(spec);
  const original = spec;
  return withRpc({ fetcher, signal }, async rpc => {
    await assertChain(rpc);
    const head = parseBlock(await rpc('eth_getBlockByNumber', ['latest', false]), undefined, false).number;
    const observation = { mode: 'monad', headBlock: head, observedAt: Date.now(), verified: false };
    if (head < original.targetBlock + original.confirmations) return observation;
    const tag = `0x${original.targetBlock.toString(16)}`;
    const first = parseBlock(await rpc('eth_getBlockByNumber', [tag, false]), original.targetBlock);
    const second = parseBlock(await rpc('eth_getBlockByNumber', [tag, false]), original.targetBlock);
    if (first.hash !== second.hash) throw new MonadEventError('REORG', '目标区块哈希发生变化，检测到链重组；事件保持待确认，请稍后重试。');
    return { ...observation, verified: true, blockNumber: original.targetBlock, txCount: second.txCount, blockHash: second.hash, chainId: MONAD_TESTNET.chainId };
  });
}
