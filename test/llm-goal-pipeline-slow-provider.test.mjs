import assert from 'node:assert/strict';
import test from 'node:test';

import { createContractRequestFences } from '../src/llm-goal-pipeline/contracts.mjs';
import {
  createScriptedSlowProvider,
  createSlowContractProvider
} from '../src/llm-goal-pipeline/slow-provider.mjs';

const fences = createContractRequestFences({
  contractId: 'contract-2', missionVersion: 2, observationVersion: 10,
  predecessorContractId: 'contract-1', registryVersion: 1,
  now: '2026-09-01T14:00:00.000Z'
});

const proposal = {
  contractId: 'contract-2', missionVersion: 2,
  predecessor: { contractId: 'contract-1', status: 'succeeded', proofKinds: ['inventory_at_least:oak_log'] },
  objective: 'Craft oak planks.', rationale: 'Planks enable early tools.',
  prerequisites: { all: [{ predicate: 'actor_alive' }, { predicate: 'inventory_at_least', item: 'oak_log', count: 1 }] },
  success: { all: [{ predicate: 'inventory_at_least', item: 'oak_planks', count: 4 }] },
  constraints: [{ rule: 'do_not_attack_players' }],
  capabilities: ['observe', 'craft_recipe'],
  budget: { maximumActions: 5, maximumReplans: 1, maximumSeconds: 60, maximumSearchRadius: 8, maximumTravelRadius: 8 },
  expectedOutcome: { summary: 'Actor owns four oak planks.', proofKinds: ['inventory_at_least:oak_planks'] },
  question: null
};

const context = {
  fences,
  mission: { text: 'survive and progress toward stone tools', version: 2 },
  activeContract: { contractId: 'contract-1', expectedOutcome: { proofKinds: ['inventory_at_least:oak_log'] } },
  recentOutcomes: [],
  observation: { observationVersion: 10, inventory: [{ item: 'oak_log', count: 1 }] },
  vocabulary: { capabilities: ['observe', 'craft_recipe'], predicates: ['actor_alive', 'inventory_at_least'], constraints: ['do_not_attack_players'] },
  remainingLimits: { maximumActions: 40, maximumReplans: 5, maximumSeconds: 300, maximumSearchRadius: 64, maximumTravelRadius: 128 }
};

test('configures one isolated 90-second structured provider and validates its proposal', async () => {
  const calls = [];
  const provider = createSlowContractProvider({
    codexBin: '/codex', tempDirectory: '/tmp/slow-provider',
    baseProviderFactory(options) {
      calls.push(options);
      return { decide: async (supplied) => { calls.push(supplied); return structuredClone(proposal); } };
    }
  });

  assert.deepEqual(await provider.generate(context), proposal);
  assert.equal(calls[0].timeoutMs, 90_000);
  assert.equal(calls[0].normalizeDecision(proposal), proposal);
  assert.deepEqual(calls[0].decisionSchema.required, [
    'contractId', 'missionVersion', 'predecessor', 'objective', 'rationale',
    'prerequisites', 'success', 'constraints', 'capabilities', 'budget', 'expectedOutcome', 'question'
  ]);
  assert.equal(calls[0].decisionSchema.additionalProperties, false);
  const objectSchemas = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'object') objectSchemas.push(value);
    for (const child of Object.values(value)) visit(child);
  };
  visit(calls[0].decisionSchema);
  assert.equal(objectSchemas.length > 8, true);
  assert.equal(objectSchemas.every((schema) => schema.additionalProperties === false), true);
  assert.match(calls[0].promptPreamble, /bounded successor goal contract/i);
  assert.equal(calls[1].fences.contractId, 'contract-2');
});

test('fails closed when generated output violates its request fences', async () => {
  const provider = createSlowContractProvider({
    tempDirectory: '/tmp/slow-provider',
    baseProviderFactory: () => ({ decide: async () => ({ ...proposal, contractId: 'wrong' }) })
  });
  await assert.rejects(provider.generate(context), { code: 'PIPELINE_CONTRACT_INVALID' });
});

test('scripted slow provider deep-clones proposals and exhausts safely', async () => {
  const source = structuredClone(proposal);
  const scripted = createScriptedSlowProvider([source]);
  source.objective = 'mutated';
  const first = await scripted.generate(context);
  assert.equal(first.objective, 'Craft oak planks.');
  assert.equal(Object.isFrozen(first), true);
  await assert.rejects(scripted.generate(context), { code: 'PIPELINE_SLOW_SCRIPT_EXHAUSTED' });
});
