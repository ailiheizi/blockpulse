import { MONAD_TESTNET, MonadError, shortenAddress, walletErrorMessage } from './monad.js';
import { DEFAULT_MARKET_ADDRESS, MARKET_COLORS, MARKET_RULES, createMarketClient, createRpc, deployData, estimateRandomDelay, formatMonPrecise, isMarketAddress, marketCalls, marketErrorMessage, marketPhase, parseMon, scenarioOdds, sendTransaction, waitForReceipt } from './monad-market.js';
import { drawPriceChart } from './chart.js';

export const MARKET_ADDRESS_KEY = 'blockpulse-market-address';
export const TRADE_MODE_KEY = 'blockpulse-trade-mode';
const LABELS = Object.freeze({ red: '红', black: '黑', green: '绿' });
const NAMES = Object.freeze({ red: '红 · 上行', black: '黑 · 下行', green: '绿 · 区间' });
const PHASE_TEXT = Object.freeze({ none: '等待合约', loading: '读取中', idle: '等待开局', trading: '链上交易中', locked: '封盘 · 等随机区块', settleable: '可以结算', settled: '本轮已结算' });
const PHASE_CLASS = Object.freeze({ none: 'ready', loading: 'ready', idle: 'ready', trading: 'trading', locked: 'locked', settleable: 'locked', settled: 'settled' });
const PHASE_NOTES = Object.freeze({
  none: '设置或部署市场合约后，这里显示链上回合。所有买卖都直接使用钱包里的测试网 MON。',
  loading: '正在读取链上市场…',
  idle: '还没有回合。任何人都可以开局，开局只需支付 gas。',
  trading: '前 55 秒可买卖和使用行动券，以链上区块时间为准。每笔操作都要在钱包中确认。',
  locked: '已封盘：等待开局时登记的随机区块产出，之后任何人都能结算。',
  settleable: '随机区块已产出。结算会按“热度 + 区块哈希噪声”确定结果，任何人都可以提交。',
  settled: '已结算。命中份额每份可领 0.001 MON；开始下一轮后，未领取的兑付仍会保留。',
});
const POLL_MS = 1500;
const ERROR_POLL_MS = 5000;
const TRADES_MS = 4000;
const SLIPPAGE_PERCENT = 3n;
const SHARE_MON = 0.001;
const MIN_DEPLOY_WEI = 20000000000000000n;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const fmt = (n, digits = 2) => (Number.isFinite(n) ? n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—');
const signed = (n, digits = 4) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n), digits)}`;
const pnlClass = n => (n > 0.0000005 ? 'gain' : n < -0.0000005 ? 'loss' : '');
const mon = wei => Number(wei) / 1e18;

function readStorage(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* Storage is optional. */ }
}

export function mountMarket(monad) {
  const $ = id => document.getElementById(id);
  const root = $('chain-market');
  if (!root) return () => {};
  const wallet = monad?.wallet ?? null;
  const rpc = createRpc();
  const html = document.documentElement;
  const setText = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };

  const linked = new URLSearchParams(location.search).get('market');
  let mode = isMarketAddress(linked) || readStorage(TRADE_MODE_KEY) === 'chain' ? 'chain' : 'local';
  let client = null;
  let checking = false;
  let showSetup = false;
  let snapshot = null;
  let readError = '';
  let selectedColor = 'red';
  let selectedSide = 'buy';
  let quote = null;
  let quoteError = '';
  let quoteKey = '';
  let quoteVersion = 0;
  let quoteTimer;
  let pending = null;
  let lastTxBlock = null;
  let history = [];
  let historyRound = 0;
  let trades = [];
  let tradesRound = 0;
  let tradesAt = 0;
  let tradesLoading = false;
  let pollTimer;
  let polling = false;
  let lastAccount = null;
  let lastChain = null;
  let chartKey = '';
  const txLog = [];

  function setMessage(text) { setText('chain-message', text); }

  function walletInfo() {
    const state = wallet?.getState() ?? null;
    const provider = wallet?.getProvider?.() ?? null;
    const account = state?.account ?? null;
    const onMonad = state?.chainId === MONAD_TESTNET.chainIdHex;
    const ready = Boolean(account && onMonad && provider && state.status !== 'refreshing');
    const reason = !wallet ? '当前页面无法使用钱包。' : !account ? '先在上方连接钱包，链上交易需要钱包确认。' : !onMonad ? '先在上方切换到 Monad Testnet。' : !ready ? '钱包状态刷新中，请稍候。' : '';
    return { state, provider, account, ready, reason };
  }

  const chainNow = () => (snapshot ? snapshot.timestamp + (Date.now() - snapshot.readAt) / 1000 : Date.now() / 1000);
  const phase = () => (!client ? 'none' : !snapshot ? 'loading' : marketPhase(snapshot, chainNow()));
  const sharesInput = () => {
    const value = Number($('chain-shares').value);
    return Number.isInteger(value) && value >= 1 && value <= MARKET_RULES.maxShares ? value : null;
  };
  const active = () => mode === 'chain' && !document.hidden;

  function schedule() {
    clearTimeout(pollTimer);
    if (!active() || !client) return;
    pollTimer = setTimeout(async () => { await refresh(); schedule(); }, readError ? ERROR_POLL_MS : POLL_MS);
  }

  function setMode(next) {
    mode = next;
    writeStorage(TRADE_MODE_KEY, mode);
    html.dataset.tradeMode = mode;
    document.querySelectorAll('[data-trade-mode]').forEach(button => {
      const selected = button.dataset.tradeMode === mode;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    setText('mode-tag-label', mode === 'chain' ? '测试网 MON' : '积分模拟');
    if (mode === 'chain') void refresh();
    schedule();
    render();
  }

  async function useAddress(address, { announce = true } = {}) {
    let candidate;
    try { candidate = createMarketClient({ address, rpc }); } catch (error) { setMessage(error.message); return false; }
    checking = true;
    setMessage(`正在校验合约 ${shortenAddress(address)} 的链上代码…`);
    render();
    try {
      if (!(await candidate.verify())) {
        setMessage('该地址上的代码与 BlockPulse 市场合约不一致，未使用。请确认地址，并确认它部署在 Monad 测试网。');
        return false;
      }
      client = candidate;
      showSetup = false;
      snapshot = null;
      history = [];
      historyRound = 0;
      trades = [];
      tradesRound = 0;
      quote = null;
      quoteKey = '';
      writeStorage(MARKET_ADDRESS_KEY, client.address);
      if (announce) setMessage('合约代码校验通过，已连接链上市场。');
      await refresh();
      return true;
    } catch (error) {
      setMessage(error.message || '暂时无法校验合约，请稍后重试。');
      return false;
    } finally {
      checking = false;
      schedule();
      render();
    }
  }

  function recordHistory() {
    if (!snapshot?.round || snapshot.settled) return;
    const elapsedMs = Math.min(60000, Math.max(0, (snapshot.timestamp - snapshot.startTime) * 1000));
    if (!history.length && snapshot.trades === 0) history.push({ timeMs: 0, prices: snapshot.prices });
    if (!history.length || history.at(-1).timeMs < elapsedMs) history.push({ timeMs: elapsedMs, prices: snapshot.prices });
    if (history.length > 600) history.splice(0, history.length - 600);
  }

  async function refresh() {
    if (!client || polling) return;
    polling = true;
    const current = client;
    try {
      const next = await current.snapshot(walletInfo().account);
      if (current !== client) return;
      readError = '';
      if (next.round !== historyRound) {
        historyRound = next.round;
        history = [];
        chartKey = '';
      }
      snapshot = next;
      recordHistory();
      void refreshQuote();
      void refreshTrades();
    } catch (error) {
      if (current === client) readError = error.message || '读取链上市场失败。';
    } finally {
      polling = false;
      render();
    }
  }

  async function refreshTrades(force = false) {
    if (!client || !snapshot?.round || tradesLoading) return;
    if (!force && snapshot.round === tradesRound && Date.now() - tradesAt < TRADES_MS) return;
    tradesLoading = true;
    const current = client;
    const round = snapshot.round;
    try {
      const list = await current.trades(round, snapshot.startBlock, snapshot.blockNumber);
      if (current === client && snapshot?.round === round) {
        trades = list;
        tradesRound = round;
        tradesAt = Date.now();
      }
    } catch { /* Logs are best effort; the snapshot stays authoritative. */ } finally {
      tradesLoading = false;
      renderTrades();
    }
  }

  async function refreshQuote() {
    const amount = sharesInput();
    const key = client && snapshot ? `${client.address}:${snapshot.round}:${snapshot.trades}:${snapshot.settled}:${selectedColor}:${selectedSide}:${amount}` : '';
    if (key === quoteKey) return;
    quoteKey = key;
    const version = ++quoteVersion;
    quote = null;
    quoteError = '';
    if (!client || !snapshot) { renderOrder(); return; }
    if (!amount) { quoteError = '请输入 1 至 1,000 的整数份数。'; renderOrder(); return; }
    if (selectedSide === 'sell' && snapshot.holdings[selectedColor] < amount) { quoteError = '链上持仓不足，不能卖空。'; renderOrder(); return; }
    try {
      const next = await client.quote(selectedColor, selectedSide, amount);
      if (version === quoteVersion) quote = { ...next, shares: amount };
    } catch (error) {
      if (version === quoteVersion) quoteError = error.message || '报价读取失败。';
    } finally {
      if (version === quoteVersion) renderOrder();
    }
  }

  // Under Monad's reserve rule, a low-balance account may send value only once per 3 blocks.
  async function waitReserveWindow() {
    if (lastTxBlock === null) return;
    const target = lastTxBlock + BigInt(MARKET_RULES.reserveBlocks);
    for (let attempt = 0; attempt < 25; attempt += 1) {
      if (BigInt(await rpc('eth_blockNumber')) >= target) return;
      await sleep(300);
    }
  }

  async function runTx(label, build, { sendsValue = false, toMarket = true } = {}) {
    const info = walletInfo();
    if (pending) return null;
    if (!info.ready) { setMessage(info.reason); render(); return null; }
    if (toMarket && !client) { setMessage('请先设置市场合约。'); render(); return null; }
    pending = { label };
    const entry = { label, hash: '', status: 'pending' };
    setMessage(`${label}：请在钱包中确认…`);
    render();
    try {
      if (sendsValue) await waitReserveWindow();
      const call = await build();
      const hash = await sendTransaction(info.provider, { from: info.account, ...(toMarket ? { to: client.address } : {}), ...call });
      entry.hash = hash;
      txLog.unshift(entry);
      txLog.splice(8);
      setMessage(`${label}：已提交，等待区块确认…`);
      render();
      const receipt = await waitForReceipt(rpc, hash);
      lastTxBlock = receipt.blockNumber;
      entry.status = receipt.ok ? 'ok' : 'failed';
      if (!receipt.ok) throw new MonadError('TX_REVERTED', '交易已上链但执行失败，gas 已扣除。余额低于 10 MON 时，Monad 限制 3 个区块内连续转出 MON，请稍等几秒再试。');
      setMessage(`${label}：已在区块 ${receipt.blockNumber.toLocaleString('en-US')} 确认。`);
      return receipt;
    } catch (error) {
      if (entry.hash && entry.status === 'pending') entry.status = 'unknown';
      setMessage(marketErrorMessage(error) || walletErrorMessage(error));
      return null;
    } finally {
      pending = null;
      quoteKey = '';
      await refresh();
      void wallet?.refresh();
      void refreshTrades(true);
      render();
    }
  }

  function renderSetup() {
    const verified = Boolean(client);
    root.dataset.contract = checking ? 'checking' : verified ? 'verified' : 'none';
    setText('chain-contract-state', checking ? '校验中' : verified ? '代码已校验' : '未设置合约');
    setText('chain-address', verified ? client.address : '尚未设置');
    $('chain-address').title = verified ? client.address : '';
    $('chain-address-link').hidden = !verified;
    if (verified) $('chain-address-link').href = `${MONAD_TESTNET.explorerUrl}/address/${client.address}`;
    $('chain-share').hidden = !verified;
    $('chain-change').hidden = !verified;
    setText('chain-change', showSetup ? '收起更换' : '更换合约');
    $('chain-setup-forms').hidden = verified && !showSetup;
    setText('chain-house', snapshot ? formatMonPrecise(snapshot.houseCash) : '—');
    setText('chain-unclaimed', snapshot ? formatMonPrecise(snapshot.unclaimed) : '—');
    setText('chain-liquidity', snapshot ? `${fmt(snapshot.round && !snapshot.settled ? snapshot.liquidity : snapshot.nextLiquidity, 1)} 份` : '—');
    $('chain-manage').hidden = !verified;
    const info = walletInfo();
    const owner = Boolean(snapshot && info.account && snapshot.owner === info.account.toLowerCase());
    $('chain-owner-tools').hidden = !owner;
    const busy = Boolean(pending) || checking;
    root.querySelectorAll('#chain-setup-forms button, #chain-manage button').forEach(button => { button.disabled = busy; });
    if (readError) setText('chain-read-error', `读取失败：${readError} 将自动重试。`);
    else setText('chain-read-error', '');
  }

  function renderClock() {
    const current = phase();
    const remaining = snapshot?.round && !snapshot.settled ? Math.max(0, snapshot.startTime + MARKET_RULES.roundSeconds - chainNow()) : snapshot?.settled ? 0 : MARKET_RULES.roundSeconds;
    setText('chain-time', fmt(remaining, 1));
    $('chain-time-bar').style.width = `${100 * remaining / MARKET_RULES.roundSeconds}%`;
    $('chain-timer').setAttribute('aria-valuenow', fmt(remaining, 1));
    $('chain-countdown-dial').style.setProperty('--remaining', `${100 * remaining / MARKET_RULES.roundSeconds}%`);
    const urgent = current === 'locked' || current === 'settleable';
    $('chain-countdown-dial').classList.toggle('urgent', urgent);
    $('chain-timer').classList.toggle('urgent', urgent);
    const untilClose = snapshot ? snapshot.startTime + MARKET_RULES.tradingSeconds - chainNow() : 0;
    setText('chain-window-label', current === 'trading' ? `距封盘约 ${fmt(Math.max(0, untilClose), 1)} 秒` : current === 'locked' ? `随机区块 #${snapshot.randomBlock.toLocaleString('en-US')}` : current === 'settleable' ? '等待任何人提交结算' : '55 秒交易 + 5 秒封盘');
    if (current !== $('chain-phase').dataset.phase) render();
  }

  function renderArena() {
    const current = phase();
    const info = walletInfo();
    const odds = snapshot?.round ? scenarioOdds(snapshot.heat) : scenarioOdds(MARKET_RULES.baseHeat);
    const settled = current === 'settled';
    const prices = snapshot?.prices ?? { red: 1 / 3, black: 1 / 3, green: 1 / 3 };
    $('chain-phase').dataset.phase = current;
    setText('chain-phase', PHASE_TEXT[current]);
    $('chain-phase').className = `phase-pill ${PHASE_CLASS[current]}`;
    setText('chain-round-label', snapshot?.round ? `链上第 ${String(snapshot.round).padStart(2, '0')} 轮 / 区块 #${snapshot.blockNumber.toLocaleString('en-US')}` : snapshot ? `尚未开局 / 区块 #${snapshot.blockNumber.toLocaleString('en-US')}` : '链上回合');
    const action = current === 'settleable' ? 'settle' : current === 'idle' || current === 'settled' ? 'start' : '';
    $('chain-round-action').dataset.action = action;
    $('chain-round-action').disabled = !action || Boolean(pending) || !info.ready;
    setText('chain-round-action-label', { none: '先设置市场合约', loading: '读取中…', idle: '开始第一轮', trading: '链上交易中', locked: '等待随机区块', settleable: '结算本轮', settled: '开始下一轮' }[current]);
    $('chain-round-action').title = action && !info.ready ? info.reason : '';
    root.querySelectorAll('.arena [data-color]').forEach(button => {
      const color = button.dataset.color;
      const selected = color === selectedColor;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
      setText(`chain-price-${color}`, fmt(prices[color], 3));
      setText(`chain-odds-${color}`, settled ? (snapshot.result === color ? '已命中' : '未命中') : `${fmt(odds[color] * 100, 1)}%`);
    });
    root.querySelectorAll('.scenario-label').forEach(node => { node.textContent = settled ? '本轮链上结果' : '当前热度场景概率'; });
    root.querySelectorAll('.price-unit').forEach(node => { node.textContent = settled ? '到期兑付 · × 0.001 MON' : '市场价格 · × 0.001 MON / 份'; });
    $('chain-chart-prompt').hidden = Boolean(snapshot?.round);
    const heat = snapshot?.round ? (settled ? snapshot.finalHeat : snapshot.heat) : MARKET_RULES.baseHeat;
    setText('chain-heat', String(heat));
    setText('chain-noise-label', settled ? `行动热度 ${snapshot.heat} · 区块噪声 ${signed(snapshot.finalHeat - snapshot.heat, 0)}` : `区块哈希噪声 ±${MARKET_RULES.noiseRange} · 热度上下限 ±${MARKET_RULES.maxHeatShift}`);
    const ticketsLeft = snapshot?.round && !settled ? MARKET_RULES.tickets - snapshot.ticketsUsed : MARKET_RULES.tickets;
    setText('chain-tickets', `你的链上行动券 ${ticketsLeft} / ${MARKET_RULES.tickets} · 每次需钱包确认`);
    $('chain-ticket-dots').querySelectorAll('i').forEach((dot, index) => dot.classList.toggle('used', index >= ticketsLeft));
    const canAct = current === 'trading' && info.ready && !pending && ticketsLeft > 0;
    $('chain-heat-up').disabled = !canAct || heat >= MARKET_RULES.baseHeat + MARKET_RULES.maxHeatShift;
    $('chain-heat-down').disabled = !canAct || heat <= MARKET_RULES.baseHeat - MARKET_RULES.maxHeatShift;
    setText('chain-phase-note', PHASE_NOTES[current]);
    setText('chain-scenario-note', settled ? '结果已由合约确定：卡片显示到期兑付价。份额价格曲线来自本页轮询采样。' : '场景概率假设后续无人再用行动券，只计算区块哈希噪声；它不同于交易价格，也不代表最终胜率。');
    drawChart(prices);
  }

  function drawChart(prices) {
    const svg = $('chain-chart');
    const elapsedMs = snapshot?.round ? Math.min(60000, Math.max(0, (snapshot.settled ? 60 : chainNow() - snapshot.startTime) * 1000)) : 0;
    const width = Math.round(svg.getBoundingClientRect().width || 650);
    const key = `${snapshot?.round}:${history.length}:${snapshot?.settled}:${Math.round(elapsedMs / 500)}:${width}`;
    if (key === chartKey) return;
    chartKey = key;
    drawPriceChart(svg, {
      durationMs: MARKET_RULES.roundSeconds * 1000, lockMs: MARKET_RULES.tradingSeconds * 1000, points: history, elapsedMs, prices,
      label: `链上份额价格，红 ${fmt(prices.red, 3)}、黑 ${fmt(prices.black, 3)}、绿 ${fmt(prices.green, 3)}`,
      title: '本页轮询链上合约得到的价格采样',
    });
  }

  function renderOrder() {
    const current = phase();
    const info = walletInfo();
    const buy = selectedSide === 'buy';
    const amount = sharesInput();
    const owned = snapshot?.round && !snapshot.settled ? snapshot.holdings[selectedColor] : 0;
    const price = snapshot?.prices?.[selectedColor] ?? 1 / 3;
    const balance = info.state?.balanceWei;
    $('chain-selected-chip').className = `color-tag ${selectedColor}`;
    $('chain-selected-chip').innerHTML = `<i></i>${NAMES[selectedColor]}`;
    setText('chain-available', buy ? `钱包 ${typeof balance === 'bigint' ? formatMonPrecise(balance) : '—'} MON` : `链上持有 ${fmt(owned, 0)} 份`);
    setText('chain-quote-total-label', buy ? '预计支付（含费用）' : '预计到账（扣除费用）');
    root.querySelectorAll('[data-side]').forEach(button => {
      const selected = button.dataset.side === selectedSide;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    root.querySelectorAll('[data-shares]').forEach(button => {
      const selected = Number(button.dataset.shares) === amount;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    setText('chain-max-shares', buy ? '最多' : owned > 1000 ? '卖 1,000 份' : '卖出 100%');
    $('chain-max-shares').disabled = current !== 'trading' || Boolean(pending) || (!buy && owned < 1);
    const ready = quote && quote.shares === amount;
    setText('chain-quote-total', ready ? formatMonPrecise(quote.total, 5) : '—');
    setText('chain-quote-spot', `${fmt(price * SHARE_MON, 6)} MON / 份`);
    setText('chain-quote-average', ready ? `${fmt(mon(quote.gross) / amount, 6)} MON / 份` : '—');
    setText('chain-quote-gross', ready ? formatMonPrecise(quote.gross, 5) : '—');
    setText('chain-quote-fee', ready ? formatMonPrecise(quote.fee, 6) : '—');
    setText('chain-quote-impact', ready ? `${signed((quote.priceAfter - price) * 100, 2)} 个百分点` : '—');
    $('chain-win-preview').hidden = !buy || !ready || current === 'settled';
    if (buy && ready) {
      const payout = amount * SHARE_MON;
      const profit = payout - mon(quote.total);
      setText('chain-win-label', `若${LABELS[selectedColor]}盘命中，持有到结算`);
      setText('chain-quote-win-payout', `兑付 ${fmt(payout, 3)} MON`);
      setText('chain-quote-win-profit', signed(profit, 5));
      $('chain-quote-win-profit').className = pnlClass(profit);
      setText('chain-quote-roi', `命中净回报 ${signed(profit / mon(quote.total) * 100, 1)}%；未命中最多损失 ${formatMonPrecise(quote.total, 5)} MON，另需支付 gas。`);
    }
    const reason = current !== 'trading' ? (current === 'none' ? '先设置市场合约。' : '当前不在交易时间。')
      : !info.ready ? info.reason
        : quoteError || (!ready ? '正在读取链上报价…' : !quote.solvent ? '做市储备不足以覆盖所有可能兑付。' : '');
    $('chain-submit').disabled = Boolean(reason) || Boolean(pending);
    setText('chain-submit-label', pending ? `${pending.label}…` : current === 'trading' ? `${buy ? '买入' : '卖出'}${LABELS[selectedColor]}色份额` : current === 'settled' ? '本轮已结算' : '暂不可交易');
    setText('chain-quote-note', reason || `下单时重新报价，并${buy ? `多付 ${SLIPPAGE_PERCENT}% 作为价格保护，未用部分由合约当笔退回` : `设置 ${SLIPPAGE_PERCENT}% 最低到账保护`}。`);
  }

  function renderPortfolio() {
    const info = walletInfo();
    const live = snapshot?.round && !snapshot.settled;
    let spent = 0;
    for (const color of MARKET_COLORS) {
      const owned = snapshot?.round ? snapshot.holdings[color] : 0;
      const basis = snapshot?.round ? mon(snapshot.basis[color]) : 0;
      const price = snapshot?.prices?.[color] ?? 0;
      const value = owned * price * SHARE_MON;
      spent += basis;
      setText(`chain-holding-${color}`, fmt(owned, 0));
      setText(`chain-basis-${color}`, owned ? fmt(basis / owned, 6) : '—');
      setText(`chain-value-${color}`, fmt(value, 5));
      setText(`chain-pnl-${color}`, owned || basis ? signed(value - basis, 5) : '0.00000');
      $(`chain-pnl-${color}`).className = pnlClass(value - basis);
      $(`chain-sell-${color}`).disabled = !live || phase() !== 'trading' || owned < 1 || Boolean(pending) || !info.ready;
    }
    setText('chain-claimable', snapshot ? formatMonPrecise(snapshot.claimable) : '—');
    setText('chain-spent', fmt(spent, 5));
    setText('chain-wallet-balance', typeof info.state?.balanceWei === 'bigint' ? formatMonPrecise(info.state.balanceWei) : '—');
    const claimable = snapshot?.claimable ?? 0n;
    $('chain-claim').disabled = claimable === 0n || Boolean(pending) || !info.ready;
    setText('chain-claim', claimable > 0n ? `领取 ${formatMonPrecise(claimable)} MON` : '暂无可领取');
  }

  function renderTrades() {
    const body = $('chain-trades-body');
    const rows = trades.slice(0, 9).map(trade => {
      const row = document.createElement('tr');
      const who = document.createElement('td');
      const account = walletInfo().account?.toLowerCase();
      who.textContent = trade.trader === account ? '你' : shortenAddress(trade.trader);
      const block = document.createElement('small');
      block.textContent = `区块 #${trade.blockNumber.toLocaleString('en-US')}`;
      who.append(block);
      const side = document.createElement('td');
      const tag = document.createElement('span');
      tag.className = `trade-side ${trade.side}`;
      tag.textContent = `${trade.side === 'buy' ? '买' : '卖'}${LABELS[trade.color]}`;
      side.append(tag);
      const shares = document.createElement('td');
      shares.textContent = fmt(trade.shares, 0);
      const total = document.createElement('td');
      total.textContent = `${trade.side === 'buy' ? '−' : '+'}${formatMonPrecise(trade.total, 5)}`;
      const link = document.createElement('td');
      const anchor = document.createElement('a');
      anchor.href = `${MONAD_TESTNET.explorerUrl}/tx/${trade.hash}`;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.textContent = '查看 ↗';
      link.append(anchor);
      row.append(who, side, shares, total, link);
      return row;
    });
    if (rows.length) body.replaceChildren(...rows);
    else {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.className = 'empty-cell';
      cell.textContent = snapshot?.round ? '本轮还没有链上成交。' : '开局后，这里列出合约事件里的真实成交。';
      row.append(cell);
      body.replaceChildren(row);
    }
    setText('chain-trade-count', snapshot?.round ? `第 ${snapshot.round} 轮 · 合约记录 ${snapshot.trades} 笔` : '读取合约事件');
  }

  function renderTxs() {
    const list = $('chain-tx-list');
    if (!txLog.length) {
      const empty = document.createElement('li');
      empty.className = 'chain-tx-empty';
      empty.textContent = '本页提交的交易会列在这里，可跳转区块浏览器核对。';
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...txLog.map(entry => {
      const item = document.createElement('li');
      item.dataset.status = entry.status;
      const label = document.createElement('span');
      label.textContent = entry.label;
      const status = document.createElement('small');
      status.textContent = { pending: '确认中', ok: '已确认', failed: '执行失败', unknown: '状态未知' }[entry.status];
      const anchor = document.createElement('a');
      anchor.href = `${MONAD_TESTNET.explorerUrl}/tx/${entry.hash}`;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.textContent = `${entry.hash.slice(0, 10)}… ↗`;
      item.append(label, status, anchor);
      return item;
    }));
  }

  function render() {
    if (mode !== 'chain') return;
    renderSetup();
    renderArena();
    renderClock();
    renderOrder();
    renderPortfolio();
    renderTrades();
    renderTxs();
  }

  async function onRoundAction() {
    const action = $('chain-round-action').dataset.action;
    if (action === 'settle') {
      const receipt = await runTx('结算本轮', () => marketCalls.settle());
      if (receipt && snapshot && !snapshot.settled) setMessage('随机区块已超过 256 个区块无法读取，合约已登记新的随机区块，请几秒后再结算一次。');
    } else if (action === 'start') {
      const before = snapshot?.round ?? 0;
      const receipt = await runTx(before ? '开始下一轮' : '开始第一轮', () => marketCalls.start());
      if (receipt && snapshot?.round === before) setMessage('上一轮的随机区块已过期，合约已重新登记随机区块，请几秒后再开局。');
    }
  }

  async function maxShares() {
    if (!client) return;
    if (selectedSide === 'sell') {
      const owned = snapshot?.holdings[selectedColor] ?? 0;
      $('chain-shares').value = String(Math.max(1, Math.min(1000, owned)));
    } else {
      const balance = walletInfo().state?.balanceWei;
      if (typeof balance !== 'bigint') { setMessage('读到钱包余额后才能计算最多可买份数。'); return; }
      // Keep room for gas, which Monad charges on the full gas limit.
      const budget = balance - 30000000000000000n;
      let low = 0;
      let high = 1000;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const next = await client.quote(selectedColor, 'buy', mid);
        if (next.solvent && next.total * (100n + SLIPPAGE_PERCENT) / 100n <= budget) low = mid;
        else high = mid - 1;
      }
      if (!low) { setMessage('钱包余额不足以买入 1 份并支付 gas，可先从水龙头领取 MON。'); return; }
      $('chain-shares').value = String(low);
    }
    quoteKey = '';
    void refreshQuote();
    renderOrder();
  }

  function submitOrder() {
    const amount = sharesInput();
    const color = selectedColor;
    if (!amount || !client) return;
    if (selectedSide === 'buy') {
      void runTx(`买入${LABELS[color]} ${amount} 份`, async () => {
        const fresh = await client.quote(color, 'buy', amount);
        if (!fresh.solvent) throw new MonadError('INSUFFICIENT_RESERVE', '做市储备不足以覆盖所有可能兑付，交易未提交。');
        return marketCalls.buy(color, amount, fresh.total + fresh.total * SLIPPAGE_PERCENT / 100n + 1n);
      }, { sendsValue: true });
    } else {
      void runTx(`卖出${LABELS[color]} ${amount} 份`, async () => {
        const fresh = await client.quote(color, 'sell', amount);
        return marketCalls.sell(color, amount, fresh.total * (100n - SLIPPAGE_PERCENT) / 100n);
      });
    }
  }

  async function deploy(event) {
    event.preventDefault();
    const value = parseMon($('chain-deploy-amount').value);
    if (value === null || value < MIN_DEPLOY_WEI) { setMessage('初始储备至少 0.02 MON。储备越多，单轮可承接的成交越大。'); return; }
    const receipt = await runTx('部署市场合约', async () => ({ data: deployData(await estimateRandomDelay(rpc)), value }), { sendsValue: true, toMarket: false });
    if (receipt?.contractAddress) {
      await useAddress(receipt.contractAddress, { announce: false });
      setMessage(`市场合约已部署：${receipt.contractAddress}。复制分享链接，其他人即可进入同一个链上市场。`);
    } else if (receipt) setMessage('部署交易已确认，但没有读到合约地址，请在区块浏览器中查看。');
  }

  function fund(event) {
    event.preventDefault();
    const value = parseMon($('chain-fund-amount').value);
    if (!value) { setMessage('请输入有效的注资金额。'); return; }
    void runTx(`注资 ${formatMonPrecise(value)} MON`, () => marketCalls.fund(value), { sendsValue: true });
  }

  function withdraw(event) {
    event.preventDefault();
    const value = parseMon($('chain-withdraw-amount').value);
    if (!value) { setMessage('请输入有效的取回金额。'); return; }
    void runTx(`取回储备 ${formatMonPrecise(value)} MON`, () => marketCalls.withdraw(value));
  }

  async function copyShareLink() {
    if (!client) return;
    const url = new URL(location.href);
    url.search = `?market=${client.address}`;
    url.hash = '';
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url.href);
      setMessage('分享链接已复制：打开它会直接进入这个链上市场。');
    } catch {
      setMessage(`浏览器未允许自动复制，请手动复制：${url.href}`);
    }
  }

  document.querySelectorAll('[data-trade-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.tradeMode)));
  root.querySelectorAll('.arena [data-color]').forEach(button => button.addEventListener('click', () => { selectedColor = button.dataset.color; void refreshQuote(); render(); }));
  root.querySelectorAll('[data-side]').forEach(button => button.addEventListener('click', () => { selectedSide = button.dataset.side; void refreshQuote(); render(); }));
  root.querySelectorAll('[data-shares]').forEach(button => button.addEventListener('click', () => { $('chain-shares').value = button.dataset.shares; void refreshQuote(); renderOrder(); }));
  root.querySelectorAll('[data-chain-sell]').forEach(button => button.addEventListener('click', () => {
    selectedColor = button.dataset.chainSell;
    selectedSide = 'sell';
    $('chain-shares').value = String(Math.min(1000, snapshot?.holdings[selectedColor] ?? 0));
    quoteKey = '';
    void refreshQuote();
    render();
    $('chain-submit').scrollIntoView({ block: 'nearest' });
  }));
  $('chain-shares').addEventListener('input', () => { clearTimeout(quoteTimer); quoteTimer = setTimeout(() => void refreshQuote(), 250); renderOrder(); });
  $('chain-shares').addEventListener('keydown', event => { if (event.key === 'Enter' && !$('chain-submit').disabled) submitOrder(); });
  $('chain-max-shares').addEventListener('click', () => { void maxShares().catch(error => setMessage(error.message)); });
  $('chain-submit').addEventListener('click', submitOrder);
  $('chain-round-action').addEventListener('click', () => { void onRoundAction(); });
  $('chain-heat-up').addEventListener('click', () => { void runTx('链上加热 +1', () => marketCalls.act(true)); });
  $('chain-heat-down').addEventListener('click', () => { void runTx('链上降温 −1', () => marketCalls.act(false)); });
  $('chain-claim').addEventListener('click', () => { void runTx('领取兑付', () => marketCalls.claim()); });
  $('chain-attach-form').addEventListener('submit', event => { event.preventDefault(); void useAddress($('chain-address-input').value.trim()); });
  $('chain-deploy-form').addEventListener('submit', event => { void deploy(event); });
  $('chain-fund-form').addEventListener('submit', fund);
  $('chain-withdraw-form').addEventListener('submit', withdraw);
  $('chain-share').addEventListener('click', () => { void copyShareLink(); });
  $('chain-change').addEventListener('click', () => { showSetup = !showSetup; render(); });
  document.addEventListener('visibilitychange', () => { schedule(); if (active()) void refresh(); });
  window.addEventListener('resize', () => { chartKey = ''; if (mode === 'chain') renderArena(); });
  wallet?.subscribe(state => {
    if (state.account === lastAccount && state.chainId === lastChain) { if (mode === 'chain') { renderOrder(); renderPortfolio(); renderArena(); } return; }
    lastAccount = state.account;
    lastChain = state.chainId;
    quoteKey = '';
    void refresh();
  });
  const clock = setInterval(() => { if (active() && snapshot) { renderClock(); drawChart(snapshot.prices); } }, 250);

  setMode(mode);
  const initial = [linked, readStorage(MARKET_ADDRESS_KEY), DEFAULT_MARKET_ADDRESS].find(isMarketAddress);
  if (initial) void useAddress(initial, { announce: false });
  else setMessage('尚未设置市场合约：粘贴已有合约地址，或用钱包部署一个新的市场。');

  return () => {
    clearTimeout(pollTimer);
    clearTimeout(quoteTimer);
    clearInterval(clock);
  };
}
