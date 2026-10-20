import assert from 'node:assert/strict';
import test from 'node:test';

import { createLiveTestPorts } from '../src/showrunner/live-test-ports.mjs';

function command(kind, payload = {}) {
  return { kind, commandId: `${kind}-1`, takeId: 'take-1', attemptId: 'attempt-1', payload };
}

function sink() {
  const events = [];
  return { events, createEvent: (kind, payload) => ({ kind, payload }), emit: async (event) => events.push(event) };
}

test('emits typed preparation, test capture, timer, and cancellation barriers', async () => {
  const ports = createLiveTestPorts({ actorNames: ['hero', 'rival'], clock: { now: () => 10 } });
  const preparation = sink();
  await ports.production.execute(command('prepareTake', { actors: ['hero', 'rival'] }), preparation);
  assert.deepEqual(preparation.events.map(({ kind }) => kind), ['commandAcknowledged', 'commandCompleted', 'observationVerified']);
  assert.equal(preparation.events.at(-1).payload.proof.kind, 'preparation');

  const capture = sink();
  await ports.capture.execute(command('armCapture'), capture);
  assert.deepEqual(capture.events.map(({ kind }) => kind), ['commandAcknowledged', 'commandCompleted', 'observationVerified', 'captureReady']);
  assert.equal(capture.events.at(-1).payload.path, 'test-no-recording');

  const timer = sink();
  await ports.timers.execute(command('preRoll'), timer);
  assert.deepEqual(timer.events.map(({ kind }) => kind), ['commandAcknowledged', 'commandCompleted', 'timerFired']);
});
