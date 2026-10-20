import assert from 'node:assert/strict';
import test from 'node:test';

import { createLiveMeadowGate } from '../src/showrunner/live-meadow-gate.mjs';

test('starts once only for the online operator and serializes lifecycle', async () => {
  let online = true;
  let starts = 0;
  let release;
  const running = new Promise((resolve) => { release = resolve; });
  const gate = createLiveMeadowGate({
    operatorName: 'VPNAJ',
    isOnline: () => online,
    async onBegin() { starts += 1; await running; }
  });
  assert.equal(await gate.handleChat('Other', 'begin'), false);
  online = false;
  assert.equal(await gate.handleChat('VPNAJ', 'begin'), false);
  online = true;
  const first = gate.handleChat('VPNAJ', 'begin');
  await Promise.resolve();
  assert.equal(gate.status().state, 'running');
  assert.equal(await gate.handleChat('VPNAJ', 'begin'), false);
  release();
  assert.equal(await first, true);
  assert.equal(starts, 1);
  assert.equal(gate.status().state, 'completed');
});

test('stop and close abort without permitting a later begin', async () => {
  let stops = 0;
  const gate = createLiveMeadowGate({
    operatorName: 'VPNAJ', isOnline: () => true,
    async onBegin() {}, async onStop() { stops += 1; }
  });
  assert.equal(await gate.handleChat('VPNAJ', 'stop'), true);
  assert.equal(gate.status().state, 'aborted');
  assert.equal(stops, 1);
  gate.close();
  assert.equal(await gate.handleChat('VPNAJ', 'begin'), false);
});
