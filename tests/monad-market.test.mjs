import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { MONAD_TESTNET } from '../dist/monad.js';
import { MARKET_ARTIFACT } from '../dist/monad-market-artifact.js';
import {
  MARKET_RULES, createMarketClient, createRpc, decodeWords, deployData, encodeCall, estimateRandomDelay,
  formatMonPrecise, isMarketAddress, marketCalls, marketErrorMessage, marketPhase, parseMon, parseSnapshot,
  scenarioOdds, sendTransaction, toSigned, waitForReceipt,
} from '../dist/monad-market.js';

const ACCOUNT = `0x${'12'.repeat(20)}`;
const MARKET = `0x${'ab'.repeat(20)}`;

function snapshotWords(patch = {}) {
  const words = Array(31).fill(0n);
  Object.assign(words, {
    0: 3n, 1: 1800000000n, 2: 5200n, 3: 150n * 10n ** 18n, 4: (1n << 256n) - 2n, 8: 4n,
    9: 10n, 10: 20n, 11: 30n, 12: 3n * 10n ** 17n, 13: 3n * 10n ** 17n, 14: 4n * 10n ** 17n,
    15: 10n ** 18n, 17: 190n, 18: 5100n, 19: 1800000030n, 20: 7n, 23: 2n, 24: 5n * 10n ** 15n,
    25: 1234n, 28: BigInt(ACCOUNT), 29: 150n * 10n ** 18n, 30: 5010n,
  }, patch);
  return words;
}

test('合约调用编码使用生成的选择器，整数和布尔按 32 字节补齐', () => {
  assert.equal(encodeCall('startRound'), MARKET_ARTIFACT.functions.startRound);
  const buy = encodeCall('buy', [2, 150]);
  assert.equal(buy.slice(0, 10), MARKET_ARTIFACT.functions.buy);
  assert.equal(buy.length, 10 + 128);
  assert.equal(BigInt(`0x${buy.slice(10, 74)}`), 2n);
  assert.equal(BigInt(`0x${buy.slice(74)}`), 150n);
  assert.equal(encodeCall('act', [true]).slice(-1), '1');
  assert.equal(encodeCall('act', [false]).slice(-64), '0'.repeat(64));
  assert.throws(() => encodeCall('missing'), /未知合约方法/);
  assert.throws(() => encodeCall('buy', [0, 1n << 256n]), /超出范围/);
  assert.equal(toSigned((1n << 256n) - 5n), -5n);
  assert.deepEqual(decodeWords(`0x${'0'.repeat(63)}1${'f'.repeat(64)}`), [1n, (1n << 256n) - 1n]);
  assert.throws(() => decodeWords('0x123'), /无效数据/);
  assert.equal(deployData(190).slice(-64), (190).toString(16).padStart(64, '0'));
  assert.throws(() => deployData(5), /范围/);
});

test('快照按合约布局解析，阶段依链上时间和随机区块判断', () => {
  const snapshot = parseSnapshot(snapshotWords(), 42);
  assert.equal(snapshot.round, 3);
  assert.equal(snapshot.heat, -2);
  assert.equal(snapshot.result, 'red');
  assert.deepEqual(snapshot.q, { red: 10, black: 20, green: 30 });
  assert.equal(snapshot.prices.green, 0.4);
  assert.equal(snapshot.holdings.red, 7);
  assert.equal(snapshot.basis.red, 1234n);
  assert.equal(snapshot.owner, ACCOUNT);
  assert.equal(snapshot.startBlock, 5010n);
  assert.equal(snapshot.readAt, 42);
  assert.equal(marketPhase(snapshot), 'trading');
  assert.equal(marketPhase(snapshot, 1800000055), 'locked');
  assert.equal(marketPhase(snapshot, 1800000030, 5200n), 'locked');
  assert.equal(marketPhase(snapshot, 1800000060, 5200n), 'locked');
  assert.equal(marketPhase(snapshot, 1800000060, 5201n), 'settleable');
  assert.equal(marketPhase(parseSnapshot(snapshotWords({ 5: 1n }))), 'settled');
  assert.equal(marketPhase(parseSnapshot(snapshotWords({ 0: 0n }))), 'idle');
  assert.throws(() => parseSnapshot(snapshotWords().slice(1)), /格式/);
  assert.throws(() => parseSnapshot(snapshotWords({ 6: 3n })), /无效结果/);
});

test('情景概率覆盖全部噪声，热度越高红色越可能', () => {
  const even = scenarioOdds(100);
  assert.equal(even.red, 10 / 25);
  assert.equal(even.black, 10 / 25);
  assert.equal(even.green, 5 / 25);
  const hot = scenarioOdds(109);
  assert.ok(hot.red > 0.7);
  assert.ok(Math.abs(Object.values(hot).reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
});

test('钱包或 RPC 错误里的自定义错误选择器被翻译成中文', () => {
  const selector = Object.entries(MARKET_ARTIFACT.errors).find(([, name]) => name === 'MarketClosed')[0];
  assert.match(marketErrorMessage({ code: -32603, data: { originalError: { data: `${selector}` } } }), /封盘/);
  assert.match(marketErrorMessage({ message: `execution reverted: ${selector}` }), /封盘/);
  assert.equal(marketErrorMessage({ code: 4001 }), '');
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(marketErrorMessage(cyclic), '');
});

test('RPC 客户端校验响应 ID，翻译回退数据，并在超时后中止', async () => {
  const selector = Object.entries(MARKET_ARTIFACT.errors).find(([, name]) => name === 'NoTickets')[0];
  const rpc = createRpc({ fetcher: async (_, options) => {
    const { id } = JSON.parse(options.body);
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: selector } }) };
  } });
  await assert.rejects(rpc('eth_call', []), /行动券/);
  const wrongId = createRpc({ fetcher: async () => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 99, result: '0x' }) }) });
  await assert.rejects(wrongId('eth_chainId'), { code: 'RPC_RESPONSE' });
  const slow = createRpc({ timeoutMs: 10, fetcher: (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  await assert.rejects(slow('eth_chainId'), { code: 'RPC_TIMEOUT' });
  await assert.rejects(createRpc({ fetcher: async () => ({ ok: false, status: 429 }) })('eth_chainId'), /繁忙/);
});

test('交易回执轮询容忍临时错误，超时会明确报告', async () => {
  let calls = 0;
  const rpc = async () => {
    calls += 1;
    if (calls === 1) throw new Error('flaky');
    if (calls === 2) return null;
    return { status: '0x1', blockNumber: '0x10', contractAddress: MARKET };
  };
  const receipt = await waitForReceipt(rpc, `0x${'1'.repeat(64)}`, { sleep: async () => {} });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.blockNumber, 16n);
  assert.equal(receipt.contractAddress, MARKET);
  let clock = 0;
  await assert.rejects(waitForReceipt(async () => null, 'x', { timeoutMs: 5, sleep: async () => { clock += 3; }, now: () => clock }), { code: 'TX_TIMEOUT' });
});

test('发送交易只附带必要字段，拒绝无效哈希', async () => {
  const requests = [];
  const provider = { request: async payload => { requests.push(payload); return `0x${'a'.repeat(64)}`; } };
  await sendTransaction(provider, { from: ACCOUNT, to: MARKET, ...marketCalls.buy('green', 5, 255n) });
  assert.deepEqual(requests[0].params[0], { from: ACCOUNT, to: MARKET, data: encodeCall('buy', [2, 5]), value: '0xff' });
  await sendTransaction(provider, { from: ACCOUNT, to: MARKET, ...marketCalls.claim() });
  assert.equal('value' in requests[1].params[0], false);
  await assert.rejects(sendTransaction({ request: async () => 'nope' }, { from: ACCOUNT, data: '0x' }), /哈希/);
});

test('随机区块延迟按实测出块时间落在封盘与收盘之间', async () => {
  const rpc = async (_, [tag]) => (tag === 'latest' ? { number: '0x3e8', timestamp: '0x100' } : { number: '0x320', timestamp: `0x${(0x100 - 60).toString(16)}` });
  assert.equal(await estimateRandomDelay(rpc), 190);
  assert.equal(await estimateRandomDelay(async () => ({ number: '0x1', timestamp: '0x1' })), 150);
});

test('MON 金额格式化与解析保持整数精度', () => {
  assert.equal(formatMonPrecise(1234567890000000000n), '1.2346');
  assert.equal(formatMonPrecise(41179419771944712n, 5), '0.04118');
  assert.equal(formatMonPrecise(1n), '<0.0001');
  assert.equal(formatMonPrecise(-1n), '—');
  assert.equal(parseMon('0.3'), 300000000000000000n);
  assert.equal(parseMon('12'), 12n * 10n ** 18n);
  assert.equal(parseMon('1e3'), null);
  assert.equal(parseMon('0.0000000000000000001'), null);
  assert.equal(isMarketAddress(MARKET), true);
  assert.equal(isMarketAddress(`0x${'0'.repeat(40)}`), false);
});

const anvilAvailable = spawnSync('anvil', ['--version'], { stdio: 'ignore' }).status === 0;

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

test('本机 anvil 上完整走通部署、交易、结算与领取', { skip: !anvilAvailable && '未安装 anvil，跳过链上集成测试' }, async t => {
  const port = await freePort();
  const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(MONAD_TESTNET.chainId), '--silent'], { stdio: 'ignore' });
  t.after(() => anvil.kill());
  const rpc = createRpc({ url: `http://127.0.0.1:${port}` });
  for (let attempt = 0; ; attempt += 1) {
    try { await rpc('eth_chainId'); break; } catch (error) { if (attempt > 50) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  const [owner, trader] = await rpc('eth_accounts');
  const provider = { request: ({ method, params }) => rpc(method, params) };
  const send = async (from, call, to) => {
    const receipt = await waitForReceipt(rpc, await sendTransaction(provider, { from, to, ...call }), { intervalMs: 20 });
    assert.equal(receipt.ok, true);
    return receipt;
  };
  const deployed = await send(owner, { data: deployData(30), value: 10n ** 18n });
  const market = createMarketClient({ address: deployed.contractAddress, rpc });
  assert.equal(await market.verify(), true);
  assert.equal(await createMarketClient({ address: owner, rpc }).verify(), false);

  await send(trader, marketCalls.start(), market.address);
  let snapshot = await market.snapshot(trader);
  assert.equal(snapshot.round, 1);
  assert.equal(snapshot.owner, owner.toLowerCase());
  assert.equal(marketPhase(snapshot), 'trading');
  const quote = await market.quote('red', 'buy', 100);
  assert.equal(quote.solvent, true);
  assert.ok(Math.abs(Number(quote.gross) / 1e15 - 41.17941977) < 1e-6);
  await send(trader, marketCalls.buy('red', 100, quote.total * 103n / 100n), market.address);
  await send(trader, marketCalls.act(true), market.address);
  snapshot = await market.snapshot(trader);
  assert.equal(snapshot.holdings.red, 100);
  assert.equal(snapshot.basis.red, quote.total);
  assert.equal(snapshot.heat, 101);
  assert.equal(snapshot.ticketsUsed, 1);
  assert.ok(snapshot.prices.red > 0.4);
  const trades = await market.trades(1, snapshot.startBlock, snapshot.blockNumber);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].trader, trader.toLowerCase());
  assert.equal(trades[0].total, quote.total);

  await assert.rejects(rpc('eth_call', [{ from: trader, to: market.address, data: encodeCall('settle') }, 'latest']), /结算时间/);
  await rpc('evm_increaseTime', [61]);
  await rpc('anvil_mine', ['0x40']);
  snapshot = await market.snapshot(trader);
  assert.equal(marketPhase(snapshot), 'settleable');
  await assert.rejects(rpc('eth_call', [{ from: trader, to: market.address, ...marketCalls.buy('red', 1, 10n ** 16n), value: '0x2386f26fc10000' }, 'latest']), /封盘/);
  await send(trader, marketCalls.settle(), market.address);
  snapshot = await market.snapshot(trader);
  assert.equal(snapshot.settled, true);
  assert.ok(Math.abs(snapshot.finalHeat - 101) <= MARKET_RULES.noiseRange);
  const won = snapshot.result === 'red';
  assert.equal(snapshot.claimable, won ? 100n * MARKET_RULES.shareWei : 0n);
  if (won) await send(trader, marketCalls.claim(), market.address);
  snapshot = await market.snapshot(trader);
  assert.equal(snapshot.claimable, 0n);
  const balance = BigInt(await rpc('eth_getBalance', [market.address, 'latest']));
  assert.equal(balance, snapshot.houseCash + snapshot.unclaimed);
});
