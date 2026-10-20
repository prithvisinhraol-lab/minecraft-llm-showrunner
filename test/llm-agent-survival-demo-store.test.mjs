import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs/promises';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createInitialSurvivalDemoState } from '../src/llm-agent/survival-demo-contracts.mjs';
import { createSurvivalDemoStore } from '../src/llm-agent/survival-demo-store.mjs';

const now = '2026-08-30T18:00:00.000Z';
const state = () => createInitialSurvivalDemoState({ actorId: 'LlmAgent', runId: 'run-1', now });

async function directory(t) {
  const result = await mkdtemp(path.join(os.tmpdir(), 'survival-demo-store-'));
  t.after(() => rm(result, { recursive: true, force: true }));
  return result;
}

test('atomically round-trips validated survival demo state', async (t) => {
  const root = await directory(t);
  const store = createSurvivalDemoStore({ directory: root });
  assert.equal(await store.load(), null);
  await store.save(state());
  assert.deepEqual(await store.load(), state());
  assert.deepEqual((await readdir(root)).filter((name) => name.includes('.tmp-')), []);
});

test('rejects malformed state before replacing the valid record', async (t) => {
  const root = await directory(t);
  const store = createSurvivalDemoStore({ directory: root });
  await store.save(state());
  const malformed = structuredClone(state());
  malformed.nextMilestoneIndex = 4;
  await assert.rejects(store.save(malformed), { code: 'SURVIVAL_DEMO_STATE_INVALID' });
  assert.deepEqual(await store.load(), state());
});

test('grants only one unexpired lease and only its owner can release it', async (t) => {
  const root = await directory(t);
  let nowMs = Date.parse(now);
  const first = createSurvivalDemoStore({ directory: root, clock: { now: () => nowMs } });
  const second = createSurvivalDemoStore({ directory: root, clock: { now: () => nowMs } });
  assert.equal(await first.acquireLease('owner-one'), true);
  assert.equal(await second.acquireLease('owner-two'), false);
  assert.equal(await second.releaseLease('owner-two'), false);
  assert.equal(await first.releaseLease('owner-one'), true);
  assert.equal(await second.acquireLease('owner-two'), true);
});

test('reclaims an expired lease without allowing the stale owner to remove the replacement', async (t) => {
  const root = await directory(t);
  let nowMs = Date.parse(now);
  const oldStore = createSurvivalDemoStore({ directory: root, clock: { now: () => nowMs }, leaseDurationMs: 1_000 });
  const newStore = createSurvivalDemoStore({ directory: root, clock: { now: () => nowMs }, leaseDurationMs: 1_000 });
  assert.equal(await oldStore.acquireLease('old-owner'), true);
  nowMs += 1_001;
  assert.equal(await newStore.acquireLease('new-owner'), true);
  assert.equal(await oldStore.releaseLease('old-owner'), false);
  assert.equal(await newStore.releaseLease('new-owner'), true);
});

test('a failed atomic rename leaves the prior record authoritative', async (t) => {
  const root = await directory(t);
  const working = createSurvivalDemoStore({ directory: root });
  await working.save(state());
  const renameError = Object.assign(new Error('rename failed'), { code: 'EIO' });
  const broken = createSurvivalDemoStore({
    directory: root, fsImpl: { ...nodeFs, rename: async () => { throw renameError; } }
  });
  await assert.rejects(broken.save(state()), { code: 'SURVIVAL_DEMO_STATE_WRITE_FAILED' });
  assert.deepEqual(await working.load(), state());
  assert.deepEqual((await readdir(root)).filter((name) => name.includes('.tmp-')), []);
});
