import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs/promises';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createInitialActorState } from '../src/llm-agent/contracts.mjs';
import { createActorStateStore } from '../src/llm-agent/state-store.mjs';

const goal = 'obtain one oak_log and place an oak_log directly above a controller-identified gold_block marker';
const now = '2026-08-24T12:00:00.000Z';

function state(actorId, runId = `run-${actorId}`) {
  return createInitialActorState({ actorId, runId, now, goal });
}

async function testDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'llm-agent-state-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('missing actor records load as null', async (t) => {
  const directory = await testDirectory(t);
  const store = createActorStateStore({ directory });

  assert.equal(await store.load('AgentOne'), null);
});

test('save and load round-trip a validated actor state', async (t) => {
  const directory = await testDirectory(t);
  const store = createActorStateStore({ directory });
  const original = state('AgentOne');

  await store.save('AgentOne', original);

  assert.deepEqual(await store.load('AgentOne'), original);
  const record = await stat(path.join(directory, 'AgentOne.json'));
  assert.equal(record.mode & 0o777, 0o600);
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith('AgentOne.json.tmp-')), []);
});

test('invalid actor IDs cannot escape the state directory', async (t) => {
  const directory = await testDirectory(t);
  const store = createActorStateStore({ directory });
  const invalidIds = ['../escape', '..', '.', 'bad/name', 'bad\\name', 'bad.id', '', 'x'.repeat(33)];

  for (const actorId of invalidIds) {
    await assert.rejects(store.save(actorId, state('AgentOne')), { code: 'LLM_AGENT_STATE_INVALID' });
    await assert.rejects(store.load(actorId), { code: 'LLM_AGENT_STATE_INVALID' });
    await assert.rejects(store.reset(actorId), { code: 'LLM_AGENT_STATE_INVALID' });
  }
  assert.deepEqual(await readdir(directory), []);
});

test('unknown schema versions fail closed when loading', async (t) => {
  const directory = await testDirectory(t);
  const store = createActorStateStore({ directory });
  const persisted = structuredClone(state('AgentOne'));
  persisted.identity.schemaVersion = 999;
  await writeFile(path.join(directory, 'AgentOne.json'), JSON.stringify(persisted), { mode: 0o600 });

  await assert.rejects(store.load('AgentOne'), { code: 'LLM_AGENT_STATE_INVALID' });
});

test('reset removes only the requested actor record', async (t) => {
  const directory = await testDirectory(t);
  const store = createActorStateStore({ directory });
  const other = state('Agent_Two');
  await store.save('AgentOne', state('AgentOne'));
  await store.save('Agent_Two', other);

  await store.reset('AgentOne');

  assert.equal(await store.load('AgentOne'), null);
  assert.deepEqual(await store.load('Agent_Two'), other);
  assert.deepEqual(await readdir(directory), ['Agent_Two.json']);
});

test('failed replacement preserves the previous valid record', async (t) => {
  const directory = await testDirectory(t);
  const initialStore = createActorStateStore({ directory });
  const previous = state('AgentOne', 'run-previous');
  const next = state('AgentOne', 'run-next');
  await initialStore.save('AgentOne', previous);

  const renameError = new Error('simulated rename failure');
  renameError.code = 'EIO';
  const failingRenameFs = { ...nodeFs, rename: async () => { throw renameError; } };
  const store = createActorStateStore({ directory, fsImpl: failingRenameFs });

  await assert.rejects(store.save('AgentOne', next), {
    code: 'LLM_AGENT_STATE_WRITE_FAILED',
    cause: renameError
  });
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'AgentOne.json'), 'utf8')), previous);
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith('AgentOne.json.tmp-')), []);
});

test('atomically grants only one live runtime lease per actor', async (t) => {
  const directory = await testDirectory(t);
  const firstStore = createActorStateStore({ directory });
  const secondStore = createActorStateStore({ directory });
  const firstLease = await firstStore.acquireLease('AgentOne', {
    ownerId: 'controller-one',
    acquiredAt: '2026-08-24T12:00:00.000Z',
    expiresAt: '2026-08-24T12:05:00.000Z'
  });

  assert.equal(Object.isFrozen(firstLease), true);
  await assert.rejects(secondStore.acquireLease('AgentOne', {
    ownerId: 'controller-two',
    acquiredAt: '2026-08-24T12:00:01.000Z',
    expiresAt: '2026-08-24T12:05:01.000Z'
  }), { code: 'LLM_AGENT_LEASE_HELD' });
  assert.equal(await secondStore.releaseLease('AgentOne', 'controller-two'), false);
  assert.equal(await firstStore.releaseLease('AgentOne', 'controller-one'), true);

  const secondLease = await secondStore.acquireLease('AgentOne', {
    ownerId: 'controller-two',
    acquiredAt: '2026-08-24T12:00:02.000Z',
    expiresAt: '2026-08-24T12:05:02.000Z'
  });
  assert.equal(secondLease.ownerId, 'controller-two');
  assert.equal(await secondStore.releaseLease('AgentOne', 'controller-two'), true);
});

test('reclaims an expired runtime lease without letting its stale owner release the replacement', async (t) => {
  const directory = await testDirectory(t);
  const beforeRestart = createActorStateStore({ directory });
  const afterRestart = createActorStateStore({ directory });
  await beforeRestart.acquireLease('AgentOne', {
    ownerId: 'old-process-controller',
    acquiredAt: '2026-08-24T12:00:00.000Z',
    expiresAt: '2026-08-24T12:00:01.000Z'
  });

  const reclaimed = await afterRestart.acquireLease('AgentOne', {
    ownerId: 'new-process-controller',
    acquiredAt: '2026-08-24T12:00:02.000Z',
    expiresAt: '2026-08-24T12:05:02.000Z'
  });

  assert.equal(reclaimed.ownerId, 'new-process-controller');
  assert.equal(await beforeRestart.releaseLease('AgentOne', 'old-process-controller'), false);
  await assert.rejects(beforeRestart.acquireLease('AgentOne', {
    ownerId: 'third-controller',
    acquiredAt: '2026-08-24T12:00:03.000Z',
    expiresAt: '2026-08-24T12:05:03.000Z'
  }), { code: 'LLM_AGENT_LEASE_HELD' });
  assert.equal(await afterRestart.releaseLease('AgentOne', 'new-process-controller'), true);
  assert.deepEqual((await readdir(directory)).filter((name) => name.includes('.stale-')), []);
});
