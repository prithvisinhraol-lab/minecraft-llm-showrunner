import assert from 'node:assert/strict';
import test from 'node:test';

import { ShowrunnerError } from '../src/showrunner/errors.mjs';
import { AttemptFence, createEnvelope, IdempotencyLedger } from '../src/showrunner/protocol.mjs';

function identity(overrides = {}) {
  return {
    productionId: 'production-a',
    takeId: 'take-a',
    sceneId: 'scene-a',
    beatId: 'beat-a',
    attemptId: 'attempt-1',
    cueId: 'cue-a',
    ...overrides
  };
}

function event(overrides = {}) {
  return {
    kind: 'cue-ready',
    ...identity(),
    eventId: 'event-1',
    causalSequence: 1,
    monotonicTimestamp: 100,
    ...overrides
  };
}

function assertEnvelopeRejected(buildEnvelope) {
  assert.throws(buildEnvelope, (error) => error instanceof ShowrunnerError);
}

test('creates an immutable envelope with an isolated payload and clock timestamp', () => {
  const payload = { line: 'Hold your mark.', nested: { part: 1 } };
  const envelope = createEnvelope('cue-ready', identity({ causalSequence: 7 }), payload, { now: () => 4242 });

  payload.nested.part = 2;
  assert.equal(envelope.kind, 'cue-ready');
  assert.equal(envelope.causalSequence, 7);
  assert.equal(envelope.monotonicTimestamp, 4242);
  assert.notEqual(envelope.eventId, undefined);
  assert.equal(envelope.payload.nested.part, 1);
  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(Object.isFrozen(envelope.payload), true);
  assert.throws(() => { envelope.cueId = 'other-cue'; }, TypeError);
  assert.throws(() => { envelope.payload.nested.part = 3; }, TypeError);
});

test('rejects missing or invalid envelope causal sequence and clock timestamps', () => {
  for (const causalSequence of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    assertEnvelopeRejected(() => createEnvelope('cue-ready', identity({ causalSequence }), {}, { now: () => 1 }));
  }
  for (const timestamp of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertEnvelopeRejected(() => createEnvelope('cue-ready', identity({ causalSequence: 1 }), {}, { now: () => timestamp }));
  }
});

test('captures the envelope identity before changing getters can alter it', () => {
  const changingIdentity = identity();
  let reads = 0;
  Object.defineProperty(changingIdentity, 'causalSequence', {
    get() {
      reads += 1;
      return reads === 1 ? 1 : 99;
    }
  });

  const envelope = createEnvelope('cue-ready', changingIdentity, {}, { now: () => 1 });
  assert.equal(envelope.causalSequence, 1);
});

test('rejects unsafe envelope kinds and unsafe JSON payload values', () => {
  const cycle = {};
  cycle.self = cycle;
  const accessor = {};
  Object.defineProperty(accessor, 'line', { enumerable: true, get: () => 'surprise' });
  const inherited = Object.create({ line: 'not-own' });
  inherited.line = 'also-not-plain';
  const unsafePayloads = [
    new Map([['line', 'hold']]),
    new Set(['hold']),
    new Date(),
    { line: () => 'hold' },
    { line: Symbol('hold') },
    { line: 1n },
    { line: undefined },
    { line: Number.NaN },
    cycle,
    accessor,
    inherited,
    new Proxy({ line: 'hold' }, {})
  ];

  for (const kind of ['', 'x'.repeat(129), new String('cue-ready'), 'bad\nkind']) {
    assertEnvelopeRejected(() => createEnvelope(kind, identity({ causalSequence: 1 }), {}, { now: () => 1 }));
  }
  for (const payload of unsafePayloads) {
    assertEnvelopeRejected(() => createEnvelope('cue-ready', identity({ causalSequence: 1 }), payload, { now: () => 1 }));
  }
});

test('rejects duplicate, stale, and out-of-order events without changing sequence', () => {
  const fence = AttemptFence.start(identity({ attemptId: 'attempt-2' }));

  assert.equal(fence.accept(event({ attemptId: 'attempt-1', causalSequence: 1 })).reason, 'STALE_ATTEMPT');
  assert.equal(fence.accept(event({ attemptId: 'attempt-2', eventId: 'e2', causalSequence: 2 })).reason, 'OUT_OF_ORDER');
  assert.equal(fence.accept(event({ attemptId: 'attempt-2', eventId: 'e1', causalSequence: 1 })).accepted, true);
  assert.equal(fence.accept(event({ attemptId: 'attempt-2', eventId: 'e1', causalSequence: 1 })).reason, 'DUPLICATE_EVENT');
  assert.equal(fence.sequence, 1);
});

test('rejects each mismatched runtime identity before advancing sequence', () => {
  const mismatches = [
    ['productionId', 'production-b', 'WRONG_PRODUCTION'],
    ['takeId', 'take-b', 'WRONG_TAKE'],
    ['sceneId', 'scene-b', 'WRONG_SCENE'],
    ['beatId', 'beat-b', 'WRONG_BEAT'],
    ['cueId', 'cue-b', 'WRONG_CUE']
  ];

  for (const [field, value, reason] of mismatches) {
    const fence = AttemptFence.start(identity());
    const decision = fence.accept(event({ [field]: value }));
    assert.equal(decision.accepted, false, field);
    assert.equal(decision.reason, reason, field);
    assert.equal(fence.sequence, 0, field);
  }
});

test('preserves monotonic timestamps in the audit log without using them for ordering', () => {
  const fence = AttemptFence.start(identity());

  assert.equal(fence.accept(event({ eventId: 'first', causalSequence: 1, monotonicTimestamp: 200 })).accepted, true);
  assert.equal(fence.accept(event({ eventId: 'second', causalSequence: 2, monotonicTimestamp: 100 })).accepted, true);
  assert.equal(fence.sequence, 2);
  assert.deepEqual(fence.events.map((entry) => entry.monotonicTimestamp), [200, 100]);
  assert.equal(Object.isFrozen(fence.events), true);
  assert.equal(Object.isFrozen(fence.events[0]), true);
});

test('audits the validated identity snapshot when an event getter changes later reads', () => {
  const changingEvent = event({ eventId: 'changing', causalSequence: 1 });
  let reads = 0;
  Object.defineProperty(changingEvent, 'causalSequence', {
    get() {
      reads += 1;
      return reads === 1 ? 1 : 99;
    }
  });
  const fence = AttemptFence.start(identity());

  const decision = fence.accept(changingEvent);
  assert.equal(decision.accepted, true);
  assert.equal(fence.sequence, 1);
  assert.equal(decision.event.causalSequence, 1);
  assert.equal(fence.events[0].causalSequence, 1);
});

test('returns immutable rejections for hostile and post-revocation input', () => {
  const fence = AttemptFence.start(identity());
  const hostile = fence.accept(null);

  assert.equal(hostile.accepted, false);
  assert.equal(hostile.reason, 'INVALID_EVENT');
  assert.equal(Object.isFrozen(hostile), true);
  assert.throws(() => { hostile.reason = 'changed'; }, TypeError);

  const invalidKind = fence.accept(event({ kind: '' }));
  assert.equal(invalidKind.accepted, false);
  assert.equal(invalidKind.reason, 'INVALID_EVENT');
  assert.equal(Object.isFrozen(invalidKind), true);

  const getterEvent = event({ eventId: 'hostile-getter' });
  Object.defineProperty(getterEvent, 'kind', { get: () => { throw new Error('nope'); } });
  const getterDecision = fence.accept(getterEvent);
  assert.equal(getterDecision.accepted, false);
  assert.equal(getterDecision.reason, 'INVALID_EVENT');
  assert.equal(Object.isFrozen(getterDecision), true);

  const proxyDecision = fence.accept(new Proxy(event({ eventId: 'hostile-proxy' }), {
    get() { throw new Error('nope'); }
  }));
  assert.equal(proxyDecision.accepted, false);
  assert.equal(proxyDecision.reason, 'INVALID_EVENT');
  assert.equal(Object.isFrozen(proxyDecision), true);

  fence.revoke('director stop');
  const revoked = fence.accept(event());
  assert.equal(revoked.accepted, false);
  assert.equal(revoked.reason, 'ATTEMPT_REVOKED');
  assert.equal(revoked.revocationReason, 'director stop');
  assert.equal(Object.isFrozen(revoked), true);
  assert.equal(fence.sequence, 0);
});

test('keeps idempotency claims scoped to their active take', () => {
  const firstTake = new IdempotencyLedger('take-a');
  const nextTake = new IdempotencyLedger('take-b');

  assert.equal(firstTake.claim('command-1'), true);
  assert.equal(firstTake.claim('command-1'), false);
  assert.equal(nextTake.claim('command-1'), true);
});
