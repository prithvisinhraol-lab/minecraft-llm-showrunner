import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSurvivalDemoLogGate } from '../src/llm-agent/survival-demo-log-gate.mjs';

const delay = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(assertion, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await delay();
    }
  }
  throw last;
}

async function fixture(t, initial = '') {
  const directory = await mkdtemp(path.join(tmpdir(), 'survival-demo-gate-'));
  const logPath = path.join(directory, 'latest.log');
  await writeFile(logPath, initial);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    logPath,
    appendChat: (username, message) => appendFile(
      logPath,
      `[12:34:56] [Server thread/INFO]: <${username}> ${message}\n`
    ),
    appendRaw: (line) => appendFile(logPath, `${line}\n`)
  };
}

function controlledRun() {
  const calls = [];
  let finish;
  const completion = new Promise((resolve) => { finish = resolve; });
  return {
    calls,
    finish,
    host: {
      completion,
      async stop(reason) { calls.push(`stop:${reason}`); },
      async close() { calls.push('close'); }
    }
  };
}

test('ignores historical content and launches once only for exact VPNAJ start', async (t) => {
  const log = await fixture(t, '[12:00:00] [Server thread/INFO]: <VPNAJ> start\n');
  const launches = [];
  const active = controlledRun();
  const gate = createSurvivalDemoLogGate({
    logPath: log.logPath,
    launch: async () => { launches.push('launch'); return active.host; }
  });
  t.after(() => gate.close());
  await gate.start();

  await log.appendChat('Other', 'start');
  await log.appendChat('VPNAJ', 'Start');
  await log.appendChat('VPNAJ', 'start ');
  await log.appendRaw('[12:34:56] [Server thread/INFO]: [VPNAJ: start]');
  await delay(50);
  assert.deepEqual(launches, []);

  await log.appendChat('VPNAJ', 'start');
  await eventually(() => assert.deepEqual(launches, ['launch']));
  await log.appendChat('VPNAJ', 'start');
  await delay(50);
  assert.deepEqual(launches, ['launch']);
  assert.equal(gate.status().state, 'running');
});

test('accepts the offline-mode Not Secure public-chat format used by the live server', async (t) => {
  const log = await fixture(t);
  const active = controlledRun();
  let launches = 0;
  const gate = createSurvivalDemoLogGate({
    logPath: log.logPath,
    launch: async () => { launches += 1; return active.host; }
  });
  t.after(() => gate.close());
  await gate.start();
  await log.appendRaw('[12:34:56] [Server thread/INFO]: [Not Secure] <VPNAJ> start');
  await eventually(() => assert.equal(launches, 1));
  assert.equal(gate.status().state, 'running');
});

test('exact VPNAJ stop cancels and closes the active run', async (t) => {
  const log = await fixture(t);
  const active = controlledRun();
  const gate = createSurvivalDemoLogGate({ logPath: log.logPath, launch: async () => active.host });
  t.after(() => gate.close());
  await gate.start();
  await log.appendChat('VPNAJ', 'start');
  await eventually(() => assert.equal(gate.status().state, 'running'));

  await log.appendChat('Other', 'stop');
  await log.appendChat('VPNAJ', 'stop ');
  await delay(30);
  assert.deepEqual(active.calls, []);
  await log.appendChat('VPNAJ', 'stop');
  await eventually(() => assert.deepEqual(active.calls, ['stop:operator requested stop', 'close']));
  assert.equal(gate.status().state, 'stopped');
});

test('close during launch closes a late host and cannot leave it running', async (t) => {
  const log = await fixture(t);
  const active = controlledRun();
  let releaseLaunch;
  const launch = new Promise((resolve) => { releaseLaunch = resolve; });
  const gate = createSurvivalDemoLogGate({ logPath: log.logPath, launch: () => launch });
  await gate.start();
  await log.appendChat('VPNAJ', 'start');
  await eventually(() => assert.equal(gate.status().state, 'launching'));

  const closing = gate.close();
  releaseLaunch(active.host);
  await closing;

  assert.deepEqual(active.calls, ['stop:gate closing', 'close']);
  assert.equal(gate.status().state, 'stopped');
});

test('completion transitions the one-shot gate without launching again', async (t) => {
  const log = await fixture(t);
  const active = controlledRun();
  let launches = 0;
  const gate = createSurvivalDemoLogGate({
    logPath: log.logPath,
    launch: async () => { launches += 1; return active.host; }
  });
  t.after(() => gate.close());
  await gate.start();
  await log.appendChat('VPNAJ', 'start');
  await eventually(() => assert.equal(gate.status().state, 'running'));
  active.finish({ status: 'succeeded' });
  await eventually(() => assert.equal(gate.status().state, 'completed'));
  await log.appendChat('VPNAJ', 'start');
  await delay(30);
  assert.equal(launches, 1);
});
