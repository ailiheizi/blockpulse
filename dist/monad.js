export const MONAD_TESTNET = Object.freeze({
  chainId: 10143,
  chainIdHex: '0x279f',
  name: 'Monad Testnet',
  rpcUrl: 'https://testnet-rpc.monad.xyz',
  explorerUrl: 'https://testnet.monadvision.com',
  faucetUrl: 'https://faucet.monad.xyz',
  nativeCurrency: Object.freeze({ name: 'Testnet MON Token', symbol: 'MON', decimals: 18 }),
});

const ADDRESS = /^0x[\da-f]{40}$/i;
const HEX = /^0x[\da-f]+$/i;
const isAddress = value => typeof value === 'string' && ADDRESS.test(value);

export class MonadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MonadError';
    this.code = code;
  }
}

function normalizeChainId(value) {
  if (typeof value !== 'string' || !HEX.test(value) || value.length > 66) {
    throw new MonadError('INVALID_CHAIN', '未返回有效的网络标识，请刷新状态。');
  }
  return `0x${BigInt(value).toString(16)}`;
}

function parseQuantity(value) {
  if (typeof value !== 'string' || !HEX.test(value) || value.length > 66) {
    throw new MonadError('INVALID_RESPONSE', '网络返回了无效数据，请稍后重试。');
  }
  return BigInt(value);
}

export function shortenAddress(address) {
  return isAddress(address) ? `${address.slice(0, 6)}…${address.slice(-4)}` : '未连接';
}

export function formatMon(wei) {
  if (typeof wei !== 'bigint' || wei < 0n) return '—';
  if (wei > 0n && wei < 100000000000000n) return '<0.0001';
  const whole = (wei / 1000000000000000000n).toLocaleString('en-US');
  const fraction = (wei % 1000000000000000000n).toString().padStart(18, '0').slice(0, 4);
  return `${whole}.${fraction}`;
}

export function walletErrorMessage(error) {
  const code = Number(error?.code ?? error?.data?.originalError?.code);
  if (code === 4001) return '你已取消钱包请求，可以继续本地试玩。';
  if (code === -32002) return '钱包里已有待处理请求，请先打开钱包完成或取消。';
  if (code === 4200 || code === -32601) return '这个钱包暂不支持此操作，请在钱包中手动添加 Monad Testnet。';
  if (code === 4900 || code === 4901) return '钱包网络已断开，请检查钱包连接后重试。';
  if (error instanceof MonadError) return error.message;
  return '钱包请求未完成，请检查钱包扩展后重试。';
}

export function createWalletClient({ readTimeoutMs = 8000, now = Date.now } = {}) {
  let provider = null;
  let connectionVersion = 0;
  let readVersion = 0;
  let detach = () => {};
  let state = Object.freeze({ status: 'disconnected', account: null, chainId: null, balanceWei: null, balanceReadAt: null, pending: false, reading: false, message: '' });
  const listeners = new Set();

  function update(patch) {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener(state);
  }

  function disconnect(message = '') {
    connectionVersion += 1;
    readVersion += 1;
    detach();
    detach = () => {};
    provider = null;
    update({ status: 'disconnected', account: null, chainId: null, balanceWei: null, balanceReadAt: null, pending: false, reading: false, message });
  }

  async function readWallet(source, payload) {
    let timer;
    try {
      return await Promise.race([
        source.request(payload),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new MonadError('WALLET_TIMEOUT', '钱包状态读取超时，可点击“刷新余额”重试，或断开后重新连接。')), readTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function refresh() {
    if (!provider) return;
    const source = provider;
    const connection = connectionVersion;
    const read = ++readVersion;
    const current = () => source === provider && connection === connectionVersion && read === readVersion;
    update({ reading: true, message: '' });
    try {
      const [accounts, rawChainId] = await Promise.all([
        readWallet(source, { method: 'eth_accounts' }),
        readWallet(source, { method: 'eth_chainId' }),
      ]);
      if (!current()) return;
      if (!Array.isArray(accounts)) throw new MonadError('INVALID_ACCOUNT', '钱包没有返回有效地址，请重新连接。');
      if (!accounts.length) { disconnect('钱包已取消本站的账户连接。'); return; }
      if (!isAddress(accounts[0])) throw new MonadError('INVALID_ACCOUNT', '钱包没有返回有效地址，请重新连接。');
      const chainId = normalizeChainId(rawChainId);
      const sameAccount = state.account?.toLowerCase() === accounts[0].toLowerCase();
      const sameContext = sameAccount && chainId === state.chainId;
      update({ account: accounts[0], chainId, balanceWei: sameContext ? state.balanceWei : null, balanceReadAt: sameContext ? state.balanceReadAt : null, status: chainId === MONAD_TESTNET.chainIdHex ? 'connected' : 'wrong-network' });
      if (chainId !== MONAD_TESTNET.chainIdHex) { update({ balanceWei: null, balanceReadAt: null }); return; }
      const balance = await readWallet(source, { method: 'eth_getBalance', params: [accounts[0], 'latest'] });
      if (current()) update({ balanceWei: parseQuantity(balance), balanceReadAt: now() });
    } catch (error) {
      if (current()) {
        if (!state.account) disconnect(walletErrorMessage(error));
        else update({ status: 'error', balanceWei: null, balanceReadAt: null, message: walletErrorMessage(error) });
      }
    } finally {
      if (current()) update({ reading: false });
    }
  }

  function attach(source) {
    const changed = () => {
      if (source !== provider) return;
      readVersion += 1;
      update({ status: 'refreshing', balanceWei: null, balanceReadAt: null, chainId: null });
      void refresh();
    };
    const disconnected = () => { if (source === provider) disconnect('钱包连接已断开，本地模拟仍可继续。'); };
    if (typeof source.on !== 'function' || typeof source.removeListener !== 'function') return;
    source.on('accountsChanged', changed);
    source.on('chainChanged', changed);
    source.on('disconnect', disconnected);
    detach = () => {
      source.removeListener?.('accountsChanged', changed);
      source.removeListener?.('chainChanged', changed);
      source.removeListener?.('disconnect', disconnected);
    };
  }

  async function connect(source) {
    if (state.pending) return;
    disconnect();
    const connection = connectionVersion;
    if (typeof source?.request !== 'function') {
      update({ message: '没有检测到浏览器钱包。请通过本地 HTTP 或在线页面打开，并启用支持 EVM 的钱包。' });
      return;
    }
    update({ pending: true, status: 'connecting', message: '' });
    try {
      const accounts = await source.request({ method: 'eth_requestAccounts' });
      if (connection !== connectionVersion) return;
      if (!Array.isArray(accounts) || !isAddress(accounts[0])) throw new MonadError('INVALID_ACCOUNT', '钱包未开放有效账户，请重新连接。');
      provider = source;
      attach(source);
      await refresh();
    } catch (error) {
      if (connection === connectionVersion) disconnect(walletErrorMessage(error));
    } finally {
      if (connection === connectionVersion) update({ pending: false });
    }
  }

  async function switchNetwork() {
    if (!provider || state.pending) return;
    const source = provider;
    const connection = connectionVersion;
    const current = () => source === provider && connection === connectionVersion;
    update({ pending: true, message: '' });
    try {
      try {
        await source.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: MONAD_TESTNET.chainIdHex }] });
      } catch (error) {
        if (!current()) return;
        const code = Number(error?.code ?? error?.data?.originalError?.code);
        if (code !== 4902) throw error;
        await source.request({ method: 'wallet_addEthereumChain', params: [{
          chainId: MONAD_TESTNET.chainIdHex,
          chainName: MONAD_TESTNET.name,
          nativeCurrency: { ...MONAD_TESTNET.nativeCurrency },
          rpcUrls: [MONAD_TESTNET.rpcUrl],
          blockExplorerUrls: [MONAD_TESTNET.explorerUrl],
        }] });
        if (!current()) return;
        await source.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: MONAD_TESTNET.chainIdHex }] });
      }
      if (current()) await refresh();
    } catch (error) {
      if (current()) update({ message: walletErrorMessage(error) });
    } finally {
      if (current()) update({ pending: false });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    connect,
    switchNetwork,
    refresh,
    disconnect: () => disconnect('已断开本站连接；钱包扩展中的授权可在钱包内管理。'),
  };
}

export function discoverWallets(target, onChange) {
  const wallets = [];
  function add(provider, name, uuid = '', icon = '') {
    if (typeof provider?.request !== 'function') return;
    const existing = wallets.find(wallet => wallet.provider === provider);
    if (existing) {
      if (uuid && (existing.name !== name || existing.uuid !== uuid || (existing.icon || '') !== icon)) {
        existing.name = name;
        existing.uuid = uuid;
        if (icon) existing.icon = icon;
        else delete existing.icon;
        onChange([...wallets]);
      }
      return;
    }
    if (wallets.length >= 16 || (uuid && wallets.some(wallet => wallet.uuid === uuid))) return;
    wallets.push({ provider, name, uuid, ...(icon ? { icon } : {}) });
    onChange([...wallets]);
  }
  const announced = event => {
    const info = event.detail?.info;
    if (!info || typeof info.name !== 'string' || typeof info.uuid !== 'string' || !info.uuid || info.uuid.length > 128) return;
    const icon = typeof info.icon === 'string' && info.icon.length <= 131072
      && /^data:image\/(?:png|jpeg|webp|gif|svg\+xml)(?:;charset=[\w-]+)?(?:;base64)?,.+/is.test(info.icon) ? info.icon : '';
    add(event.detail.provider, info.name.slice(0, 80) || '浏览器钱包', info.uuid, icon);
  };
  function request() {
    target.dispatchEvent(new Event('eip6963:requestProvider'));
    if (!wallets.length && target.ethereum) {
      const legacy = Array.isArray(target.ethereum.providers) ? target.ethereum.providers : [target.ethereum];
      legacy.slice(0, 16).forEach((provider, index) => add(provider, legacy.length > 1 ? `浏览器钱包 ${index + 1}` : '浏览器钱包'));
    }
    onChange([...wallets]);
  }
  target.addEventListener('eip6963:announceProvider', announced);
  request();
  return { request, dispose: () => target.removeEventListener('eip6963:announceProvider', announced) };
}

export async function readMonadHead({ fetcher = globalThis.fetch, signal, timeoutMs = 8000, now = Date.now } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  let requestId = 0;
  const started = now();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  async function rpc(method, params) {
    if (controller.signal.aborted) throw new Error('Aborted');
    const id = ++requestId;
    const response = await fetcher(MONAD_TESTNET.rpcUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new MonadError('RPC_HTTP', response.status === 429 ? '测试网 RPC 繁忙，请稍后重试。' : '测试网 RPC 暂不可用，请稍后重试。');
    const body = await response.json();
    if (body?.jsonrpc !== '2.0' || body.id !== id || body.error || !Object.hasOwn(body, 'result')) {
      throw new MonadError('RPC_RESPONSE', '测试网 RPC 返回错误，请稍后重试。');
    }
    return body.result;
  }
  try {
    const chainId = normalizeChainId(await rpc('eth_chainId', []));
    if (chainId !== MONAD_TESTNET.chainIdHex) throw new MonadError('RPC_WRONG_CHAIN', 'RPC 网络不匹配，未将返回数据作为 Monad 测试网展示。');
    const block = await rpc('eth_getBlockByNumber', ['latest', false]);
    if (!block || typeof block.hash !== 'string' || !/^0x[\da-f]{64}$/i.test(block.hash)) throw new MonadError('RPC_BLOCK', '未读到有效区块，请稍后重试。');
    const number = parseQuantity(block.number);
    const timestamp = Number(parseQuantity(block.timestamp)) * 1000;
    if (!Number.isSafeInteger(timestamp) || Number.isNaN(new Date(timestamp).getTime())) throw new MonadError('RPC_BLOCK', '区块时间无效，请稍后重试。');
    return Object.freeze({ number, hash: block.hash, timestamp, readAt: now(), latencyMs: Math.max(0, now() - started) });
  } catch (error) {
    if (signal?.aborted) throw new MonadError('ABORTED', '已取消读取。');
    if (timedOut) throw new MonadError('RPC_TIMEOUT', '测试网 RPC 读取超时，请检查网络后重试。');
    if (error instanceof MonadError) throw error;
    throw new MonadError('RPC_UNAVAILABLE', '无法读取测试网，请检查网络或稍后重试。本地模拟仍可使用。');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
