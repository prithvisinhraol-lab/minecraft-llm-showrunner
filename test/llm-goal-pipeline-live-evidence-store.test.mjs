import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPipelineLiveEvidenceStore } from '../src/llm-goal-pipeline/live-evidence-store.mjs';

test('persists bounded controller-owned live contract and inventory evidence atomically', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pipeline-live-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let tick = 0;
  const store = createPipelineLiveEvidenceStore({
    directory, actorId: 'LlmAgent', clock: { now: () => Date.parse('2026-09-10T12:00:00.000Z') + tick++ * 1_000 }
  });
  for (let index = 0; index < 7; index += 1) {
    await store.record({
      contract: { contractId: `contract-${index}` },
      outcome: { status: 'succeeded', proofKinds: [`inventory_at_least:item_${index}`] },
      result: { facts: [{ predicate: 'inventory_at_least', item: `item_${index}`, actual: index + 1, required: 1 }] }
    });
  }
  const evidence = await store.load();
  assert.equal(evidence.source, 'mineflayer-live');
  assert.equal(evidence.simulated, false);
  assert.equal(evidence.provider, 'codex');
  assert.deepEqual(evidence.contracts.map(({ contractId }) => contractId), [
    'contract-2', 'contract-3', 'contract-4', 'contract-5', 'contract-6'
  ]);
  assert.equal(evidence.inventory.find(({ item }) => item === 'item_6').count, 7);
  assert.equal((await stat(path.join(directory, 'LlmAgent.pipeline.live-evidence.json'))).mode & 0o777, 0o600);
  assert.doesNotReject(async () => JSON.parse(await readFile(path.join(directory, 'LlmAgent.pipeline.live-evidence.json'), 'utf8')));
  await store.reset();
  assert.equal(await store.load(), null);
});

test('rejects non-succeeded or fact-free records', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pipeline-live-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createPipelineLiveEvidenceStore({ directory, actorId: 'LlmAgent' });
  await assert.rejects(store.record({
    contract: { contractId: 'contract-1' }, outcome: { status: 'failed', proofKinds: [] }, result: { facts: [] }
  }), { code: 'PIPELINE_LIVE_EVIDENCE_INVALID' });
});
