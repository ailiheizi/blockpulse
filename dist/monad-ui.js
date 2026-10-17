import { MONAD_TESTNET, createWalletClient, discoverWallets, formatMon, shortenAddress } from './monad.js';
import { createHeadMonitor } from './monad-monitor.js';

export function mountMonad() {
  const $ = id => document.getElementById(id);
  if (!$('monad-panel')) return;
  const wallet = createWalletClient();
  const monitor = createHeadMonitor();
  let wallets = [];
  let selectedProvider = null;
  let renderedWallets = [];
  let userSelected = false;
  let displayedAccount = null;
  let copyVersion = 0;
  let sampleKey = '';
  const setText = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
  const time = timestamp => new Date(timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

  function renderWallet(state) {
    const connected = Boolean(state.account);
    const onMonad = connected && state.chainId === MONAD_TESTNET.chainIdHex;
    const ready = onMonad && state.status === 'connected' && typeof state.balanceWei === 'bigint';
    $('monad-panel').dataset.walletState = ready ? 'connected' : state.status;
    if (displayedAccount !== state.account) {
      displayedAccount = state.account;
      copyVersion += 1;
      setText('wallet-copy-message', '');
      $('wallet-address-details').open = false;
      $('wallet-full-address').value = state.account || '';
    }
    const steps = [connected, onMonad, ready];
    ['wallet-step-account', 'wallet-step-network', 'wallet-step-balance'].forEach((id, index) => {
      const current = !steps[index] && (index === 0 || steps[index - 1]);
      $(id).dataset.state = steps[index] ? 'complete' : current ? 'current' : 'waiting';
      if (current) $(id).setAttribute('aria-current', 'step');
      else $(id).removeAttribute('aria-current');
    });
    setText('wallet-address', shortenAddress(state.account));
    $('wallet-address').title = state.account || '连接后显示钱包地址';
    $('wallet-account-link').hidden = !connected;
    if (connected) $('wallet-account-link').href = `${MONAD_TESTNET.explorerUrl}/address/${state.account}`;
    else $('wallet-account-link').removeAttribute('href');
    $('wallet-copy').hidden = !connected;
    $('wallet-address-details').hidden = !connected;
    setText('wallet-balance', ready ? formatMon(state.balanceWei) : '—');
    setText('wallet-balance-time', state.balanceReadAt === null ? '' : `余额读取于 ${time(state.balanceReadAt)}`);
    const chainText = state.status === 'refreshing' ? '正在核对网络' : onMonad ? 'Monad Testnet · 10143' : state.chainId ? `当前网络 ${BigInt(state.chainId).toString()} · 请切换测试网` : '等待连接钱包';
    setText('wallet-network', chainText);
    setText('wallet-state', state.reading ? '正在读取钱包' : state.pending ? '等待钱包确认' : ready ? '测试网已连接' : connected && state.status === 'wrong-network' ? '需要切换网络' : connected ? '状态待刷新' : '尚未连接');
    const selected = wallets.find(item => item.provider === selectedProvider);
    const message = state.reading ? '正在读取账户与余额…' : ready ? state.balanceWei === 0n ? '测试网余额为 0，可从下方领水；模拟交易不需要 MON。' : '账户已就绪，可以继续体验模拟交易。' : connected && onMonad ? '余额暂未读到，可点击“刷新余额”重试。' : connected ? '确认 Monad 测试网后，即可查看 MON 余额。' : selected ? '仅请求账户授权，模拟交易不消耗 MON。' : '选择一个钱包以继续，也可以直接体验模拟交易。';
    setText('wallet-message', state.message || message);
    $('wallet-message').hidden = !wallets.length && !state.message;
    setText('wallet-shortcut-label', state.reading ? '读取中…' : state.pending ? '等待确认…' : connected ? shortenAddress(state.account) : '连接钱包');
    $('wallet-connect').hidden = connected || !wallets.length;
    $('wallet-actions').hidden = !wallets.length && !connected && !state.pending;
    $('wallet-connect').disabled = state.pending || !selected;
    setText('wallet-connect-label', state.pending ? '等待钱包确认…' : selected ? `连接 ${selected.name}` : '选择一个钱包以连接');
    $('wallet-selection').disabled = connected || state.pending;
    $('wallet-selection').hidden = connected || !wallets.length;
    $('wallet-account').hidden = !connected;
    setText('wallet-connected-name', selected?.name || '浏览器钱包');
    $('wallet-providers').querySelectorAll('input').forEach(input => {
      input.checked = wallets[Number(input.value)]?.provider === selectedProvider;
    });
    $('wallet-switch').hidden = !connected || state.chainId === MONAD_TESTNET.chainIdHex;
    $('wallet-switch').disabled = state.pending || state.reading;
    $('wallet-refresh').hidden = !connected;
    $('wallet-refresh').disabled = state.pending || state.reading;
    setText('wallet-refresh', state.reading ? '余额读取中…' : '刷新余额');
    $('wallet-disconnect').hidden = !connected && !state.pending;
    setText('wallet-disconnect', state.pending && !connected ? '取消本站连接' : '断开本站连接');
    $('wallet-shortcut').disabled = state.pending;
  }

  function renderChoices() {
    const changed = wallets.length !== renderedWallets.length || wallets.some((item, index) => {
      const previous = renderedWallets[index];
      return item.provider !== previous?.provider || item.name !== previous?.name || item.icon !== previous?.icon;
    });
    if (!changed) return;
    renderedWallets = wallets.map(item => ({ provider: item.provider, name: item.name, icon: item.icon }));
    $('wallet-providers').replaceChildren(...wallets.map((item, index) => {
      const label = document.createElement('label');
      label.className = 'wallet-option';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'wallet-provider';
      input.value = String(index);
      const body = document.createElement('span');
      body.className = 'wallet-option-body';
      const icon = document.createElement('span');
      icon.className = 'wallet-option-icon';
      icon.setAttribute('aria-hidden', 'true');
      const fallback = document.createElement('span');
      fallback.textContent = Array.from(item.name.trim())[0]?.toUpperCase() || 'W';
      icon.append(fallback);
      if (item.icon) {
        // 钱包提供的 SVG 仅作为图片加载，禁止作为页面标记插入。
        const img = document.createElement('img');
        img.alt = '';
        img.src = item.icon;
        img.draggable = false;
        fallback.hidden = true;
        img.addEventListener('error', () => { img.remove(); fallback.hidden = false; }, { once: true });
        icon.append(img);
      }
      const copy = document.createElement('span');
      copy.className = 'wallet-option-copy';
      const name = document.createElement('strong');
      name.textContent = item.name;
      const description = document.createElement('small');
      description.textContent = '已检测到';
      copy.append(name, description);
      const indicator = document.createElement('span');
      indicator.className = 'wallet-choice-indicator';
      indicator.setAttribute('aria-hidden', 'true');
      body.append(icon, copy, indicator);
      label.append(input, body);
      return label;
    }));
  }

  const unsubscribeWallet = wallet.subscribe(renderWallet);
  const discovery = discoverWallets(window, next => {
    wallets = next;
    if (!userSelected) selectedProvider = wallets.length === 1 ? wallets[0].provider : null;
    else if (!wallets.some(item => item.provider === selectedProvider)) selectedProvider = null;
    setText('wallet-count', String(wallets.length));
    renderChoices();
    $('wallet-help').hidden = wallets.length > 0;
    renderWallet(wallet.getState());
  });

  function connectSelected() {
    discovery.request();
    if (!wallets.length) { $('wallet-detect').focus(); return; }
    if (!selectedProvider) {
      $('wallet-providers').querySelector('input')?.focus();
      return;
    }
    userSelected = true;
    void wallet.connect(selectedProvider);
  }

  function setPanelOpen(open) {
    $('monad-body').hidden = !open;
    $('monad-toggle').setAttribute('aria-expanded', String(open));
    $('monad-panel').dataset.collapsed = String(!open);
    setText('monad-toggle', open ? '收起面板' : '展开面板');
    if (!open && monitor.getState().enabled) monitor.pause();
  }

  function renderMonitor(state) {
    const { head, status } = state;
    $('monad-panel').dataset.chainState = status === 'live' ? 'fresh' : head ? 'stale' : 'idle';
    $('monad-refresh').disabled = status === 'reading';
    $('monad-pause').hidden = !state.enabled;
    setText('monad-chain-state', { idle: '尚未读取', reading: '正在读取', live: '已读取真实区块', paused: '读取已暂停', offline: '浏览器已离线', error: '读取失败' }[status]);
    setText('monad-refresh', status === 'error' ? '重试读取' : head ? '刷新区块' : '读取测试网');
    const messages = {
      idle: '无需钱包即可读取；真实区块不参与本地游戏结算。',
      reading: '正在查询 Monad 测试网公开 RPC…',
      live: '每 5 秒采样一次；切到后台、离线或收起面板时暂停。',
      paused: state.enabled ? '当前页面不可见，返回后会恢复读取。' : '已暂停读取，点击读取按钮可继续。',
      offline: '浏览器处于离线状态，联网后会恢复；本地模拟可继续。',
      error: state.error,
    };
    setText('monad-rpc-message', messages[status]);
    if (head) {
      setText('monad-block', head.number.toLocaleString('en-US'));
      $('monad-block-link').href = `${MONAD_TESTNET.explorerUrl}/block/${head.number}`;
      $('monad-block-link').hidden = false;
      setText('monad-block-time', `区块时间 ${time(head.timestamp)} · ${status === 'live' ? '读取于' : '上次读取'} ${time(head.readAt)}${status === 'live' ? '' : ' · 非实时数据'}`);
      setText('monad-latency', `RPC 查询 ${head.latencyMs} ms`);
    }
    $('monad-sample-section').hidden = !state.samples.length;
    const key = state.samples.map(sample => `${sample.number}:${sample.hash}`).join(';');
    if (sampleKey !== key) {
      sampleKey = key;
      $('monad-samples').replaceChildren(...state.samples.map(sample => {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = `${MONAD_TESTNET.explorerUrl}/block/${sample.number}`;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = sample.number.toLocaleString('en-US');
        link.title = `区块 ${sample.number} · ${sample.hash}`;
        const caption = document.createElement('small');
        caption.textContent = new Date(sample.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
        item.append(link, caption);
        return item;
      }));
    }
  }

  const unsubscribeMonitor = monitor.subscribe(renderMonitor);
  function syncEnvironment() { monitor.setEnvironment({ visible: !document.hidden, online: navigator.onLine !== false }); }
  syncEnvironment();
  const handlers = [];
  function listen(target, type, handler) { target.addEventListener(type, handler); handlers.push(() => target.removeEventListener(type, handler)); }
  listen($('wallet-providers'), 'change', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'wallet-provider') return;
    selectedProvider = wallets[Number(input.value)]?.provider || null;
    userSelected = true;
    renderWallet(wallet.getState());
  });
  listen($('wallet-detect'), 'click', () => {
    discovery.request();
    if (!wallets.length) {
      $('wallet-message').hidden = false;
      setText('wallet-message', '暂未发现钱包，请确认扩展已启用，或在已安装钱包的桌面浏览器中打开。');
    }
  });
  listen($('wallet-connect'), 'click', connectSelected);
  listen($('wallet-shortcut'), 'click', () => {
    setPanelOpen(true);
    $('monad-panel').scrollIntoView({ block: 'start', behavior: 'auto' });
    if (!wallet.getState().account) connectSelected();
  });
  listen($('monad-toggle'), 'click', () => setPanelOpen($('monad-body').hidden));
  listen($('wallet-switch'), 'click', () => { void wallet.switchNetwork(); });
  listen($('wallet-refresh'), 'click', () => { void wallet.refresh(); });
  listen($('wallet-disconnect'), 'click', () => wallet.disconnect());
  listen($('wallet-copy'), 'click', async () => {
    const account = wallet.getState().account;
    if (!account) return;
    const version = ++copyVersion;
    const current = () => version === copyVersion && wallet.getState().account === account;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(account);
      if (current()) setText('wallet-copy-message', '钱包地址已复制。');
    } catch {
      if (!current()) return;
      $('wallet-address-details').open = true;
      $('wallet-full-address').focus();
      $('wallet-full-address').select();
      setText('wallet-copy-message', '浏览器未允许自动复制，已展开完整地址，可手动复制。');
    }
  });
  listen($('monad-copy-rpc'), 'click', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(MONAD_TESTNET.rpcUrl);
      setText('monad-config-message', 'RPC 地址已复制，可粘贴到钱包的网络设置。');
    } catch {
      setText('monad-config-message', '浏览器未允许自动复制，请手动选择上方完整 RPC 地址后复制。');
    }
  });
  listen($('monad-refresh'), 'click', () => { void monitor.refresh(); });
  listen($('monad-pause'), 'click', () => monitor.pause());
  listen(document, 'visibilitychange', syncEnvironment);
  listen(window, 'online', syncEnvironment);
  listen(window, 'offline', syncEnvironment);
  listen(window, 'pagehide', () => monitor.setEnvironment({ visible: false }));
  listen(window, 'pageshow', syncEnvironment);

  return () => {
    handlers.forEach(remove => remove());
    unsubscribeWallet();
    unsubscribeMonitor();
    discovery.dispose();
    monitor.dispose();
    wallet.disconnect();
  };
}
