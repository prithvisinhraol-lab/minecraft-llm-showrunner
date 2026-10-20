async function event(sink, kind, command, payload = {}) {
  const value = sink.createEvent(kind, { commandId: command.commandId, ...payload });
  await sink.emit(value);
}

async function barrier(sink, command, proof) {
  await event(sink, 'commandAcknowledged', command);
  await event(sink, 'commandCompleted', command);
  await event(sink, 'observationVerified', command, { proof: { authoritative: true, ...proof } });
}

export function createLiveTestPorts({ actorNames, clock = performance, reset = async () => ({}) }) {
  const production = Object.freeze({
    async execute(command, sink) {
      if (command.kind === 'prepareTake') {
        await barrier(sink, command, { kind: 'preparation', prepared: true, actors: [...actorNames] });
        return;
      }
      if (command.kind === 'resetBaseline') {
        const nextAttempt = await reset(command);
        await barrier(sink, command, { kind: 'reset', verified: true, nextAttempt });
        return;
      }
      throw Object.assign(new Error('LIVE_PRODUCTION_ACTION_INVALID'), { code: 'LIVE_PRODUCTION_ACTION_INVALID' });
    }
  });
  const timers = Object.freeze({
    async execute(command, sink) {
      if (command.kind === 'preRoll') {
        await event(sink, 'commandAcknowledged', command);
        await event(sink, 'commandCompleted', command);
        await event(sink, 'timerFired', command);
        return;
      }
      if (command.kind === 'cueTimeout' || command.kind === 'cleanupTimeout') {
        await event(sink, 'commandAcknowledged', command);
        await event(sink, 'commandCompleted', command);
        return;
      }
      if (command.kind === 'cancelTimer') {
        await barrier(sink, command, {
          kind: 'quiescence', quiescent: true, resourceKind: 'timer', resourceId: command.payload.timerId
        });
        return;
      }
      throw Object.assign(new Error('LIVE_TIMER_ACTION_INVALID'), { code: 'LIVE_TIMER_ACTION_INVALID' });
    }
  });
  const capture = Object.freeze({
    async execute(command, sink) {
      if (command.kind === 'armCapture') {
        await barrier(sink, command, { kind: 'captureArm', armed: true, takeId: command.takeId });
        await event(sink, 'captureReady', command, { takeId: command.takeId, path: 'test-no-recording' });
        return;
      }
      if (command.kind === 'stopCapture') {
        const now = clock.now();
        await barrier(sink, command, {
          kind: 'capture', ok: true, takeId: command.takeId, path: 'test-no-recording',
          coverage: { complete: true, startMonotonicTimestamp: now, endMonotonicTimestamp: now }
        });
        return;
      }
      if (command.kind === 'cancelCapture') {
        await barrier(sink, command, {
          kind: 'quiescence', quiescent: true, resourceKind: 'capture', resourceId: command.payload.captureCommandId
        });
        return;
      }
      throw Object.assign(new Error('LIVE_CAPTURE_ACTION_INVALID'), { code: 'LIVE_CAPTURE_ACTION_INVALID' });
    }
  });
  return Object.freeze({ production, timers, capture });
}
