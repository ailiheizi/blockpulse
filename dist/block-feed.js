import { MONAD_TESTNET, MonadError } from './monad.js';
import { BASELINE_BLOCKS } from './chain-event.js';

/** Read-only per-block feed of Monad testnet transaction counts, kept contiguous.
 * Public RPC allows 50 requests/s and counts each batch item, so reads stay paced.
 */
const HEX = /^0x[\da-f]+$/i;
const CHUNK = 25;
const POLL_MS = 1000;
const CHUNK_GAP_MS = 600;
const MAX_CATCH_UP = 200;
const STALE_MS = 20000;
const MAX_FAILURES = 4;

const quantity = value => {
  if (typeof value !== 'string' || !HEX.test(value) || value.length > 18) throw new MonadError('RPC_BLOCK', '区块数据无效，请稍后重试。');
  return Number(BigInt(value));
};

export function createBlockFeed({
  fetcher = globalThis.fetch, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  rpcUrl = MONAD_TESTNET.rpcUrl, baselineBlocks = BASELINE_BLOCKS, timeoutMs = 8000,
} = {}) {
  const stateListeners = new Set();
  const blockListeners = new Set();
  let state = Object.freeze({ status: 'idle', blocks: Object.freeze([]), head: 0, loaded: 0, target: baselineBlocks, error: '', lastBlockAt: 0 });
  let controller = null;
  let timer;
  let run = 0;
  let blocks = [];
  let requestId = 0;

  function update(patch) {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of stateListeners) listener(state);
  }

  async function rpc(body, signal) {
    const timeout = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
    const combined = timeout && AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal;
    const response = await fetcher(rpcUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: combined, credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new MonadError('RPC_HTTP', response.status === 429 ? '测试网 RPC 繁忙，请稍后重试。' : '测试网 RPC 暂不可用，请稍后重试。');
    return response.json();
  }

  async function readHead(signal) {
    const id = ++requestId;
    const body = await rpc({ jsonrpc: '2.0', id, method: 'eth_blockNumber', params: [] }, signal);
    if (body?.id !== id || body.error || typeof body.result !== 'string') throw new MonadError('RPC_RESPONSE', '测试网 RPC 返回错误，请稍后重试。');
    return quantity(body.result);
  }

  // Reads consecutive block numbers [from, to] in paced batches; rejects any hole.
  async function readRange(from, to, signal, onChunk) {
    const out = [];
    for (let start = from; start <= to; start += CHUNK) {
      const end = Math.min(to, start + CHUNK - 1);
      const batch = [];
      for (let number = start; number <= end; number += 1) {
        batch.push({ jsonrpc: '2.0', id: number, method: 'eth_getBlockByNumber', params: [`0x${number.toString(16)}`, false] });
      }
      const body = await rpc(batch, signal);
      if (!Array.isArray(body) || body.length !== batch.length) throw new MonadError('RPC_RESPONSE', '测试网 RPC 返回错误，请稍后重试。');
      const byId = new Map(body.map(item => [item?.id, item]));
      for (let number = start; number <= end; number += 1) {
        const block = byId.get(number)?.result;
        if (!block || !Array.isArray(block.transactions) || quantity(block.number) !== number) {
          throw new MonadError('RPC_BLOCK', '区块读取不完整，请稍后重试。');
        }
        out.push({ number, tx: block.transactions.length, timestamp: quantity(block.timestamp) });
      }
      onChunk?.(out.length);
      if (end < to) await new Promise(resolve => { timer = setTimer(resolve, CHUNK_GAP_MS); });
      if (signal.aborted) throw new MonadError('ABORTED', '已取消读取。');
    }
    return out;
  }

  function fail(runId, error) {
    if (runId !== run) return;
    clearTimer(timer);
    update({ status: 'error', error: error?.message || '区块读取失败，请稍后重试。' });
  }

  async function load(runId, signal) {
    const head = await readHead(signal);
    const from = Math.max(0, head - baselineBlocks + 1);
    update({ status: 'loading', head, loaded: 0, target: head - from + 1, error: '' });
    const loaded = await readRange(from, head, signal, count => { if (runId === run) update({ loaded: count }); });
    if (runId !== run) return;
    blocks = loaded;
    update({ status: 'live', blocks: Object.freeze([...blocks]), head, loaded: loaded.length, lastBlockAt: now() });
  }

  async function poll(runId, signal, failures = 0) {
    if (runId !== run) return;
    try {
      const head = await readHead(signal);
      if (runId !== run) return;
      const last = blocks.at(-1).number;
      if (head - last > MAX_CATCH_UP) throw new MonadError('RPC_BEHIND', '读取中断太久，基准区块已过期，请重新开始。');
      if (head > last) {
        const fresh = await readRange(last + 1, head, signal);
        if (runId !== run) return;
        blocks = [...blocks, ...fresh].slice(-baselineBlocks);
        update({ status: 'live', blocks: Object.freeze([...blocks]), head, lastBlockAt: now(), error: '' });
        for (const listener of blockListeners) listener(fresh);
      } else if (now() - state.lastBlockAt > STALE_MS) {
        throw new MonadError('RPC_STALE', '测试网长时间没有出新区块。');
      }
      timer = setTimer(() => { void poll(runId, signal); }, POLL_MS);
    } catch (error) {
      if (runId !== run || signal.aborted) return;
      const fatal = error instanceof MonadError && (error.code === 'RPC_BEHIND' || error.code === 'RPC_STALE');
      if (fatal || failures + 1 >= MAX_FAILURES) {
        fail(runId, error instanceof MonadError ? error : new MonadError('RPC_UNAVAILABLE', '无法读取测试网区块，请检查网络。'));
        return;
      }
      timer = setTimer(() => { void poll(runId, signal, failures + 1); }, POLL_MS * 2);
    }
  }

  function stop() {
    run += 1;
    clearTimer(timer);
    controller?.abort();
    controller = null;
  }

  return {
    getState: () => state,
    subscribe(listener) { stateListeners.add(listener); listener(state); return () => stateListeners.delete(listener); },
    onBlocks(listener) { blockListeners.add(listener); return () => blockListeners.delete(listener); },
    async start() {
      stop();
      const runId = run;
      controller = new AbortController();
      const { signal } = controller;
      blocks = [];
      update({ status: 'loading', blocks: Object.freeze([]), head: 0, loaded: 0, target: baselineBlocks, error: '', lastBlockAt: 0 });
      try {
        await load(runId, signal);
        if (runId === run) void poll(runId, signal);
      } catch (error) {
        if (runId !== run || signal.aborted) return;
        fail(runId, error instanceof MonadError ? error : new MonadError('RPC_UNAVAILABLE', '无法读取测试网区块，请检查网络。本地模拟仍可使用。'));
      }
    },
    stop() {
      stop();
      update({ status: 'idle' });
    },
  };
}
