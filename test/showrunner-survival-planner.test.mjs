import assert from 'node:assert/strict';
import test from 'node:test';

import { planSurvivalStep } from '../src/showrunner/survival-planner.mjs';

const mark = 'crafting_table';

function goal(kind, overrides = {}) {
  const defaults = {
    id: `${kind}-goal`, actor: 'hero', kind, count: 1, timeoutMs: 30_000, maxReplans: 2,
    completion: { kind: 'actor_inventory_at_least', actor: 'hero', item: 'oak_log', count: 1 }
  };
  const byKind = {
    gather: { region: 'hero_tree', item: 'oak_log' },
    craft: { recipe: 'oak_planks', mark },
    place: { block: 'crafting_table', mark, completion: { kind: 'placed_at_mark', block: 'crafting_table', mark } },
    equip: { item: 'wooden_pickaxe', destination: 'hand', completion: { kind: 'equipped_item', actor: 'hero', item: 'wooden_pickaxe', destination: 'hand' } },
    excavate: { region: 'mine', block: 'stone', item: 'cobblestone', completion: { kind: 'actor_inventory_at_least', actor: 'hero', item: 'cobblestone', count: 1 } },
    regroup: { mark, completion: { kind: 'at_mark', actor: 'hero', mark } }
  };
  return { ...defaults, ...byKind[kind], ...overrides };
}

function observation(overrides = {}) {
  return {
    version: 7,
    replanCount: 0,
    actors: { hero: { inventory: {}, atMark: null, equipped: {} } },
    targets: [],
    drops: [],
    placedAtMarks: {},
    ...overrides
  };
}

function observedTarget(id, region, block, overrides = {}) {
  return {
    id, region, block, pathCost: 1, distance: 1,
    x: 1, y: 64, z: 1, dimension: 'minecraft:overworld',
    ...overrides
  };
}

function action(name, payload, reason, observationVersion = 7) {
  return { status: 'action', action: { name, payload }, reason, observationVersion };
}

test('plans bounded gathering, collection, regrouping, placement, equipment, and excavation actions', async (t) => {
  const cases = [
    {
      name: 'gathering approaches the first available target',
      input: { goal: goal('gather'), observation: observation({ targets: [observedTarget('log-b', 'hero_tree', 'oak_log'), observedTarget('log-a', 'hero_tree', 'oak_log')] }), reservations: [] },
      want: action('moveNearTarget', { actor: 'hero', goalId: 'gather-goal', targetId: 'log-a', region: 'hero_tree', block: 'oak_log' }, 'MOVE_TO_GATHER_TARGET')
    },
    {
      name: 'drop collection precedes another target action',
      input: { goal: goal('gather'), observation: observation({ drops: [{ id: 'drop-b', item: 'oak_log', region: 'hero_tree' }, { id: 'drop-a', item: 'oak_log', region: 'hero_tree' }] }), reservations: [] },
      want: action('collectItem', { actor: 'hero', goalId: 'gather-goal', dropId: 'drop-a', item: 'oak_log', region: 'hero_tree' }, 'COLLECT_GATHERED_DROP')
    },
    {
      name: 'regrouping moves to the authored mark',
      input: { goal: goal('regroup'), observation: observation(), reservations: [] },
      want: action('moveNearTarget', { actor: 'hero', goalId: 'regroup-goal', mark }, 'MOVE_TO_REGROUP_MARK')
    },
    {
      name: 'table placement uses the authored mark',
      input: { goal: goal('place'), observation: observation({ actors: { hero: { inventory: { crafting_table: 1 }, atMark: mark, equipped: {} } } }), reservations: [] },
      want: action('placeAtMark', { actor: 'hero', goalId: 'place-goal', item: 'crafting_table', mark }, 'PLACE_REQUIRED_BLOCK')
    },
    {
      name: 'equipping uses the declared destination',
      input: { goal: goal('equip'), observation: observation({ actors: { hero: { inventory: { wooden_pickaxe: 1 }, atMark: null, equipped: {} } } }), reservations: [] },
      want: action('equipItem', { actor: 'hero', goalId: 'equip-goal', item: 'wooden_pickaxe', destination: 'hand' }, 'EQUIP_REQUIRED_ITEM')
    },
    {
      name: 'excavation approaches an approved stone target',
      input: { goal: goal('excavate'), observation: observation({ targets: [observedTarget('stone-1', 'mine', 'stone')] }), reservations: [] },
      want: action('moveNearTarget', { actor: 'hero', goalId: 'excavate-goal', targetId: 'stone-1', region: 'mine', block: 'stone' }, 'MOVE_TO_EXCAVATION_TARGET')
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      assert.deepEqual(planSurvivalStep(scenario.input), scenario.want);
    });
  }
});

test('accepts finite live-world decimal positions and path metrics', () => {
  const decision = planSurvivalStep({
    goal: goal('gather'),
    observation: observation({
      position: { x: 48.5, y: 65, z: 48.5 },
      targets: [observedTarget('live-log', 'hero_tree', 'oak_log', {
        pathCost: Math.sqrt(3), distance: Math.sqrt(3)
      })]
    }),
    reservations: []
  });

  assert.equal(decision.status, 'action');
  assert.equal(decision.action.payload.targetId, 'live-log');
});

test('actor-scoped excavation completion cannot be satisfied by the other actor inventory', () => {
  const decision = planSurvivalStep({
    goal: goal('excavate'),
    observation: observation({
      actors: {
        hero: { inventory: {}, atMark: null, equipped: { hand: 'wooden_pickaxe' } },
        rival: { inventory: { cobblestone: 10 }, atMark: null, equipped: { hand: 'wooden_pickaxe' } }
      },
      targets: [observedTarget('stone-1', 'mine', 'stone')]
    }),
    reservations: []
  });

  assert.equal(decision.status, 'action');
  assert.equal(decision.action.payload.actor, 'hero');
});

test('plans fixed crafting dependencies in order', async (t) => {
  const cases = [
    {
      name: 'planks consume available logs',
      input: { goal: goal('craft', { recipe: 'oak_planks', count: 4, completion: { kind: 'actor_inventory_at_least', actor: 'hero', item: 'oak_planks', count: 4 } }), observation: observation({ actors: { hero: { inventory: { oak_log: 1 }, atMark: null, equipped: {} } } }), reservations: [] },
      want: action('craftRecipe', { actor: 'hero', goalId: 'craft-goal', recipe: 'oak_planks', count: 1, mark }, 'CRAFT_OAK_PLANKS')
    },
    {
      name: 'sticks require planks',
      input: { goal: goal('craft', { recipe: 'stick', count: 4, completion: { kind: 'actor_inventory_at_least', actor: 'hero', item: 'stick', count: 4 } }), observation: observation({ actors: { hero: { inventory: { oak_planks: 2 }, atMark: null, equipped: {} } } }), reservations: [] },
      want: action('craftRecipe', { actor: 'hero', goalId: 'craft-goal', recipe: 'stick', count: 1, mark }, 'CRAFT_STICKS')
    },
    {
      name: 'sticks first make planks from available logs',
      input: { goal: goal('craft', { recipe: 'stick', count: 4, completion: { kind: 'actor_inventory_at_least', actor: 'hero', item: 'stick', count: 4 } }), observation: observation({ actors: { hero: { inventory: { oak_log: 1 }, atMark: null, equipped: {} } } }), reservations: [] },
      want: action('craftRecipe', { actor: 'hero', goalId: 'craft-goal', recipe: 'oak_planks', count: 1, mark }, 'CRAFT_OAK_PLANKS_FOR_STICKS')
    },
    {
      name: 'tables require four planks',
      input: { goal: goal('craft', { recipe: 'crafting_table', completion: { kind: 'actor_inventory_at_least', actor: 'hero', item: 'crafting_table', count: 1 } }), observation: observation({ actors: { hero: { inventory: { oak_planks: 4 }, atMark: null, equipped: {} } } }), reservations: [] },
      want: action('craftRecipe', { actor: 'hero', goalId: 'craft-goal', recipe: 'crafting_table', count: 1, mark }, 'CRAFT_CRAFTING_TABLE')
    },
    {
      name: 'tables first make planks from available logs',
      input: { goal: goal('craft', { recipe: 'crafting_table', completion: { kind: 'actor_inventory_at_least', actor: 'hero', item: 'crafting_table', count: 1 } }), observation: observation({ actors: { hero: { inventory: { oak_log: 1 }, atMark: null, equipped: {} } } }), reservations: [] },
      want: action('craftRecipe', { actor: 'hero', goalId: 'craft-goal', recipe: 'oak_planks', count: 1, mark }, 'CRAFT_OAK_PLANKS_FOR_TABLE')
    },
    {
      name: 'pickaxes first make planks from logs',
      input: { goal: goal('craft', { recipe: 'wooden_pickaxe', count: 2, completion: { kind: 'actor_inventory_at_least', actor: 'hero', item: 'wooden_pickaxe', count: 2 } }), observation: observation({ actors: { hero: { inventory: { oak_log: 3 }, atMark: mark, equipped: {} } } }), reservations: [] },
      want: action('craftRecipe', { actor: 'hero', goalId: 'craft-goal', recipe: 'oak_planks', count: 3, mark }, 'CRAFT_OAK_PLANKS_FOR_PICKAXE')
    },
    {
      name: 'pickaxes then make sticks',
      input: { goal: goal('craft', { recipe: 'wooden_pickaxe', count: 2, completion: { kind: 'actor_inventory_at_least', actor: 'hero', item: 'wooden_pickaxe', count: 2 } }), observation: observation({ actors: { hero: { inventory: { oak_planks: 12 }, atMark: mark, equipped: {} } } }), reservations: [] },
      want: action('craftRecipe', { actor: 'hero', goalId: 'craft-goal', recipe: 'stick', count: 1, mark }, 'CRAFT_STICKS_FOR_PICKAXE')
    },
    {
      name: 'pickaxes then make the table',
      input: { goal: goal('craft', { recipe: 'wooden_pickaxe', count: 2, completion: { kind: 'actor_inventory_at_least', actor: 'hero', item: 'wooden_pickaxe', count: 2 } }), observation: observation({ actors: { hero: { inventory: { oak_planks: 10, stick: 4 }, atMark: mark, equipped: {} } } }), reservations: [] },
      want: action('craftRecipe', { actor: 'hero', goalId: 'craft-goal', recipe: 'crafting_table', count: 1, mark }, 'CRAFT_TABLE_FOR_PICKAXE')
    },
    {
      name: 'pickaxes place their required table before crafting',
      input: { goal: goal('craft', { recipe: 'wooden_pickaxe', count: 2, completion: { kind: 'actor_inventory_at_least', actor: 'hero', item: 'wooden_pickaxe', count: 2 } }), observation: observation({ actors: { hero: { inventory: { oak_planks: 6, stick: 4, crafting_table: 1 }, atMark: mark, equipped: {} } } }), reservations: [] },
      want: action('placeAtMark', { actor: 'hero', goalId: 'craft-goal', item: 'crafting_table', mark }, 'PLACE_TABLE_FOR_PICKAXE')
    },
    {
      name: 'pickaxes craft only after all dependencies exist',
      input: { goal: goal('craft', { recipe: 'wooden_pickaxe', count: 2, completion: { kind: 'actor_inventory_at_least', actor: 'hero', item: 'wooden_pickaxe', count: 2 } }), observation: observation({ actors: { hero: { inventory: { oak_planks: 6, stick: 4 }, atMark: mark, equipped: {} } }, placedAtMarks: { [mark]: 'crafting_table' } }), reservations: [] },
      want: action('craftRecipe', { actor: 'hero', goalId: 'craft-goal', recipe: 'wooden_pickaxe', count: 2, mark }, 'CRAFT_WOODEN_PICKAXE')
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      assert.deepEqual(planSurvivalStep(scenario.input), scenario.want);
    });
  }
});

test('returns terminal decisions for exact completion and bounded blockers', async (t) => {
  const cases = [
    {
      name: 'exact completion is terminal',
      input: { goal: goal('gather'), observation: observation({ actors: { hero: { inventory: { oak_log: 1 }, atMark: null, equipped: {} } } }), reservations: [] },
      want: { status: 'completed', reason: 'GOAL_SATISFIED', observationVersion: 7 }
    },
    {
      name: 'missing recipe materials are terminal',
      input: { goal: goal('craft', { recipe: 'oak_planks', completion: { kind: 'actor_inventory_at_least', actor: 'hero', item: 'oak_planks', count: 1 } }), observation: observation(), reservations: [] },
      want: { status: 'blocked', reason: 'MISSING_OAK_LOG', observationVersion: 7 }
    },
    {
      name: 'stale observations are terminal',
      input: { goal: goal('gather'), observation: observation({ stale: true }), reservations: [] },
      want: { status: 'blocked', reason: 'STALE_OBSERVATION', observationVersion: 7 }
    },
    {
      name: 'exhausted replans are terminal',
      input: { goal: goal('gather', { maxReplans: 2 }), observation: observation({ replanCount: 2 }), reservations: [] },
      want: { status: 'blocked', reason: 'REPLAN_BUDGET_EXHAUSTED', observationVersion: 7 }
    },
    {
      name: 'other actors reservations fence a shared target',
      input: { goal: goal('gather'), observation: observation({ targets: [observedTarget('log-a', 'hero_tree', 'oak_log', { reservationKey: 'target:log-a' })] }), reservations: [{ actorId: 'rival', reservationKey: 'target:log-a' }] },
      want: { status: 'blocked', reason: 'NO_TARGET_AVAILABLE', observationVersion: 7 }
    },
    {
      name: 'authority reservation keys fence a resolved target',
      input: { goal: goal('gather'), observation: observation({ targets: [observedTarget('log-a', 'hero_tree', 'oak_log', { reservationKey: 'target:minecraft:overworld:1:64:1' })] }), reservations: [{ actorId: 'rival', reservationKey: 'target:minecraft:overworld:1:64:1' }] },
      want: { status: 'blocked', reason: 'NO_TARGET_AVAILABLE', observationVersion: 7 }
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const decision = planSurvivalStep(scenario.input);
      assert.deepEqual(decision, scenario.want);
      assert.equal(Object.isFrozen(decision), true);
      if (decision.status === 'action') {
        assert.equal(Object.isFrozen(decision.action), true);
        assert.equal(Object.isFrozen(decision.action.payload), true);
      }
    });
  }
});

test('rejects a stale observation even when its copied inventory claims completion', () => {
  const decision = planSurvivalStep({
    goal: goal('gather'),
    observation: observation({
      stale: true,
      actors: { hero: { inventory: { oak_log: 64 }, atMark: null, equipped: {} } }
    }),
    reservations: []
  });
  assert.deepEqual(decision, { status: 'blocked', reason: 'STALE_OBSERVATION', observationVersion: 7 });
});

test('ranks all eligible targets by path cost, distance, then coordinates rather than target id', () => {
  const candidates = [
    { id: 'a-expensive', region: 'hero_tree', block: 'oak_log', pathCost: 8, distance: 1, x: 1, y: 64, z: 1, dimension: 'minecraft:overworld' },
    { id: 'z-nearest', region: 'hero_tree', block: 'oak_log', pathCost: 2, distance: 3, x: 8, y: 64, z: 1, dimension: 'minecraft:overworld' },
    { id: 'y-coordinate-winner', region: 'hero_tree', block: 'oak_log', pathCost: 2, distance: 3, x: 2, y: 64, z: 1, dimension: 'minecraft:overworld' }
  ];
  const decision = planSurvivalStep({
    goal: goal('gather'), observation: observation({ targets: candidates }), reservations: []
  });
  assert.equal(decision.action.payload.targetId, 'y-coordinate-winner');
});

test('rejects equipment destinations outside the shared runtime allowlist', () => {
  assert.throws(() => planSurvivalStep({
    goal: goal('equip', {
      destination: 'inventory',
      completion: { kind: 'equipped_item', actor: 'hero', item: 'wooden_pickaxe', destination: 'inventory' }
    }),
    observation: observation({ actors: { hero: { inventory: { wooden_pickaxe: 1 }, atMark: null, equipped: {} } } }),
    reservations: []
  }), { code: 'PLANNER_GOAL_INVALID' });
});

test('matches the authority coordinate key when an observed target has no explicit reservation key', () => {
  const input = {
    goal: goal('gather'),
    observation: observation({
      targets: [
        observedTarget('log-a', 'hero_tree', 'oak_log', { x: 1 }),
        observedTarget('log-b', 'hero_tree', 'oak_log', { x: 2 })
      ]
    }),
    reservations: [{ actorId: 'rival', reservationKey: 'target:minecraft:overworld:1:64:1' }]
  };

  assert.deepEqual(planSurvivalStep(input), action(
    'moveNearTarget',
    { actor: 'hero', goalId: 'gather-goal', targetId: 'log-b', region: 'hero_tree', block: 'oak_log' },
    'MOVE_TO_GATHER_TARGET'
  ));
});

test('matches the authority canonical item key for a numeric drop entity id', () => {
  const input = {
    goal: goal('gather'),
    observation: observation({
      drops: [
        { id: 'drop-a', entityId: 41, item: 'oak_log', region: 'hero_tree' },
        { id: 'drop-b', entityId: 42, item: 'oak_log', region: 'hero_tree' }
      ]
    }),
    reservations: [{
      actorId: 'rival',
      reservationKey: 'item:41'
    }]
  };

  assert.deepEqual(planSurvivalStep(input), action(
    'collectItem',
    { actor: 'hero', goalId: 'gather-goal', dropId: 'drop-b', item: 'oak_log', region: 'hero_tree' },
    'COLLECT_GATHERED_DROP'
  ));
});

test('returns the same frozen decision for identical inputs', () => {
  const input = {
    goal: goal('gather'),
    observation: observation({ targets: [observedTarget('log-2', 'hero_tree', 'oak_log'), observedTarget('log-1', 'hero_tree', 'oak_log')] }),
    reservations: []
  };
  assert.deepEqual(planSurvivalStep(input), planSurvivalStep(structuredClone(input)));
});

test('rejects every goal kind when an action payload field is not a string without freezing caller data', async (t) => {
  const cases = [
    ['gather', 'region', observation({ targets: [observedTarget('log-a', 'hero_tree', 'oak_log', { region: null })] })],
    ['craft', 'mark', observation({ actors: { hero: { inventory: { oak_log: 1 }, atMark: null, equipped: {} } } })],
    ['place', 'mark', observation({ actors: { hero: { inventory: { crafting_table: 1 }, atMark: null, equipped: {} } } })],
    ['equip', 'destination', observation({ actors: { hero: { inventory: { wooden_pickaxe: 1 }, atMark: null, equipped: {} } } })],
    ['excavate', 'region', observation({ targets: [observedTarget('stone-a', 'mine', 'stone', { region: null })] })],
    ['regroup', 'mark', observation()]
  ];

  for (const [kind, field, observed] of cases) {
    await t.test(kind, () => {
      const hostile = { owner: kind };
      if (kind === 'gather' || kind === 'excavate') observed.targets[0].region = hostile;
      const input = { goal: goal(kind, { [field]: hostile }), observation: observed, reservations: [] };
      assert.throws(() => planSurvivalStep(input), { code: 'PLANNER_GOAL_INVALID' });
      assert.equal(Object.isFrozen(hostile), false);
    });
  }
});

test('rejects non-normalized goal fields and schema-exceeding planner bounds', async (t) => {
  const cases = [
    ['unknown goal field', goal('gather', { unapproved: true }), observation()],
    ['missing timeout', (() => { const value = goal('gather'); delete value.timeoutMs; return value; })(), observation()],
    ['count above 64', goal('gather', { count: 65 }), observation()],
    ['max replans above 5', goal('gather', { maxReplans: 6 }), observation()],
    ['unsafe replan count', goal('gather'), observation({ replanCount: Number.MAX_SAFE_INTEGER + 1 })]
  ];
  for (const [name, malformedGoal, observed] of cases) {
    await t.test(name, () => {
      assert.throws(() => planSurvivalStep({ goal: malformedGoal, observation: observed, reservations: [] }), {
        code: name === 'unsafe replan count' ? 'PLANNER_OBSERVATION_INVALID' : 'PLANNER_GOAL_INVALID'
      });
    });
  }
});

test('caps planner-derived craft counts from a large but safe observed inventory', () => {
  const decision = planSurvivalStep({
    goal: goal('craft', { recipe: 'wooden_pickaxe', completion: { kind: 'actor_inventory_at_least', actor: 'hero', item: 'wooden_pickaxe', count: 1 } }),
    observation: observation({ actors: { hero: { inventory: { oak_log: 9_999 }, atMark: mark, equipped: {} } } }),
    reservations: []
  });
  assert.deepEqual(decision, action('craftRecipe', { actor: 'hero', goalId: 'craft-goal', recipe: 'oak_planks', count: 3, mark }, 'CRAFT_OAK_PLANKS_FOR_PICKAXE'));
});

test('orders target IDs by explicit code-unit order rather than locale-sensitive collation', () => {
  const decision = planSurvivalStep({
    goal: goal('gather'),
    observation: observation({ targets: [observedTarget('ä-log', 'hero_tree', 'oak_log'), observedTarget('z-log', 'hero_tree', 'oak_log')] }),
    reservations: []
  });
  assert.equal(decision.action.payload.targetId, 'z-log');
});
