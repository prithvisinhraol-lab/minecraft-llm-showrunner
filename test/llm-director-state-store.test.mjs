import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createInitialDirectorState } from '../src/llm-director/contracts.mjs';
import { createDirectorStateStore } from '../src/llm-director/state-store.mjs';

const now = '2026-08-28T20:00:00.000Z';

async function rig() {
  const directory = await mkdtemp(path.join(tmpdir(), 'llm-director-store-'));
  return { directory, store: createDirectorStateStore({ directory }) };
}

function state(actorId = 'LlmAgent') {
  return createInitialDirectorState({
    actorId, runId: 'director-run-1', now,
    overallObjective: 'advance through small verified goals'
  });
}

test('round-trips atomic private director state and resets only that actor', async () => {
  const { directory, store } = await rig();
  assert.equal(await store.load('LlmAgent'), null);
  await store.save('LlmAgent', state());
  assert.deepEqual(await store.load('LlmAgent'), state());
  assert.equal((await stat(path.join(directory, 'LlmAgent.json'))).mode & 0o777, 0o600);
  await store.reset('LlmAgent');
  assert.equal(await store.load('LlmAgent'), null);
});

test('rejects traversal, malformed JSON, and mismatched actor identity', async () => {
  const { directory, store } = await rig();
  await assert.rejects(store.load('../escape'), { code: 'LLM_DIRECTOR_STATE_INVALID' });
  await writeFile(path.join(directory, 'LlmAgent.json'), '{bad', 'utf8');
  await assert.rejects(store.load('LlmAgent'), { code: 'LLM_DIRECTOR_STATE_INVALID' });
  await store.save('OtherAgent', state('OtherAgent'));
  await writeFile(path.join(directory, 'LlmAgent.json'), await readFile(path.join(directory, 'OtherAgent.json')));
  await assert.rejects(store.load('LlmAgent'), { code: 'LLM_DIRECTOR_STATE_INVALID' });
});

test('grants one lease, rejects overlap, and protects replacement from stale owner', async () => {
  const { store } = await rig();
  const first = {
    ownerId: 'owner-1', acquiredAt: now, expiresAt: '2026-08-28T20:06:45.000Z'
  };
  await store.acquireLease('LlmAgent', first);
  await assert.rejects(store.acquireLease('LlmAgent', {
    ownerId: 'owner-2', acquiredAt: '2026-08-28T20:00:01.000Z', expiresAt: '2026-08-28T20:06:46.000Z'
  }), { code: 'LLM_DIRECTOR_LEASE_HELD' });
  assert.equal(await store.releaseLease('LlmAgent', 'wrong-owner'), false);
  assert.equal(await store.releaseLease('LlmAgent', first.ownerId), true);

  await store.acquireLease('LlmAgent', {
    ownerId: 'expired', acquiredAt: '2026-08-28T19:50:00.000Z', expiresAt: '2026-08-28T19:56:45.000Z'
  });
  await store.acquireLease('LlmAgent', {
    ownerId: 'replacement', acquiredAt: now, expiresAt: '2026-08-28T20:06:45.000Z'
  });
  assert.equal(await store.releaseLease('LlmAgent', 'expired'), false);
  assert.equal(await store.releaseLease('LlmAgent', 'replacement'), true);
});

test('rejects leases longer than the 405 second director ceiling', async () => {
  const { store } = await rig();
  await assert.rejects(store.acquireLease('LlmAgent', {
    ownerId: 'owner', acquiredAt: now, expiresAt: '2026-08-28T20:06:45.001Z'
  }), { code: 'LLM_DIRECTOR_LEASE_INVALID' });
});
