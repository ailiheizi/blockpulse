import test from 'node:test';
import assert from 'node:assert/strict';
import { createHeadMonitor } from '../dist/monad-monitor.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const head = number => Object.freeze({ number: BigInt(number), hash: `0x${BigInt(number).toString(16).padStart(64, '0')}`, timestamp: 1800000000000, readAt: 1800000001000, latencyMs: 20 });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture(read) {
  let nextTimer = 0;
  const timers = new Map();
  const monitor = createHeadMonitor({
    read,
    setTimer(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  return { monitor, timers };
}

test('区块监控默认不访问网络，显式读取后只安排一个后续刷新', async () => {
  let calls = 0;
  const { monitor, timers } = fixture(async () => head(++calls));
  assert.equal(calls, 0);
  assert.equal(timers.size, 0);
  await monitor.refresh();
  assert.equal(calls, 1);
  assert.equal(monitor.getState().status, 'live');
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 5000);
  const [id, timer] = [...timers.entries()][0];
  timers.delete(id);
  timer.callback();
  await tick();
  assert.equal(calls, 2);
  assert.equal(timers.size, 1);
  monitor.dispose();
  assert.equal(timers.size, 0);
});

test('重复点击不发并行请求，暂停使延迟结果失效', async () => {
  const pendingRead = deferred();
  let calls = 0;
  let signal;
  const { monitor, timers } = fixture(options => { calls += 1; signal = options.signal; return pendingRead.promise; });
  const pending = monitor.refresh();
  await monitor.refresh();
  assert.equal(calls, 1);
  monitor.pause();
  assert.equal(signal.aborted, true);
  pendingRead.resolve(head(1));
  await pending;
  assert.equal(monitor.getState().status, 'paused');
  assert.equal(monitor.getState().enabled, false);
  assert.equal(monitor.getState().head, null);
  assert.equal(timers.size, 0);
  monitor.dispose();
});

test('离线和后台暂停并保留读取意图，手动暂停后不会自动恢复', async () => {
  let calls = 0;
  const { monitor, timers } = fixture(async () => head(++calls));
  monitor.setEnvironment({ online: false });
  await monitor.refresh();
  assert.equal(calls, 0);
  assert.equal(monitor.getState().status, 'offline');
  assert.equal(monitor.getState().enabled, true);
  monitor.setEnvironment({ online: true });
  await tick();
  assert.equal(calls, 1);
  monitor.setEnvironment({ visible: false });
  assert.equal(monitor.getState().status, 'paused');
  assert.equal(timers.size, 0);
  monitor.setEnvironment({ visible: true });
  await tick();
  assert.equal(calls, 2);
  monitor.pause();
  monitor.setEnvironment({ visible: false, online: false });
  monitor.setEnvironment({ visible: true, online: true });
  await tick();
  assert.equal(calls, 2);
  assert.equal(monitor.getState().enabled, false);
  monitor.dispose();
});

test('恢复后的新请求不会被后台取消前的旧响应覆盖', async () => {
  const requests = [deferred(), deferred()];
  let calls = 0;
  const { monitor } = fixture(() => requests[calls++].promise);
  const first = monitor.refresh();
  monitor.setEnvironment({ visible: false });
  monitor.setEnvironment({ visible: true });
  assert.equal(calls, 2);
  requests[1].resolve(head(2));
  await tick();
  requests[0].resolve(head(1));
  await first;
  assert.equal(monitor.getState().head.number, 2n);
  assert.equal(monitor.getState().status, 'live');
  monitor.dispose();
});

test('采样去重并限制六个区块，相同高度不同哈希作为不同快照保留', async () => {
  let current = head(1);
  const { monitor, timers } = fixture(async () => current);
  for (let number = 1; number <= 8; number += 1) {
    current = head(number);
    await monitor.refresh();
  }
  assert.deepEqual(monitor.getState().samples.map(sample => sample.number), [8n, 7n, 6n, 5n, 4n, 3n]);
  await monitor.refresh();
  assert.equal(monitor.getState().samples.length, 6);
  current = Object.freeze({ ...head(8), hash: `0x${'f'.repeat(64)}` });
  await monitor.refresh();
  assert.equal(monitor.getState().samples[0].hash, current.hash);
  assert.equal(monitor.getState().samples[1].number, 8n);
  assert.equal(timers.size, 1);
  assert.equal(Object.isFrozen(monitor.getState().samples), true);
  monitor.dispose();
});

test('请求失败保留最后成功数据并停止刷新，只有手动重试恢复', async () => {
  let failing = false;
  let calls = 0;
  const { monitor, timers } = fixture(async () => {
    calls += 1;
    if (failing) throw new Error('RPC busy');
    return head(calls);
  });
  await monitor.refresh();
  failing = true;
  await monitor.refresh();
  assert.equal(monitor.getState().status, 'error');
  assert.equal(monitor.getState().head.number, 1n);
  assert.equal(monitor.getState().error, 'RPC busy');
  assert.equal(monitor.getState().enabled, false);
  assert.equal(timers.size, 0);
  monitor.setEnvironment({ online: false });
  monitor.setEnvironment({ online: true });
  await tick();
  assert.equal(calls, 2);
  failing = false;
  await monitor.refresh();
  assert.equal(monitor.getState().status, 'live');
  assert.equal(monitor.getState().head.number, 3n);
  assert.equal(monitor.getState().error, '');
  monitor.dispose();
});

test('销毁会取消待处理读取，后续环境事件与响应不会更新状态', async () => {
  const pendingRead = deferred();
  let calls = 0;
  const { monitor, timers } = fixture(() => { calls += 1; return pendingRead.promise; });
  let updates = 0;
  monitor.subscribe(() => { updates += 1; });
  const pending = monitor.refresh();
  monitor.dispose();
  const before = updates;
  pendingRead.resolve(head(1));
  await pending;
  await monitor.refresh();
  monitor.setEnvironment({ online: false });
  assert.equal(updates, before);
  assert.equal(calls, 1);
  assert.equal(timers.size, 0);
});
