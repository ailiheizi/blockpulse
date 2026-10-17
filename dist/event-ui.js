const $ = id => document.getElementById(id);
const price = micros => Number.isSafeInteger(micros)
  ? `$${(micros / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`
  : '—';
const time = value => Number.isFinite(value) ? `${new Date(value).toLocaleString('zh-CN', { timeZone: 'UTC', hour12: false })} UTC` : '—';

/** Render the independent SOL/USD event contract and its latest source read. */
export function renderEventPanel(state, sourceState = {}) {
  const event = state.event?.mode === 'price' ? state.event : null;
  const observation = sourceState.observation || event?.latest || null;
  const pill = $('event-feed-state');
  const status = state.phase === 'settled' ? '已结算'
    : state.phase === 'locked' ? '截止 · 待结算'
      : sourceState.status === 'loading' ? '读取中'
        : sourceState.status === 'error' ? '读取失败'
          : event ? '已准备' : '未准备';
  pill.textContent = status;
  pill.className = `phase-pill ${state.phase === 'settled' ? 'trading' : state.phase === 'locked' ? 'locked' : sourceState.status === 'error' ? 'locked' : event ? 'trading' : 'ready'}`;
  $('event-prepare').disabled = sourceState.status === 'loading' || state.phase === 'trading' || state.phase === 'locked';
  $('event-source').textContent = event?.source || '—';
  $('event-product').textContent = event?.product || 'SOL-USD';
  $('event-reference').textContent = price(event?.referenceMicros);
  $('event-reference-time').textContent = `参考分钟起点 ${time(event?.referenceTimeMs)}`;
  $('event-lower').textContent = price(event?.lowerMicros);
  $('event-upper').textContent = price(event?.upperMicros);
  $('event-current').textContent = price(observation?.verified ? observation.closeMicros : observation?.priceMicros);
  $('event-current-time').textContent = observation ? `${observation.verified ? '目标 candle 收盘' : '最新行情'} ${time(observation.verified ? observation.candleTimeMs : observation.priceTimeMs)} · 服务器 ${time(observation.serverTimeMs)}` : '等待首次预检';
  $('event-cutoff').textContent = time(event?.cutoffTimeMs);
  $('event-target').textContent = `目标 ${time(event?.targetTimeMs)}`;
  const error = sourceState.error || '';
  $('event-error').hidden = !error;
  $('event-error').textContent = error ? `行情读取失败，事件保持待处理状态：${error}。不会用模拟价格替代。` : '';
  const message = state.phase === 'settled' && state.result
    ? `精确目标 candle 已读取并结算（${time(state.result.eventCandleTimeMs)}）；此数据读取校验不构成链上预言机证明。`
    : state.phase === 'locked' ? '交易已截止。等待 Coinbase 精确目标分钟 candle 收盘；数据不可用时继续待结算。'
      : sourceState.status === 'loading' ? '正在按需读取 Coinbase 服务器时间和 SOL-USD 行情。'
        : sourceState.status === 'error' ? '重试只会继续读取这次实时事件；不会切换到本地模拟。'
          : event ? `参考价已冻结。红 > ${price(event.upperMicros)}；黑 < ${price(event.lowerMicros)}；绿包含两条边界。`
            : '实时模式默认不联网。准备时读取服务器时间和上一根完整分钟 candle。';
  $('event-status').textContent = message;
}
