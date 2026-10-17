import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  MONAD_TESTNET, MonadError, createWalletClient, discoverWallets,
  formatMon, shortenAddress, readMonadHead, walletErrorMessage,
} from '../dist/monad.js';

const ACCOUNT = `0x${'12'.repeat(20)}`;
const OTHER_ACCOUNT = `0x${'ab'.repeat(20)}`;
const BLOCK = { number: '0x123456789abcdef', timestamp: '0x65000000', hash: `0x${'ab'.repeat(32)}` };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

class FakeProvider extends EventEmitter {
  accounts = [ACCOUNT];
  chainId = MONAD_TESTNET.chainIdHex;
  balance = '0x1158e460913d00000';
  calls = [];
  handlers = {};

  async request(payload) {
    this.calls.push(payload);
    if (this.handlers[payload.method]) return this.handlers[payload.method](payload);
    switch (payload.method) {
      case 'eth_requestAccounts':
      case 'eth_accounts': return [...this.accounts];
      case 'eth_chainId': return this.chainId;
      case 'eth_getBalance': return this.balance;
      case 'wallet_switchEthereumChain': this.chainId = payload.params[0].chainId; return null;
      case 'wallet_addEthereumChain': return null;
      default: throw new Error(`Unexpected method: ${payload.method}`);
    }
  }
}

function rpcFixture(result = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    const payload = JSON.parse(options.body);
    calls.push({ url, options, payload });
    return {
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: payload.id, result: payload.method === 'eth_chainId' ? MONAD_TESTNET.chainIdHex : { ...BLOCK, ...result } }),
    };
  };
  return { calls, fetcher };
}

test('MON 格式保留大整数精度，地址仅接受有效 EVM 地址', () => {
  assert.equal(formatMon(1234567890123456789012345678n), '1,234,567,890.1234');
  assert.equal(formatMon(0n), '0.0000');
  assert.equal(formatMon(1n), '<0.0001');
  assert.equal(formatMon(100000000000000n), '0.0001');
  assert.equal(formatMon(-1n), '—');
  assert.equal(formatMon(1), '—');
  assert.equal(shortenAddress(ACCOUNT), '0x1212…1212');
  assert.equal(shortenAddress('0x123'), '未连接');
});

test('创建钱包客户端不会请求账户，只有显式连接才授权', async () => {
  const provider = new FakeProvider();
  const client = createWalletClient();
  assert.equal(provider.calls.length, 0);
  await client.connect(provider);
  assert.equal(client.getState().account, ACCOUNT);
  assert.equal(client.getState().chainId, '0x279f');
  assert.equal(client.getState().balanceWei, BigInt(provider.balance));
  assert.equal(client.getState().pending, false);
  assert.equal(client.getState().reading, false);
  assert.deepEqual(provider.calls.map(call => call.method), ['eth_requestAccounts', 'eth_accounts', 'eth_chainId', 'eth_getBalance']);
  assert.deepEqual(provider.calls.at(-1).params, [ACCOUNT, 'latest']);
  client.disconnect();
});

test('缺少钱包、拒绝授权、已有请求都能恢复到未连接状态', async () => {
  const client = createWalletClient();
  await client.connect();
  assert.match(client.getState().message, /没有检测到/);
  for (const [code, message] of [[4001, /取消/], [-32002, /待处理/]]) {
    const provider = new FakeProvider();
    provider.handlers.eth_requestAccounts = () => { throw { code }; };
    await client.connect(provider);
    assert.equal(client.getState().status, 'disconnected');
    assert.equal(client.getState().pending, false);
    assert.match(client.getState().message, message);
    assert.equal(provider.listenerCount('accountsChanged'), 0);
  }
  assert.match(walletErrorMessage({ data: { originalError: { code: 4900 } } }), /断开/);
});

test('错误网络不读取余额，明确切网后重新验证真实网络', async () => {
  const provider = new FakeProvider();
  provider.chainId = '0x1';
  const client = createWalletClient();
  await client.connect(provider);
  assert.equal(client.getState().status, 'wrong-network');
  assert.equal(client.getState().balanceWei, null);
  assert.equal(provider.calls.some(call => call.method === 'eth_getBalance'), false);
  await client.switchNetwork();
  assert.equal(client.getState().status, 'connected');
  assert.equal(client.getState().chainId, '0x279f');
  assert.deepEqual(provider.calls.find(call => call.method === 'wallet_switchEthereumChain').params, [{ chainId: '0x279f' }]);
  client.disconnect();
});

test('仅未知链错误才添加测试网，添加后再次请求切换', async () => {
  const provider = new FakeProvider();
  provider.chainId = '0x1';
  let switches = 0;
  provider.handlers.wallet_switchEthereumChain = () => {
    if (++switches === 1) throw { code: 4902 };
    provider.chainId = '0x279f';
    return null;
  };
  const client = createWalletClient();
  await client.connect(provider);
  await client.switchNetwork();
  assert.equal(switches, 2);
  assert.deepEqual(provider.calls.find(call => call.method === 'wallet_addEthereumChain').params, [{
    chainId: '0x279f', chainName: 'Monad Testnet',
    nativeCurrency: { name: 'Testnet MON Token', symbol: 'MON', decimals: 18 },
    rpcUrls: ['https://testnet-rpc.monad.xyz'],
    blockExplorerUrls: ['https://testnet.monadvision.com'],
  }]);
  assert.equal(client.getState().status, 'connected');
  client.disconnect();
});

test('拒绝切换不会触发添加网络，也不会假定切换成功', async () => {
  const provider = new FakeProvider();
  provider.chainId = '0x1';
  provider.handlers.wallet_switchEthereumChain = () => { throw { code: 4001 }; };
  const client = createWalletClient();
  await client.connect(provider);
  await client.switchNetwork();
  assert.equal(provider.calls.some(call => call.method === 'wallet_addEthereumChain'), false);
  assert.equal(client.getState().status, 'wrong-network');
  assert.match(client.getState().message, /取消/);
  provider.handlers.wallet_switchEthereumChain = () => null;
  await client.switchNetwork();
  assert.equal(client.getState().status, 'wrong-network');
  client.disconnect();
});

test('账户与网络变化立即清除旧余额，断开后移除事件监听', async () => {
  const provider = new FakeProvider();
  const client = createWalletClient();
  await client.connect(provider);
  provider.accounts = [OTHER_ACCOUNT];
  provider.balance = '0x1';
  provider.emit('accountsChanged', provider.accounts);
  assert.equal(client.getState().balanceWei, null);
  await tick();
  assert.equal(client.getState().account, OTHER_ACCOUNT);
  assert.equal(client.getState().balanceWei, 1n);
  provider.chainId = '0x1';
  provider.emit('chainChanged', '0x1');
  await tick();
  assert.equal(client.getState().status, 'wrong-network');
  assert.equal(client.getState().balanceWei, null);
  provider.emit('disconnect', { code: 4900 });
  assert.equal(client.getState().account, null);
  for (const event of ['accountsChanged', 'chainChanged', 'disconnect']) assert.equal(provider.listenerCount(event), 0);
});

test('待处理的授权在取消连接后返回，不会重新连上钱包', async () => {
  const authorization = deferred();
  const provider = new FakeProvider();
  provider.handlers.eth_requestAccounts = () => authorization.promise;
  const client = createWalletClient();
  const pending = client.connect(provider);
  assert.equal(client.getState().pending, true);
  client.disconnect();
  authorization.resolve([ACCOUNT]);
  await pending;
  assert.equal(client.getState().status, 'disconnected');
  assert.equal(client.getState().account, null);
  assert.equal(provider.calls.length, 1);
});

test('旧余额响应不能污染切网后的状态或已断开的连接', async () => {
  const provider = new FakeProvider();
  const client = createWalletClient();
  await client.connect(provider);
  const delayedBalance = deferred();
  provider.handlers.eth_getBalance = () => delayedBalance.promise;
  const pending = client.refresh();
  await tick();
  provider.chainId = '0x1';
  provider.emit('chainChanged', '0x1');
  await tick();
  delayedBalance.resolve('0xffff');
  await pending;
  assert.equal(client.getState().status, 'wrong-network');
  assert.equal(client.getState().balanceWei, null);
  client.disconnect();
  assert.equal(client.getState().reading, false);
});

test('取消账户授权与无效余额不会保留旧的可用余额', async () => {
  const provider = new FakeProvider();
  const client = createWalletClient();
  await client.connect(provider);
  provider.balance = 'not-hex';
  await client.refresh();
  assert.equal(client.getState().status, 'error');
  assert.equal(client.getState().balanceWei, null);
  provider.accounts = [];
  provider.emit('accountsChanged', []);
  await tick();
  assert.equal(client.getState().status, 'disconnected');
  assert.equal(provider.listenerCount('accountsChanged'), 0);
});

test('钱包只读超时可以重试，迟到余额不会覆盖重试后的结果', async () => {
  const provider = new FakeProvider();
  const client = createWalletClient({ readTimeoutMs: 10, now: () => 1800000000000 });
  await client.connect(provider);
  assert.equal(client.getState().balanceReadAt, 1800000000000);
  const delayed = deferred();
  provider.handlers.eth_getBalance = () => delayed.promise;
  await client.refresh();
  assert.equal(client.getState().reading, false);
  assert.equal(client.getState().balanceWei, null);
  assert.equal(client.getState().balanceReadAt, null);
  assert.match(client.getState().message, /超时/);
  provider.handlers.eth_getBalance = () => '0x2';
  await client.refresh();
  delayed.resolve('0xffff');
  await tick();
  assert.equal(client.getState().balanceWei, 2n);
  assert.equal(client.getState().status, 'connected');
  client.disconnect();
});

test('初次状态读取超时会清理 provider 事件，账户授权弹窗不受读取超时限制', async () => {
  const provider = new FakeProvider();
  const client = createWalletClient({ readTimeoutMs: 10 });
  const authorization = deferred();
  provider.handlers.eth_requestAccounts = () => authorization.promise;
  const connecting = client.connect(provider);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(client.getState().pending, true);
  provider.handlers.eth_accounts = () => new Promise(() => {});
  authorization.resolve([ACCOUNT]);
  await connecting;
  assert.equal(client.getState().status, 'disconnected');
  assert.equal(client.getState().pending, false);
  assert.equal(client.getState().reading, false);
  assert.equal(provider.listenerCount('accountsChanged'), 0);
  client.disconnect();
});

function announce(target, provider, name, uuid, icon = '<svg onload="bad()">') {
  const event = new Event('eip6963:announceProvider');
  Object.defineProperty(event, 'detail', { value: { provider, info: { name, uuid, icon } } });
  target.dispatchEvent(event);
}

test('EIP-6963 支持多钱包、去重与移除监听，不请求账户或执行元数据', () => {
  const target = new EventTarget();
  const first = new FakeProvider();
  const second = new FakeProvider();
  let wallets;
  let requests = 0;
  target.addEventListener('eip6963:requestProvider', () => {
    requests += 1;
    announce(target, first, '<img src=x onerror=bad()>', 'first');
    announce(target, second, 'Second wallet', 'second');
    announce(target, new FakeProvider(), 'Duplicate uuid', 'second');
  });
  const discovery = discoverWallets(target, next => { wallets = next; });
  discovery.request();
  assert.equal(requests, 2);
  assert.equal(wallets.length, 2);
  assert.equal(wallets[0].name, '<img src=x onerror=bad()>');
  assert.equal('icon' in wallets[0], false);
  assert.equal(first.calls.length + second.calls.length, 0);
  discovery.dispose();
  announce(target, new FakeProvider(), 'Ignored', 'third');
  assert.equal(wallets.length, 2);
});

test('传统注入钱包可回退发现，公布后更新同一 provider 的名称', () => {
  const target = new EventTarget();
  target.ethereum = new FakeProvider();
  let wallets;
  const discovery = discoverWallets(target, next => { wallets = next; });
  assert.equal(wallets.length, 1);
  announce(target, target.ethereum, 'Named wallet', 'legacy');
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].name, 'Named wallet');
  for (let index = 0; index < 30; index += 1) announce(target, new FakeProvider(), 'Wallet', `wallet-${index}`);
  assert.equal(wallets.length, 16);
  discovery.dispose();
});

test('钱包图标仅接受有长度限制的数据图像，重复声明不改变元数据', () => {
  const target = new EventTarget();
  let wallets;
  let updates = 0;
  const discovery = discoverWallets(target, next => { wallets = next; updates += 1; });
  const provider = new FakeProvider();
  const svg = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M0 0h32v32H0z"/></svg>';
  announce(target, provider, 'Wallet', 'wallet', svg);
  assert.equal(wallets[0].icon, svg);
  const before = updates;
  announce(target, provider, 'Wallet', 'wallet', svg);
  assert.equal(updates, before);
  for (const icon of ['https://example.com/tracker.svg', 'javascript:bad()', 'data:text/html,<script>bad()</script>', `data:image/png;base64,${'a'.repeat(131072)}`]) {
    announce(target, provider, 'Wallet', 'wallet', icon);
    assert.equal('icon' in wallets[0], false);
  }
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  announce(target, provider, 'Wallet', 'wallet', png);
  assert.equal(wallets[0].icon, png);
  assert.equal(provider.calls.length, 0);
  discovery.dispose();
});

test('真实区块读取先核对链 ID，使用只读 RPC 并保留大整数高度', async () => {
  const { fetcher, calls } = rpcFixture();
  const head = await readMonadHead({ fetcher, now: () => 1800000000000 });
  assert.equal(head.number, BigInt(BLOCK.number));
  assert.equal(head.timestamp, Number(BigInt(BLOCK.timestamp)) * 1000);
  assert.equal(head.hash, BLOCK.hash);
  assert.equal(head.readAt, 1800000000000);
  assert.equal(head.latencyMs, 0);
  assert.deepEqual(calls.map(call => call.payload.method), ['eth_chainId', 'eth_getBlockByNumber']);
  assert.deepEqual(calls[1].payload.params, ['latest', false]);
  assert.equal(calls[0].url, MONAD_TESTNET.rpcUrl);
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.referrerPolicy, 'no-referrer');
});

test('RPC 返回错误网络时不展示区块，也不继续请求区块', async () => {
  let calls = 0;
  const fetcher = async () => { calls += 1; return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1' }) }; };
  await assert.rejects(readMonadHead({ fetcher }), { code: 'RPC_WRONG_CHAIN' });
  assert.equal(calls, 1);
});

test('RPC 拒绝限流、错误响应、伪造响应 ID 与无效区块', async () => {
  await assert.rejects(readMonadHead({ fetcher: async () => ({ ok: false, status: 429 }) }), error => error instanceof MonadError && /繁忙/.test(error.message));
  for (const body of [
    { jsonrpc: '2.0', id: 1, error: { code: -32000 } },
    { jsonrpc: '2.0', id: 99, result: '0x279f' },
    { id: 1, result: '0x279f' },
    null,
  ]) {
    await assert.rejects(readMonadHead({ fetcher: async () => ({ ok: true, json: async () => body }) }), { code: 'RPC_RESPONSE' });
  }
  for (const block of [{ hash: '0x0' }, { number: 'nan' }, { timestamp: '0xffffffffffffffffffffffff' }]) {
    await assert.rejects(readMonadHead({ fetcher: rpcFixture(block).fetcher }), MonadError);
  }
  await assert.rejects(readMonadHead({ fetcher: async () => { throw new TypeError('fetch failed'); } }), { code: 'RPC_UNAVAILABLE' });
});

test('RPC 超时和外部取消会中止读取，提前取消不会发请求', async () => {
  const waitForAbort = async (_, { signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) reject(new Error('aborted'));
    else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  await assert.rejects(readMonadHead({ fetcher: waitForAbort, timeoutMs: 10 }), { code: 'RPC_TIMEOUT' });
  const controller = new AbortController();
  const pending = readMonadHead({ fetcher: waitForAbort, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'ABORTED' });
  await assert.rejects(readMonadHead({ fetcher: () => assert.fail('must not fetch'), signal: controller.signal }), { code: 'ABORTED' });
});
