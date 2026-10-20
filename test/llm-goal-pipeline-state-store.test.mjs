import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs/promises';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createInitialPipelineState } from '../src/llm-goal-pipeline/state.mjs';
import { createPipelineStateStore } from '../src/llm-goal-pipeline/state-store.mjs';

const now = '2026-09-01T12:00:00.000Z';

async function rig(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'llm-pipeline-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: createPipelineStateStore({ directory, ...options }) };
}

function state(actorId = 'LlmAgent') {
  return createInitialPipelineState({ actorId, mission: 'survive and progress', now });
}

test('round-trips private atomic state and resets only the actor', async (t) => {
  const { directory, store } = await rig(t);
  assert.equal(await store.load('LlmAgent'), null);
  await store.save('LlmAgent', state());
  assert.deepEqual(await store.load('LlmAgent'), state());
  assert.equal((await stat(path.join(directory, 'LlmAgent.pipeline.json'))).mode & 0o777, 0o600);
  await store.reset('LlmAgent');
  assert.equal(await store.load('LlmAgent'), null);
});

test('loads legacy schema-version-one state without an audit history', async (t) => {
  const { directory, store } = await rig(t);
  const legacy = structuredClone(state());
  delete legacy.audit;
  await writeFile(path.join(directory, 'LlmAgent.pipeline.json'), `${JSON.stringify(legacy)}\n`, 'utf8');
  const loaded = await store.load('LlmAgent');
  assert.deepEqual(loaded.audit, []);
});

test('rejects traversal, malformed JSON, and mismatched identity', async (t) => {
  const { directory, store } = await rig(t);
  await assert.rejects(store.load('../escape'), { code: 'PIPELINE_STATE_INVALID' });
  await writeFile(path.join(directory, 'LlmAgent.pipeline.json'), '{bad', 'utf8');
  await assert.rejects(store.load('LlmAgent'), { code: 'PIPELINE_STATE_INVALID' });
  await store.save('OtherAgent', state('OtherAgent'));
  await writeFile(
    path.join(directory, 'LlmAgent.pipeline.json'),
    await readFile(path.join(directory, 'OtherAgent.pipeline.json'))
  );
  await assert.rejects(store.load('LlmAgent'), { code: 'PIPELINE_STATE_INVALID' });
});

test('does not allow persisted mission versions or counters to move backward', async (t) => {
  const { store } = await rig(t);
  const advanced = structuredClone(state());
  advanced.mission.version = 2;
  advanced.counters.slowCalls = 3;
  await store.save('LlmAgent', advanced);
  await assert.rejects(store.save('LlmAgent', state()), { code: 'PIPELINE_STATE_REGRESSION' });
});

test('grants one 15-minute lease and protects its replacement from stale release', async (t) => {
  const { store } = await rig(t);
  await store.acquireLease('LlmAgent', {
    ownerId: 'owner-1', acquiredAt: now, expiresAt: '2026-09-01T12:15:00.000Z'
  });
  await assert.rejects(store.acquireLease('LlmAgent', {
    ownerId: 'owner-2', acquiredAt: '2026-09-01T12:00:01.000Z', expiresAt: '2026-09-01T12:15:01.000Z'
  }), { code: 'PIPELINE_LEASE_HELD' });
  assert.equal(await store.releaseLease('LlmAgent', 'owner-2'), false);
  assert.equal(await store.releaseLease('LlmAgent', 'owner-1'), true);

  await store.acquireLease('LlmAgent', {
    ownerId: 'expired', acquiredAt: '2026-09-01T11:30:00.000Z', expiresAt: '2026-09-01T11:45:00.000Z'
  });
  await store.acquireLease('LlmAgent', {
    ownerId: 'replacement', acquiredAt: now, expiresAt: '2026-09-01T12:15:00.000Z'
  });
  assert.equal(await store.releaseLease('LlmAgent', 'expired'), false);
  assert.equal(await store.releaseLease('LlmAgent', 'replacement'), true);
});

test('rejects a lease over 15 minutes and preserves prior state on rename failure', async (t) => {
  const { directory, store } = await rig(t);
  await assert.rejects(store.acquireLease('LlmAgent', {
    ownerId: 'owner', acquiredAt: now, expiresAt: '2026-09-01T12:15:00.001Z'
  }), { code: 'PIPELINE_LEASE_INVALID' });
  await store.save('LlmAgent', state());
  const replacement = structuredClone(state());
  replacement.counters.slowCalls = 1;
  const failing = createPipelineStateStore({
    directory,
    fsImpl: { ...nodeFs, async rename() { throw new Error('rename failed'); } }
  });
  await assert.rejects(failing.save('LlmAgent', replacement), { code: 'PIPELINE_STATE_WRITE_FAILED' });
  assert.deepEqual(await store.load('LlmAgent'), state());
});
