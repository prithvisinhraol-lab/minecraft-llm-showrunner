import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateExpression } from '../src/llm-goal-pipeline/predicates.mjs';

function snapshot(overrides = {}) {
  return {
    observationVersion: 9,
    actor: {
      alive: true, connected: true, health: 18, hunger: 16,
      dimension: 'overworld', region: 'meadow',
      inventory: { cobblestone: 8, wooden_pickaxe: 1 },
      equippedItem: 'wooden_pickaxe'
    },
    blocks: [{ block: 'stone', distance: 4 }],
    entities: [{ entity: 'zombie', distance: 7, hostile: true }],
    targets: [{ targetId: 'target-1', state: 'stone' }],
    landmarks: [{ reference: 'camp', visible: true, reached: false }],
    recipes: ['stone_pickaxe'],
    timeOfDay: 'day', weather: 'clear',
    containers: [{ containerId: 'chest-1', items: { oak_log: 3 } }],
    blueprints: [{ blueprintId: 'hut-1', complete: false }],
    ...overrides
  };
}

test('evaluates inventory success into controller-owned facts and proof kinds', () => {
  const result = evaluateExpression(
    { all: [{ predicate: 'inventory_at_least', item: 'cobblestone', count: 8 }] },
    snapshot(),
    { outcomes: [] }
  );

  assert.deepEqual(result, {
    ok: true,
    facts: [{ predicate: 'inventory_at_least', item: 'cobblestone', actual: 8, required: 8 }],
    proofKinds: ['inventory_at_least:cobblestone']
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.facts), true);
});

test('combines all, any, and not without treating failed alternatives as proof', () => {
  const expression = {
    all: [
      { predicate: 'actor_alive' },
      { any: [
        { predicate: 'inventory_at_least', item: 'diamond', count: 1 },
        { predicate: 'recipe_available', recipe: 'stone_pickaxe' }
      ] },
      { not: { predicate: 'hostile_threat', exists: false } }
    ]
  };

  const result = evaluateExpression(expression, snapshot(), { outcomes: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.proofKinds, [
    'actor_alive', 'recipe_available:stone_pickaxe', 'not:hostile_threat:false'
  ]);
  assert.equal(result.facts.some((fact) => fact.item === 'diamond'), false);
});

test('evaluates world, target, landmark, container, blueprint, and outcome predicates', () => {
  const expression = { all: [
    { predicate: 'actor_connected' },
    { predicate: 'health_at_least', value: 10 },
    { predicate: 'hunger_at_least', value: 10 },
    { predicate: 'in_dimension', dimension: 'overworld' },
    { predicate: 'in_region', region: 'meadow' },
    { predicate: 'equipped_item', item: 'wooden_pickaxe' },
    { predicate: 'block_exists', block: 'stone', radius: 5 },
    { predicate: 'entity_exists', entity: 'zombie', radius: 8 },
    { predicate: 'target_state', targetId: 'target-1', state: 'stone' },
    { predicate: 'landmark_visible', reference: 'camp' },
    { predicate: 'landmark_reached', reference: 'camp' },
    { predicate: 'time_of_day', category: 'day' },
    { predicate: 'weather', category: 'clear' },
    { predicate: 'hostile_threat', exists: true },
    { predicate: 'container_contains', containerId: 'chest-1', item: 'oak_log', count: 3 },
    { predicate: 'blueprint_complete', blueprintId: 'hut-1' },
    { predicate: 'outcome_proof', proofKind: 'inventory_at_least:oak_log' }
  ] };
  const changed = snapshot({
    landmarks: [{ reference: 'camp', visible: true, reached: true }],
    blueprints: [{ blueprintId: 'hut-1', complete: true }]
  });
  const result = evaluateExpression(expression, changed, {
    outcomes: [{ proofKinds: ['inventory_at_least:oak_log'] }]
  });

  assert.equal(result.ok, true);
  assert.equal(result.facts.length, 17);
  assert.equal(result.proofKinds.includes('blueprint_complete:hut-1'), true);
  assert.equal(result.proofKinds.includes('outcome_proof:inventory_at_least:oak_log'), true);
});

test('fails closed for malformed trusted snapshots rather than inventing evidence', () => {
  assert.throws(() => evaluateExpression(
    { predicate: 'inventory_at_least', item: 'cobblestone', count: 8 },
    { actor: { inventory: { cobblestone: Number.NaN } } },
    { outcomes: [] }
  ), { code: 'PIPELINE_OBSERVATION_INVALID' });
  assert.throws(() => evaluateExpression(
    { predicate: 'invented_fact' }, snapshot(), { outcomes: [] }
  ), { code: 'PIPELINE_PREDICATE_INVALID' });
});
