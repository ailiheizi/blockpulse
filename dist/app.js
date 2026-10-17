import { createGame, placeBet, startRound, advance, playerAction, nextRound, resetGame } from './game.js';

const $ = id => document.getElementById(id);
const COLORS = {
  red: { label: '红 · 看涨', short: '红盘', symbol: '↗', css: 'up', paint: 'var(--red)' },
  black: { label: '黑 · 看跌', short: '黑盘', symbol: '↘', css: 'down', paint: 'var(--blue)' },
  green: { label: '绿 · 持平', short: '绿盘', symbol: '＝', css: 'flat', paint: 'var(--green)' },
};
const KEY = 'blockpulse-playground-v1';
const number = n => n.toLocaleString('zh-CN');
const signed = n => n > 0 ? `+${number(n)}` : number(n);
const classForProfit = n => n > 0 ? 'gain' : n < 0 ? 'loss' : '';
const playerOf = s => s.participants.find(p => p.id === 'player');
const seed = () => Math.floor(Math.random() * 0xffffffff);
let state = createGame(seed());
let selectedColor = 'red';
let selectedStake = 50;
let lastNow = performance.now();
let lastPhase = '';
let feedKey = '';
let historyKey = '';
let opponentsKey = '';
let chartKey = '';

try {
  const saved = JSON.parse(localStorage.getItem(KEY));
  if (saved?.version === 1 && ['betting', 'active', 'settled'].includes(saved.state?.phase)
      && saved.state.participants?.length === 3 && saved.state.history?.length
      && saved.state.participants.every(p => Number.isInteger(p.balance) && p.balance >= 0)
      && saved.state.participants.reduce((sum, p) => sum + p.balance, saved.state.pool) === 3000) {
    state = saved.state;
    selectedColor = COLORS[saved.selectedColor] ? saved.selectedColor : 'red';
    selectedStake = [20, 50, 100].includes(saved.selectedStake) ? saved.selectedStake : 50;
  }
} catch { /* A fresh game remains usable when storage is unavailable. */ }
$('stake').value = String(selectedStake);

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify({ version: 1, state, selectedColor, selectedStake })); } catch { /* Storage is optional. */ }
}

function showError(message) {
  $('error').textContent = message;
  $('error').hidden = !message;
}

function announce(message) { $('announcement').textContent = message; }

function drawChart() {
  const svg = $('chart');
  const width = Math.max(240, svg.getBoundingClientRect().width || 620);
  const key = `${width}:${state.elapsedMs}:${state.heat}:${state.history.length}`;
  if (chartKey === key) return;
  chartKey = key;
  const height = 204;
  const left = 34, right = width - 12, top = 17, bottom = 177;
  const distance = Math.max(5, ...state.history.map(p => Math.abs(p.heat - 100) + 1));
  const y = heat => top + (100 + distance - heat) / (2 * distance) * (bottom - top);
  const x = ms => left + ms / state.durationMs * (right - left);
  const points = [...state.history];
  if (points.at(-1)?.timeMs !== state.elapsedMs) points.push({ timeMs: state.elapsedMs, heat: state.heat });
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.timeMs).toFixed(2)},${y(p.heat).toFixed(2)}`).join(' ');
  const fill = `${path} L${x(state.elapsedMs).toFixed(2)},${bottom} L${left},${bottom} Z`;
  const color = state.heat > 100 ? 'red' : state.heat < 100 ? 'black' : 'green';
  const paint = state.phase === 'betting' ? 'var(--purple)' : COLORS[color].paint;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('aria-label', `第${state.round}轮热度曲线，当前${state.heat}，基准100，经过${(state.elapsedMs / 1000).toFixed(1)}秒`);
  svg.innerHTML = `<defs><linearGradient id="heat-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${paint}" stop-opacity="0.16"/><stop offset="100%" stop-color="${paint}" stop-opacity="0"/></linearGradient></defs>
    <title>本轮游戏热度，不是真实链上交易数</title>
    ${[100 + distance, 100, 100 - distance].map(n => `<line x1="${left}" x2="${right}" y1="${y(n)}" y2="${y(n)}" class="${n === 100 ? 'chart-baseline' : 'chart-grid'}"/><text x="0" y="${y(n) + 4}" class="chart-text">${n}</text>`).join('')}
    ${[0, 5000, 10000, 15000].map(ms => `<text x="${x(ms)}" y="199" text-anchor="${ms === 0 ? 'start' : ms === 15000 ? 'end' : 'middle'}" class="chart-text">${ms / 1000}s</text>`).join('')}
    <path d="${fill}" class="chart-area"/><path d="${path}" class="chart-path" style="stroke:${paint}"/>
    <circle cx="${x(state.elapsedMs)}" cy="${y(state.heat)}" r="5" class="chart-dot" style="fill:${paint}"/>`;
}

function drawOpponents() {
  const bots = state.participants.filter(p => p.id !== 'player');
  const key = JSON.stringify(bots);
  if (key === opponentsKey) return;
  opponentsKey = key;
  const descriptions = {
    momentum: '跟随上一局方向，行动时顺势推热度',
    reversion: '偏离后押回归，行动时尝试拉回基准',
  };
  $('opponents').innerHTML = bots.map(bot => `<article class="opponent">
    <div class="bot-avatar ${bot.id === 'reversion' ? 'mean' : ''}" aria-hidden="true">${bot.id === 'momentum' ? '↗' : '⇄'}</div>
    <div><p class="bot-name">${bot.name}</p><p class="bot-strategy">${descriptions[bot.id]}</p>
    <div class="bot-info"><span class="bot-bet ${bot.bet?.color || ''}">${bot.bet ? `${COLORS[bot.bet.color].label} · ${bot.bet.stake}` : '开局时公布预测'}</span><span>行动券 ${bot.tickets} / 3</span></div></div>
    <div class="bot-balance">${number(bot.balance)}<small>可用积分</small></div>
  </article>`).join('');
}

function drawFeed() {
  const key = `${state.round}:${state.events.at(-1)?.id}`;
  if (key === feedKey) return;
  feedKey = key;
  $('feed').innerHTML = state.events.slice(-5).reverse().map(event => `<li><time>${(event.timeMs / 1000).toFixed(1)}s</time><span>${event.message}</span></li>`).join('');
}

function drawHistory() {
  const key = `${state.results.length}:${state.results.at(-1)?.finalHeat}`;
  if (key === historyKey) return;
  historyKey = key;
  $('record-count').textContent = `${state.results.length} 局`;
  if (!state.results.length) {
    $('history').innerHTML = '<div class="empty-state"><span>↗ ↘ ＝</span><p>第一局，从你的判断开始。</p></div>';
    return;
  }
  $('history').innerHTML = `<table class="history-table"><thead><tr><th>回合</th><th>收盘结果</th><th>热度</th><th>你的净盈亏</th></tr></thead><tbody>${state.results.slice(-6).reverse().map(result => `<tr><td>#${String(result.round).padStart(2, '0')}</td><td><span class="color-tag ${result.color}"><i></i>${COLORS[result.color].short}${result.refund ? ' · 退款' : ''}</span></td><td>${result.finalHeat}</td><td class="${classForProfit(result.profits.player)}">${signed(result.profits.player)}</td></tr>`).join('')}</tbody></table>`;
}

function drawResult() {
  const result = state.result;
  $('result').hidden = !result;
  if (!result) return;
  const stake = result.stakes.player;
  const payout = result.payouts.player;
  const profit = result.profits.player;
  const hit = result.winnerIds.includes('player');
  const title = result.refund ? '无人命中，本轮退款' : hit ? `你命中了${COLORS[result.color].short}` : `${COLORS[result.color].short}收盘，你未命中`;
  $('result').innerHTML = `<div class="result-head"><strong>${title}</strong><span class="${profit < 0 ? 'loss' : ''}">${signed(profit)}</span></div>
    <p>${result.refund ? '所有参与者取回原额押注，积分没有增加。' : `收盘热度 ${result.finalHeat}。${result.winnerIds.length} 位命中者按下注比例分享 ${result.pool} 积分。`}</p>
    <div class="result-stats"><div><span>本轮投入</span><b>${stake}</b></div><div><span>到账（含本金）</span><b>${payout}</b></div><div><span>净盈亏</span><b class="${classForProfit(profit)}">${signed(profit)}</b></div></div>`;
}

function render() {
  const player = playerOf(state);
  const betting = state.phase === 'betting';
  const active = state.phase === 'active';
  const settled = state.phase === 'settled';
  const outcome = state.heat > 100 ? 'red' : state.heat < 100 ? 'black' : 'green';
  $('balance').textContent = number(player.balance);
  $('locked').textContent = player.bet ? `本轮${settled ? '已结算' : '锁定'} ${player.bet.stake} 积分` : '本轮未下注';
  $('pool').textContent = number(settled ? state.result.pool : state.pool);
  $('pool-label').textContent = settled ? '本轮已结算积分' : '本轮积分池';
  $('pool-context').textContent = settled ? '已分配或退回，不再锁定' : '命中者按下注比例分配';
  $('block').textContent = `R${String(state.round).padStart(2, '0')} / B${String(state.block).padStart(2, '0')}`;
  const totalProfit = player.balance + (settled ? 0 : player.bet?.stake || 0) - 1000;
  $('total-profit').textContent = signed(totalProfit);
  $('total-profit').className = classForProfit(totalProfit);
  $('round').textContent = `ROUND ${String(state.round).padStart(2, '0')}`;
  $('phase').textContent = active ? '封盘 · 行动中' : settled ? '本轮已结算' : '等待下注';
  $('phase').className = `phase-pill ${state.phase}`;
  $('heat').textContent = state.heat;
  $('heat-direction').textContent = `${COLORS[outcome].symbol} ${state.heat === 100 ? '平盘' : (state.heat > 100 ? '+' : '') + (state.heat - 100)}`;
  $('heat-direction').className = `direction ${COLORS[outcome].css}`;
  $('time').textContent = (state.remainingMs / 1000).toFixed(1);
  $('time-bar').style.width = `${100 * state.remainingMs / state.durationMs}%`;
  $('timer').setAttribute('aria-valuenow', (state.remainingMs / 1000).toFixed(1));
  $('timer').classList.toggle('urgent', active && state.remainingMs < 4000);
  const actions = state.events.filter(e => e.type === 'action').length;
  $('action-count').textContent = `${actions} 次有效行动 · 游戏指数`;
  $('tickets').textContent = active ? `你的行动券 ${player.tickets} / 3 · 可保留不用` : settled ? `你使用了 ${3 - player.tickets} 张行动券` : '每轮最多 3 张行动券，可以保留不用';
  $('heat-up').disabled = $('heat-down').disabled = !active || player.tickets <= 0;
  $('phase-note').textContent = active ? '预测已锁定。观察 Bot 的动作，选择加热、降温，或按兵不动。' : settled ? '结果来自本轮所有有效行动。你可以查看结算，或继续下一轮。' : '选好方向后开始。封盘后无法改注，15 秒里你和 Bot 都能行动。';
  document.querySelectorAll('[data-color]').forEach(button => {
    button.disabled = !betting;
    button.classList.toggle('selected', button.dataset.color === selectedColor);
    button.setAttribute('aria-pressed', String(button.dataset.color === selectedColor));
  });
  document.querySelectorAll('[data-stake]').forEach(button => {
    button.disabled = !betting || Number(button.dataset.stake) > player.balance;
    button.classList.toggle('selected', Number(button.dataset.stake) === Number($('stake').value));
  });
  $('stake').disabled = !betting;
  $('stake').max = player.balance;
  $('stake-max').textContent = `可用 ${number(player.balance)}`;
  $('primary-action').disabled = active;
  $('primary-action').innerHTML = active ? '<span>封盘中，等待本轮结算</span><b>···</b>' : settled ? `<span>${player.balance < 20 ? '积分不足，重置试玩' : '继续下一轮'}</span><b>→</b>` : `<span>锁定 ${number(Number($('stake').value) || 0)} 积分，开始本轮</span><b>→</b>`;
  $('bet-hint').textContent = active ? `你已押${COLORS[player.bet.color].short}，投入 ${player.bet.stake} 积分。每位参与者最多 3 次行动。` : settled ? '到账包含本金，净盈亏才是本轮积分变化。' : '两位 Bot 同样从 1,000 积分起步，行动额度与你一致。';
  drawChart(); drawOpponents(); drawFeed(); drawHistory(); drawResult();
  if (lastPhase !== state.phase) {
    if (settled) {
      announce(`第${state.round}轮${COLORS[outcome].short}收盘，热度${state.heat}，你的净盈亏${signed(state.result.profits.player)}积分。`);
      if (window.matchMedia('(max-width:760px)').matches) requestAnimationFrame(() => $('result').scrollIntoView({ behavior: 'auto', block: 'center' }));
    }
    else if (active) announce('已封盘，十五秒行动时间开始。');
    lastPhase = state.phase;
    persist();
  }
}

function flushTime() {
  const now = performance.now();
  const dt = Math.max(0, now - lastNow);
  lastNow = now;
  if (state.phase === 'active') state = advance(state, dt);
}

function changeColor(color) {
  if (state.phase !== 'betting') return;
  selectedColor = color;
  showError(''); persist(); render();
}
document.querySelectorAll('[data-color]').forEach(button => button.addEventListener('click', () => changeColor(button.dataset.color)));
document.querySelectorAll('[data-stake]').forEach(button => button.addEventListener('click', () => {
  if (state.phase !== 'betting') return;
  selectedStake = Number(button.dataset.stake);
  $('stake').value = selectedStake;
  showError(''); persist(); render();
}));
$('stake').addEventListener('input', () => { showError(''); render(); });

$('primary-action').addEventListener('click', () => {
  try {
    flushTime();
    if (state.phase === 'betting') {
      const stake = Number($('stake').value);
      state = startRound(placeBet(state, selectedColor, stake));
      selectedStake = stake;
      if (window.matchMedia('(max-width:760px)').matches) requestAnimationFrame(() => document.querySelector('.arena').scrollIntoView({ behavior: 'auto', block: 'start' }));
    } else if (state.phase === 'settled') {
      if (playerOf(state).balance < 20) freshGame();
      else {
        state = nextRound(state);
        selectedStake = [100, 50, 20].filter(n => n <= playerOf(state).balance && n <= selectedStake)[0] || 20;
        $('stake').value = selectedStake;
      }
    }
    lastNow = performance.now(); showError(''); persist(); render();
  } catch (error) { showError(error.reason || error.message); render(); }
});

function act(delta) {
  try {
    flushTime();
    state = playerAction(state, delta);
    showError(''); persist(); render();
    const arena = document.querySelector('.arena');
    arena.classList.remove('flash');
    requestAnimationFrame(() => arena.classList.add('flash'));
    announce(`已${delta > 0 ? '加热' : '降温'}，热度${state.heat}，剩余${playerOf(state).tickets}张行动券。`);
  } catch (error) { showError(error.reason || error.message); render(); }
}
$('heat-up').addEventListener('click', () => act(1));
$('heat-down').addEventListener('click', () => act(-1));

function freshGame() {
  state = resetGame(seed());
  selectedColor = 'red'; selectedStake = 50; $('stake').value = 50;
  lastNow = performance.now(); feedKey = historyKey = opponentsKey = chartKey = ''; lastPhase = '';
  showError(''); persist(); render(); announce('试玩已重置，所有参与者回到一千积分。');
}
$('reset').addEventListener('click', freshGame);
window.addEventListener('resize', () => { chartKey = ''; drawChart(); });
window.addEventListener('pagehide', persist);
setInterval(() => { flushTime(); render(); }, 100);
render();
