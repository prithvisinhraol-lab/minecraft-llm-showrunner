import { watch as nodeWatch } from 'node:fs';
import { open as nodeOpen, stat as nodeStat } from 'node:fs/promises';

const CHAT_PATTERN = /^\[[^\]]+\] \[[^\]]+\/INFO\]: (?:\[Not Secure\] )?<([^>]+)> (.*)$/u;

function coded(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function parsePublicChat(line) {
  const match = CHAT_PATTERN.exec(line);
  if (!match) return null;
  return Object.freeze({ username: match[1], message: match[2] });
}

function requireHost(host) {
  if (!host || typeof host !== 'object'
    || typeof host.stop !== 'function'
    || typeof host.close !== 'function'
    || !host.completion || typeof host.completion.then !== 'function') {
    throw coded('SURVIVAL_DEMO_LAUNCH_INVALID', 'launch did not return a valid survival demo host');
  }
  return host;
}

export function createSurvivalDemoLogGate({
  logPath,
  launch,
  watchImpl = nodeWatch,
  openImpl = nodeOpen,
  statImpl = nodeStat
} = {}) {
  if (typeof logPath !== 'string' || logPath.length === 0) throw new TypeError('logPath must be a nonempty string');
  if (typeof launch !== 'function') throw new TypeError('launch must be a function');
  if (typeof watchImpl !== 'function' || typeof openImpl !== 'function' || typeof statImpl !== 'function') {
    throw new TypeError('filesystem ports must be functions');
  }

  let state = 'idle';
  let offset = 0;
  let identity = null;
  let remainder = '';
  let watcher = null;
  let host = null;
  let queue = Promise.resolve();
  let closePromise = null;
  let closed = false;
  let triggerConsumed = false;
  let failureCode = null;

  function snapshot() {
    return Object.freeze({ state, triggerConsumed, failureCode });
  }

  async function cleanupActive(reason) {
    const active = host;
    host = null;
    if (!active) return;
    try {
      await active.stop(reason);
    } finally {
      await active.close();
    }
  }

  function trackCompletion(active) {
    void Promise.resolve(active.completion).then(async () => {
      if (host !== active) return;
      host = null;
      try {
        await active.close();
        if (!closed) state = 'completed';
      } catch (error) {
        if (!closed) {
          state = 'failed';
          failureCode = error?.code ?? 'SURVIVAL_DEMO_CLOSE_FAILED';
        }
      }
    }, async (error) => {
      if (host !== active) return;
      host = null;
      try { await active.close(); } catch { /* The run failure remains authoritative. */ }
      if (!closed) {
        state = 'failed';
        failureCode = error?.code ?? 'SURVIVAL_DEMO_RUN_FAILED';
      }
    });
  }

  async function handleStart() {
    if (closed || triggerConsumed || state !== 'waiting') return;
    triggerConsumed = true;
    state = 'launching';
    let launched;
    try {
      launched = requireHost(await launch());
    } catch (error) {
      state = closed ? 'stopped' : 'failed';
      failureCode = error?.code ?? 'SURVIVAL_DEMO_LAUNCH_FAILED';
      return;
    }
    host = launched;
    if (closed) {
      await cleanupActive('gate closing');
      state = 'stopped';
      return;
    }
    state = 'running';
    trackCompletion(launched);
  }

  async function handleStop() {
    if (closed || !host || !['launching', 'running'].includes(state)) return;
    state = 'stopping';
    await cleanupActive('operator requested stop');
    state = 'stopped';
  }

  async function handleLine(line) {
    const chat = parsePublicChat(line);
    if (!chat || chat.username !== 'VPNAJ') return;
    if (chat.message === 'start') await handleStart();
    else if (chat.message === 'stop') await handleStop();
  }

  async function readNewContent() {
    if (closed) return;
    const details = await statImpl(logPath);
    if (!identity || details.dev !== identity.dev || details.ino !== identity.ino || details.size < offset) {
      throw coded('SURVIVAL_DEMO_LOG_REPLACED', 'server log was replaced or truncated');
    }
    if (details.size === offset) return;
    const length = details.size - offset;
    const buffer = Buffer.alloc(length);
    const file = await openImpl(logPath, 'r');
    try {
      const { bytesRead } = await file.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw coded('SURVIVAL_DEMO_LOG_READ_FAILED', 'server log changed during read');
    } finally {
      await file.close();
    }
    offset = details.size;
    const text = remainder + buffer.toString('utf8');
    const lines = text.split('\n');
    remainder = lines.pop();
    for (const raw of lines) await handleLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
  }

  function scheduleRead() {
    queue = queue.then(readNewContent).catch(async (error) => {
      if (closed) return;
      state = 'failed';
      failureCode = error?.code ?? 'SURVIVAL_DEMO_LOG_READ_FAILED';
      watcher?.close?.();
      watcher = null;
      try { await cleanupActive('log gate failed'); } catch { /* Preserve the log failure. */ }
    });
    return queue;
  }

  async function start() {
    if (closed) throw coded('SURVIVAL_DEMO_GATE_CLOSED', 'survival demo gate is closed');
    if (state !== 'idle') return;
    const details = await statImpl(logPath);
    offset = details.size;
    identity = { dev: details.dev, ino: details.ino };
    state = 'waiting';
    watcher = watchImpl(logPath, () => { void scheduleRead(); });
    watcher.on?.('error', (error) => {
      queue = queue.then(() => { throw coded('SURVIVAL_DEMO_LOG_WATCH_FAILED', 'server log watcher failed', error); });
      void scheduleRead();
    });
    await scheduleRead();
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    watcher?.close?.();
    watcher = null;
    closePromise = (async () => {
      await queue;
      await cleanupActive('gate closing');
      state = 'stopped';
    })();
    return closePromise;
  }

  return Object.freeze({ start, close, status: snapshot });
}
