import { readMonadHead } from './monad.js';

export function createHeadMonitor({ read = readMonadHead, intervalMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const listeners = new Set();
  let version = 0;
  let timer;
  let request;
  let disposed = false;
  let state = Object.freeze({ status: 'idle', enabled: false, visible: true, online: true, head: null, samples: Object.freeze([]), error: '' });

  function update(patch) {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) listener(state);
  }

  function cancel() {
    clearTimer(timer);
    timer = undefined;
    version += 1;
    request?.abort();
    request = null;
  }

  async function refresh() {
    if (disposed) return;
    if (!state.visible || !state.online) {
      cancel();
      update({ enabled: true, status: state.online ? 'paused' : 'offline', error: '' });
      return;
    }
    if (request) return;
    clearTimer(timer);
    const currentVersion = ++version;
    const controller = new AbortController();
    request = controller;
    update({ status: 'reading', enabled: true, error: '' });
    try {
      const head = await read({ signal: controller.signal });
      if (currentVersion !== version || disposed) return;
      const previous = state.samples.filter(sample => sample.number !== head.number || sample.hash !== head.hash);
      const samples = Object.freeze([head, ...previous].slice(0, 6));
      update({ status: 'live', head, samples });
    } catch (error) {
      if (currentVersion !== version || disposed) return;
      update({ status: 'error', enabled: false, error: error?.message || '区块读取失败，请稍后重试。' });
    } finally {
      if (currentVersion === version && !disposed) {
        request = null;
        if (state.enabled && state.visible && state.online) timer = setTimer(() => { void refresh(); }, intervalMs);
      }
    }
  }

  function setEnvironment({ visible = state.visible, online = state.online }) {
    if (disposed || (visible === state.visible && online === state.online)) return;
    update({ visible, online });
    if (!state.enabled) return;
    if (!visible || !online) {
      cancel();
      update({ status: online ? 'paused' : 'offline' });
    } else {
      void refresh();
    }
  }

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
    refresh,
    setEnvironment,
    pause() {
      if (disposed) return;
      cancel();
      update({ status: 'paused', enabled: false });
    },
    dispose() {
      cancel();
      disposed = true;
      listeners.clear();
    },
  };
}
