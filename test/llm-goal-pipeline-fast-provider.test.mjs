import assert from 'node:assert/strict';
import test from 'node:test';

import { createFastProvider } from '../src/llm-goal-pipeline/fast-provider.mjs';

test('configures a constrained 30-second fast decision provider', async () => {
  const calls = [];
  const decision = { decision: 'finish', action: null, summary: 'Goal appears complete.', plan: [] };
  const provider = createFastProvider({
    tempDirectory: '/tmp/fast-provider',
    baseProviderFactory(options) {
      calls.push(options);
      return { decide: async (context) => { calls.push(context); return decision; } };
    }
  });
  assert.deepEqual(await provider.decide({ contract: { contractId: 'contract-1' } }), decision);
  assert.equal(calls[0].timeoutMs, 30_000);
  assert.deepEqual(calls[0].decisionSchema.required, ['decision', 'action', 'summary', 'plan']);
  assert.equal(calls[0].decisionSchema.additionalProperties, false);
  assert.match(calls[0].promptPreamble, /one immediate action/i);
});

test('rejects malformed provider envelopes before the runner', async () => {
  const provider = createFastProvider({
    tempDirectory: '/tmp/fast-provider',
    baseProviderFactory: () => ({ decide: async () => ({ decision: 'finish', action: null, summary: '', plan: [], command: '/give' }) })
  });
  await assert.rejects(provider.decide({}), { code: 'PIPELINE_FAST_PROVIDER_OUTPUT_INVALID' });
});

test('removes schema-required null action parameters before deterministic validation', async () => {
  const provider = createFastProvider({
    tempDirectory: '/tmp/fast-provider',
    baseProviderFactory: () => ({ decide: async () => ({
      decision: 'act',
      action: {
        kind: 'mine_target', observationVersion: 4, targetId: 'stone-1',
        reference: null, recipe: null, count: null, item: null, text: null
      },
      summary: '', plan: []
    }) })
  });
  assert.deepEqual(await provider.decide({}), {
    decision: 'act', action: { kind: 'mine_target', observationVersion: 4, targetId: 'stone-1' }, summary: '', plan: []
  });
});
