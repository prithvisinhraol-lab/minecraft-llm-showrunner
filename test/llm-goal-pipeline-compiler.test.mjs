import assert from 'node:assert/strict';
import test from 'node:test';

import { compileGeneratedContract } from '../src/llm-goal-pipeline/compiler.mjs';
import { createContractRequestFences } from '../src/llm-goal-pipeline/contracts.mjs';

function fences(overrides = {}) {
  return createContractRequestFences({
    contractId: 'contract-1', missionVersion: 4, observationVersion: 9,
    predecessorContractId: 'contract-0', registryVersion: 1,
    now: '2026-08-29T15:00:00.000Z', ...overrides
  });
}

function proposal(overrides = {}) {
  return {
    contractId: 'contract-1', missionVersion: 4,
    predecessor: { contractId: 'contract-0', status: 'succeeded', proofKinds: ['inventory_at_least:oak_log'] },
    objective: 'Retain eight cobblestone.', rationale: 'Stone tools are the next survival milestone.',
    prerequisites: { all: [{ predicate: 'actor_alive' }, { predicate: 'inventory_at_least', item: 'wooden_pickaxe', count: 1 }] },
    success: { all: [{ predicate: 'inventory_at_least', item: 'cobblestone', count: 8 }] },
    constraints: [{ rule: 'stay_within_radius', blocks: 64 }, { rule: 'do_not_attack_players' }],
    capabilities: ['observe', 'navigate', 'mine_block', 'collect_item'],
    budget: { maximumActions: 30, maximumReplans: 5, maximumSeconds: 240, maximumSearchRadius: 32, maximumTravelRadius: 64 },
    expectedOutcome: { summary: 'Actor possesses eight cobblestone.', proofKinds: ['inventory_at_least:cobblestone'] },
    question: null,
    ...overrides
  };
}

function snapshot(overrides = {}) {
  return {
    observationVersion: 9,
    actor: {
      alive: true, connected: true, health: 20, hunger: 20,
      dimension: 'overworld', region: 'meadow',
      inventory: { wooden_pickaxe: 1, cobblestone: 0 }, equippedItem: 'wooden_pickaxe'
    },
    blocks: [{ block: 'stone', distance: 4 }], entities: [], targets: [], landmarks: [],
    recipes: [], timeOfDay: 'day', weather: 'clear', containers: [], blueprints: [],
    ...overrides
  };
}

const permissions = () => ({
  capabilities: ['observe', 'navigate', 'mine_block', 'collect_item', 'craft_recipe'],
  items: ['wooden_pickaxe', 'cobblestone', 'oak_log'], blocks: ['stone'],
  entities: ['zombie'], recipes: ['stone_pickaxe'], landmarks: ['camp'],
  regions: ['meadow'], blueprints: [], containers: [], protectedBlocks: ['diamond_block']
});

const remainingLimits = () => ({
  maximumActions: 40, maximumReplans: 5, maximumSeconds: 300,
  maximumSearchRadius: 64, maximumTravelRadius: 128
});

function compile(overrides = {}) {
  return compileGeneratedContract({
    proposal: proposal(overrides.proposal), fences: fences(overrides.fences),
    snapshot: snapshot(overrides.snapshot), permissions: overrides.permissions ?? permissions(),
    remainingLimits: overrides.remainingLimits ?? remainingLimits(),
    context: { outcomes: [{ proofKinds: ['inventory_at_least:oak_log'] }] }
  });
}

test('compiles a valid proposal into frozen controller-owned authority', () => {
  const compiled = compile();
  assert.deepEqual(compiled.authority.capabilities, ['collect_item', 'mine_block', 'navigate', 'observe']);
  assert.deepEqual(compiled.authority.items, ['cobblestone', 'wooden_pickaxe']);
  assert.deepEqual(compiled.prerequisiteProof.proofKinds, ['actor_alive', 'inventory_at_least:wooden_pickaxe']);
  assert.equal(compiled.compiledAt, '2026-08-29T15:00:00.000Z');
  assert.equal(Object.isFrozen(compiled), true);
  assert.equal(Object.isFrozen(compiled.authority), true);
});

test('rejects stale observation fences and unmet prerequisites', () => {
  assert.throws(() => compile({ snapshot: { observationVersion: 8 } }), { code: 'PIPELINE_FENCE_MISMATCH' });
  assert.throws(() => compile({
    snapshot: { actor: { ...snapshot().actor, alive: false } }
  }), { code: 'PIPELINE_PREREQUISITE_UNMET' });
});

test('rejects budgets above remaining limits without clamping', () => {
  assert.throws(() => compile({
    remainingLimits: { ...remainingLimits(), maximumActions: 29 }
  }), { code: 'PIPELINE_BUDGET_EXCEEDED' });
});

test('rejects unauthorized capabilities, resources, and protected blocks', () => {
  assert.throws(() => compile({
    permissions: { ...permissions(), capabilities: ['observe', 'navigate', 'collect_item'] }
  }), { code: 'PIPELINE_PERMISSION_DENIED' });
  assert.throws(() => compile({
    proposal: { success: { predicate: 'inventory_at_least', item: 'diamond', count: 1 } }
  }), { code: 'PIPELINE_PERMISSION_DENIED' });
  assert.throws(() => compile({
    proposal: {
      prerequisites: { predicate: 'block_exists', block: 'diamond_block', radius: 5 },
      success: { predicate: 'target_state', targetId: 'target-1', state: 'broken' }
    },
    snapshot: { blocks: [{ block: 'diamond_block', distance: 2 }], targets: [{ targetId: 'target-1', state: 'solid' }] },
    permissions: { ...permissions(), blocks: [...permissions().blocks, 'diamond_block'] }
  }), { code: 'PIPELINE_PROTECTED_RESOURCE' });
});

test('rejects success predicates unsupported by requested capabilities', () => {
  assert.throws(() => compile({
    proposal: {
      success: { predicate: 'recipe_available', recipe: 'stone_pickaxe' },
      capabilities: ['observe', 'navigate', 'mine_block', 'collect_item']
    }
  }), { code: 'PIPELINE_SUCCESS_UNSUPPORTED' });
});

test('rejects direct contradictions in all expressions', () => {
  assert.throws(() => compile({
    proposal: {
      prerequisites: { all: [
        { predicate: 'actor_alive' },
        { not: { predicate: 'actor_alive' } }
      ] }
    }
  }), { code: 'PIPELINE_CONTRADICTION' });
});
