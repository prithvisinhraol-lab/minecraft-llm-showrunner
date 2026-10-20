import assert from 'node:assert/strict';
import test from 'node:test';

import { resetToBaseline } from '../src/showrunner/baseline.mjs';

function rig(options = {}) {
  const calls = [];
  let nextCalls = 0;
  const attempt = {
    id: 'attempt-1',
    revoke(reason) { calls.push(`revoke:${reason}`); if (options.revokeError) throw options.revokeError; },
    next() { calls.push('new_attempt'); nextCalls += 1; return options.nextAttempt ?? { id: 'attempt-2' }; }
  };
  const actors = ['hero', 'rival'].map((name) => ({
    name,
    async cancel(attemptId) { calls.push(`cancel:${name}:${attemptId}`); if (options.cancelActor === name) throw new Error('cancel failed'); },
    async awaitQuiescence() {
      calls.push(`quiesce:${name}`);
      if (options.pendingQuiescence === name) return new Promise(() => {});
      if (options.quiescenceError === name) throw new Error('not quiescent');
      return { acknowledged: true, quiescent: true };
    }
  }));
  const verification = options.verification ?? { ok: true, mismatches: [] };
  const controller = {
    async restore(value) { calls.push('restore'); if (options.pendingOperation === 'restore') return new Promise(() => {}); if (options.restoreError) throw options.restoreError; assert.equal(value, manifest); },
    async removeTaggedEntities(tag) { calls.push('cleanup'); if (options.pendingOperation === 'cleanup') return new Promise(() => {}); if (options.cleanupError) throw options.cleanupError; assert.equal(tag, 'showrunner_production'); },
    async verify(value) { calls.push('verify'); if (options.pendingOperation === 'verify') return new Promise(() => {}); if (options.verifyError) throw options.verifyError; assert.equal(value, manifest); return verification; }
  };
  let timerCalls = 0;
  const clock = options.clock ?? {
    setTimeout(callback) {
      timerCalls += 1;
      if ((options.pendingQuiescence && timerCalls === 2) || (options.pendingOperation && timerCalls > 2)) queueMicrotask(callback);
      return timerCalls;
    },
    clearTimeout() {}
  };
  const manifest = {
    resetTimeoutMs: 25,
    entityCleanupTag: 'showrunner_production',
    actorBaselines: { hero: {}, rival: {} }
  };
  return { input: { attempt, manifest, actors, controller, clock }, calls, get nextCalls() { return nextCalls; } };
}

test('revokes, cancels, awaits quiescence, restores, cleans, verifies, then opens a new epoch', async () => {
  const value = rig();
  const report = await resetToBaseline(value.input);
  assert.deepEqual(value.calls, [
    'revoke:retry', 'cancel:hero:attempt-1', 'cancel:rival:attempt-1',
    'quiesce:hero', 'quiesce:rival', 'restore', 'cleanup', 'verify', 'new_attempt'
  ]);
  assert.equal(report.verified, true);
  assert.deepEqual(report.nextAttempt, { id: 'attempt-2' });
  assert.deepEqual(report.verification, { ok: true, mismatches: [] });
});

test('times out actor quiescence without sleeping and never creates a new epoch', async () => {
  const value = rig({ pendingQuiescence: 'hero' });
  await assert.rejects(resetToBaseline(value.input), { code: 'QUIESCENCE_TIMEOUT' });
  assert.equal(value.nextCalls, 0);
  assert.equal(value.calls.includes('restore'), false);
});

test('rejects a reset adapter that reuses the revoked attempt epoch', async () => {
  const value = rig({ nextAttempt: { id: 'attempt-1' } });
  await assert.rejects(resetToBaseline(value.input), { code: 'RESET_EPOCH_REUSED' });
});

test('does not restore or create a new epoch after revoke, cancel, or quiescence failure', async (t) => {
  for (const [name, options] of [
    ['revoke', { revokeError: new Error('revoke failed') }],
    ['cancel', { cancelActor: 'rival' }],
    ['quiescence', { quiescenceError: 'hero' }]
  ]) {
    await t.test(name, async () => {
      const value = rig(options);
      await assert.rejects(resetToBaseline(value.input));
      assert.equal(value.calls.includes('restore'), false);
      assert.equal(value.nextCalls, 0);
    });
  }
});

test('never creates a new epoch after restoration, cleanup, telemetry, or manifest mismatch failure', async (t) => {
  for (const [name, options, code] of [
    ['unsafe headroom', { restoreError: Object.assign(new Error('unsafe'), { code: 'UNSAFE_HEADROOM' }) }, 'UNSAFE_HEADROOM'],
    ['cleanup', { cleanupError: new Error('cleanup failed') }, undefined],
    ['telemetry', { verifyError: Object.assign(new Error('missing telemetry'), { code: 'VERIFICATION_TELEMETRY_REQUIRED' }) }, 'VERIFICATION_TELEMETRY_REQUIRED'],
    ['block mismatch', { verification: { ok: false, mismatches: [{ kind: 'block_assertion' }] } }, 'BASELINE_VERIFICATION_FAILED'],
    ['checksum mismatch', { verification: { ok: false, mismatches: [{ kind: 'checksum_sample' }] } }, 'BASELINE_VERIFICATION_FAILED'],
    ['entity mismatch', { verification: { ok: false, mismatches: [{ kind: 'tagged_entities' }] } }, 'BASELINE_VERIFICATION_FAILED'],
    ['actor state mismatch', { verification: { ok: false, mismatches: [{ kind: 'actor_inventory' }, { kind: 'actor_health' }, { kind: 'actor_effects' }] } }, 'BASELINE_VERIFICATION_FAILED']
  ]) {
    await t.test(name, async () => {
      const value = rig(options);
      if (code) await assert.rejects(resetToBaseline(value.input), { code });
      else await assert.rejects(resetToBaseline(value.input));
      assert.equal(value.nextCalls, 0);
    });
  }
});

test('bounds restore, cleanup, and verification before creating the next epoch', async (t) => {
  for (const [operation, code] of [
    ['restore', 'RESET_RESTORE_TIMEOUT'],
    ['cleanup', 'RESET_CLEANUP_TIMEOUT'],
    ['verify', 'RESET_VERIFICATION_TIMEOUT']
  ]) {
    await t.test(operation, async () => {
      const value = rig({ pendingOperation: operation });
      const outcome = await Promise.race([
        resetToBaseline(value.input).then(() => ({ code: 'UNEXPECTED_SUCCESS' }), (error) => error),
        new Promise((resolve) => setImmediate(() => resolve({ code: 'UNBOUNDED_OPERATION' })))
      ]);
      assert.equal(outcome.code, code);
      assert.equal(value.nextCalls, 0);
    });
  }
});

test('rejects invalid reset dependencies and timeout bounds before revoking', async () => {
  const value = rig();
  value.input.manifest.resetTimeoutMs = 0;
  await assert.rejects(resetToBaseline(value.input), { code: 'INVALID_RESET_TIMEOUT' });
  assert.deepEqual(value.calls, []);
});

test('requires exactly the two distinct runtime actors named by the manifest before revoking', async (t) => {
  const extraActor = (name) => ({
    name,
    async cancel() { throw new Error('must not cancel'); },
    async awaitQuiescence() { throw new Error('must not quiesce'); }
  });
  for (const [name, mutate] of [
    ['missing actor', (input) => { input.actors = input.actors.slice(0, 1); }],
    ['duplicate actor', (input) => { input.actors = [input.actors[0], { ...input.actors[0] }]; }],
    ['extra actor', (input) => { input.actors.push(extraActor('extra')); }],
    ['mismatched actor', (input) => { input.actors[1] = extraActor('outsider'); }],
    ['manifest names other than exactly two', (input) => { input.manifest.actorBaselines.extra = {}; input.actors.push(extraActor('extra')); }]
  ]) {
    await t.test(name, async () => {
      const value = rig();
      mutate(value.input);
      await assert.rejects(resetToBaseline(value.input), { code: 'RESET_ACTOR_MISMATCH' });
      assert.deepEqual(value.calls, []);
      assert.equal(value.nextCalls, 0);
    });
  }
});
