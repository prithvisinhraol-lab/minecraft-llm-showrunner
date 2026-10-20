import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { SURVIVAL_GOAL_KINDS, loadSurvivalEpisode } from '../src/showrunner/survival-schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const meadowPath = path.join(here, '..', 'production', 'episodes', 'first-day-meadow.survival.yaml');

async function copyMeadow(t, name, mutate) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'survival-schema-'));
  const target = path.join(directory, name);
  const source = await readFile(meadowPath, 'utf8');
  await writeFile(target, mutate(source));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return target;
}

function asSchemaTwo(source) {
  return source;
}

function asLegacySchemaOne(source) {
  return source
    .replace('schema_version: 2', 'schema_version: 1')
    .replace(/    allowed_cells:\n(?:      - \{[^\n]+\}\n){6}/, '')
    .replace(/    allowed_cells:\n(?:      - \{[^\n]+\}\n){5}/, '')
    .replace(/beats:\n[\s\S]*?\ngoals:\n/, 'dialogue_boundaries: []\ngoals:\n');
}

test('loads schema-v2 as six visible beats partitioning ordered internal goals', async (t) => {
  const sourcePath = await copyMeadow(t, 'schema-v2.yaml', asSchemaTwo);

  const episode = await loadSurvivalEpisode(sourcePath);

  assert.equal(episode.schemaVersion, 2);
  assert.deepEqual(episode.beats.map(({ id }) => id), [
    'arrival', 'first_priorities', 'two_trees', 'crafting', 'breaking_ground', 'hook'
  ]);
  assert.deepEqual(episode.beats.flatMap(({ goalIds }) => goalIds), episode.goals.map(({ id }) => id));
  assert.equal(Object.isFrozen(episode.beats[0].goalIds), true);
});

test('loads legacy schema-v1 excavation regions with bounded volumes and no exact cell list', async (t) => {
  const sourcePath = await copyMeadow(t, 'schema-v1-volume-only.yaml', asLegacySchemaOne);

  const episode = await loadSurvivalEpisode(sourcePath);

  assert.equal(episode.schemaVersion, 1);
  assert.deepEqual(episode.dialogueBoundaries, []);
  assert.equal(episode.regions.hero_mine_lane.allowedCells, undefined);
  assert.deepEqual(episode.regions.hero_mine_lane.max, { x: 66, y: 65, z: 58 });
});

test('rejects malformed schema-v2 beat identities and goal partitions', async (t) => {
  const cases = [
    ['duplicate-beat.yaml', (source) => source.replace('id: first_priorities', 'id: arrival')],
    ['five-beats.yaml', (source) => source.replace('  - id: hook\n    goal_ids: []\n', '')],
    ['unknown-goal.yaml', (source) => source.replace('goal_ids: [gather_hero_logs, gather_rival_logs]', 'goal_ids: [unknown_goal, gather_rival_logs]')],
    ['duplicate-goal.yaml', (source) => source.replace('goal_ids: [excavate_hero_lane, excavate_rival_lane]', 'goal_ids: [equip_rival_wooden_pickaxe, excavate_hero_lane, excavate_rival_lane]')],
    ['reordered-goal.yaml', (source) => source.replace('goal_ids: [gather_hero_logs, gather_rival_logs]', 'goal_ids: [gather_rival_logs, gather_hero_logs]')]
  ];

  for (const [name, mutate] of cases) {
    const sourcePath = await copyMeadow(t, name, (source) => mutate(asSchemaTwo(source)));
    await assert.rejects(loadSurvivalEpisode(sourcePath), { code: 'SURVIVAL_EPISODE_SCHEMA_INVALID' });
  }
});

test('loads and freezes eleven bounded goals partitioned across six visible meadow beats', async () => {
  const episode = await loadSurvivalEpisode(meadowPath);

  assert.deepEqual(SURVIVAL_GOAL_KINDS, ['gather', 'craft', 'place', 'equip', 'excavate', 'regroup']);
  assert.equal(episode.schemaVersion, 2);
  assert.equal(episode.goals.length, 11);
  assert.deepEqual(episode.goals.map((goal) => goal.kind), [
    'gather', 'gather', 'regroup', 'regroup', 'place', 'craft', 'craft', 'equip', 'equip', 'excavate', 'excavate'
  ]);
  assert.deepEqual(episode.goals.slice(0, 2).map((goal) => goal.region), ['hero_tree', 'rival_tree']);
  assert.deepEqual(episode.goals.slice(5, 7).map(({ actor, count }) => ({ actor, count })), [
    { actor: 'hero', count: 1 }, { actor: 'rival', count: 1 }
  ]);
  assert.deepEqual(episode.goals.slice(7, 9).map(({ actor, kind }) => ({ actor, kind })), [
    { actor: 'hero', kind: 'equip' }, { actor: 'rival', kind: 'equip' }
  ]);
  assert.deepEqual(episode.goals.slice(9).map(({ actor, region, completion }) => ({
    actor, region, completionKind: completion.kind, completionActor: completion.actor
  })), [
    { actor: 'hero', region: 'hero_mine_lane', completionKind: 'actor_inventory_at_least', completionActor: 'hero' },
    { actor: 'rival', region: 'rival_mine_lane', completionKind: 'actor_inventory_at_least', completionActor: 'rival' }
  ]);
  assert.deepEqual(episode.regions.hero_mine_lane.allowedCells, [
    { x: 66, y: 64, z: 54 }, { x: 66, y: 64, z: 55 }, { x: 66, y: 64, z: 56 },
    { x: 66, y: 64, z: 57 }, { x: 66, y: 64, z: 58 }, { x: 66, y: 65, z: 58 }
  ]);
  assert.deepEqual(episode.regions.rival_mine_lane.allowedCells, [
    { x: 67, y: 64, z: 54 }, { x: 67, y: 64, z: 55 }, { x: 67, y: 64, z: 56 },
    { x: 67, y: 64, z: 57 }, { x: 67, y: 64, z: 58 }
  ]);
  assert.equal(Object.isFrozen(episode.regions.hero_mine_lane.allowedCells[0]), true);
  assert.deepEqual(episode.beats.map(({ id, goalIds }) => ({ id, goalIds })), [
    { id: 'arrival', goalIds: [] },
    { id: 'first_priorities', goalIds: [] },
    { id: 'two_trees', goalIds: ['gather_hero_logs', 'gather_rival_logs'] },
    { id: 'crafting', goalIds: [
      'regroup_hero_at_crafting_table', 'regroup_rival_at_crafting_table', 'place_crafting_table',
      'craft_hero_wooden_pickaxe', 'craft_rival_wooden_pickaxe',
      'equip_hero_wooden_pickaxe', 'equip_rival_wooden_pickaxe'
    ] },
    { id: 'breaking_ground', goalIds: ['excavate_hero_lane', 'excavate_rival_lane'] },
    { id: 'hook', goalIds: [] }
  ]);
  assert.equal(Object.isFrozen(episode), true);
  assert.equal(Object.isFrozen(episode.goals[0].completion), true);
});

test('requires unique excavation cells inside their declared bounding volume', async (t) => {
  const cases = [
    ['missing-cells.yaml', (source) => source.replace(/    allowed_cells:\n(?:      - \{[^\n]+\}\n){6}/, '')],
    ['duplicate-cell.yaml', (source) => source.replace('{x: 66, y: 65, z: 58}', '{x: 66, y: 64, z: 54}')],
    ['outside-cell.yaml', (source) => source.replace('{x: 66, y: 65, z: 58}', '{x: 66, y: 65, z: 54}')]
  ];

  for (const [name, mutate] of cases) {
    const sourcePath = await copyMeadow(t, name, mutate);
    await assert.rejects(loadSurvivalEpisode(sourcePath), { code: 'SURVIVAL_EPISODE_SCHEMA_INVALID' });
  }
});

test('rejects unknown goal kinds, actors, and goal fields with source locations', async (t) => {
  const kindsPath = await copyMeadow(t, 'unknown-kind.yaml', (source) => source.replace('kind: gather', 'kind: sprint'));
  const actorPath = await copyMeadow(t, 'unknown-actor.yaml', (source) => source.replace('actor: hero', 'actor: narrator'));
  const fieldPath = await copyMeadow(t, 'unknown-field.yaml', (source) => source.replace('    count: 3\n', '    count: 3\n    command: /give hero diamond\n'));

  for (const sourcePath of [kindsPath, actorPath, fieldPath]) {
    await assert.rejects(loadSurvivalEpisode(sourcePath), (error) => {
      assert.equal(error.code, 'SURVIVAL_EPISODE_SCHEMA_INVALID');
      assert.equal(error.details.path, sourcePath);
      assert.equal(Number.isInteger(error.details.line), true);
      assert.equal(Number.isInteger(error.details.column), true);
      return true;
    });
  }

});

test('rejects unapproved blocks, recipes, marks, predicates, and counts outside the bound', async (t) => {
  const blockPath = await copyMeadow(t, 'unknown-block.yaml', (source) => source.replace('block: crafting_table', 'block: diamond_block'));
  const recipePath = await copyMeadow(t, 'unknown-recipe.yaml', (source) => source.replace('recipe: wooden_pickaxe', 'recipe: diamond_pickaxe'));
  const markPath = await copyMeadow(t, 'unknown-mark.yaml', (source) => source.replace('mark: crafting_table', 'mark: forbidden_mark'));
  const predicatePath = await copyMeadow(t, 'unknown-predicate.yaml', (source) => source.replace('kind: actor_inventory_at_least', 'kind: all_items_granted'));
  const zeroPath = await copyMeadow(t, 'zero-count.yaml', (source) => source.replace('count: 3', 'count: 0'));
  const largePath = await copyMeadow(t, 'large-count.yaml', (source) => source.replace('count: 3', 'count: 65'));

  for (const sourcePath of [blockPath, recipePath, markPath, predicatePath, zeroPath, largePath]) {
    await assert.rejects(loadSurvivalEpisode(sourcePath), { code: 'SURVIVAL_EPISODE_SCHEMA_INVALID' });
  }
});

test('requires bounded goal budgets, required regions, and an approved excavation volume', async (t) => {
  const timeoutPath = await copyMeadow(t, 'large-timeout.yaml', (source) => source.replace('timeout_ms: 30000', 'timeout_ms: 120001'));
  const replansPath = await copyMeadow(t, 'large-replans.yaml', (source) => source.replace('max_replans: 2', 'max_replans: 6'));
  const regionPath = await copyMeadow(t, 'missing-region.yaml', (source) => source.replace('    region: hero_tree\n', ''));
  const excavationPath = await copyMeadow(t, 'wrong-excavation-volume.yaml', (source) => source.replace(
    'kind: excavate\n    region: hero_mine_lane',
    'kind: excavate\n    region: hero_tree'
  ));

  for (const sourcePath of [timeoutPath, replansPath, regionPath, excavationPath]) {
    await assert.rejects(loadSurvivalEpisode(sourcePath), { code: 'SURVIVAL_EPISODE_SCHEMA_INVALID' });
  }
});

test('rejects inherited property names as authored marks', async (t) => {
  const inheritedMarkPath = await copyMeadow(t, 'inherited-mark.yaml', (source) => source.replace('mark: crafting_table', 'mark: toString'));

  await assert.rejects(loadSurvivalEpisode(inheritedMarkPath), { code: 'SURVIVAL_EPISODE_SCHEMA_INVALID' });
});

test('reports malformed YAML with the parser source location', async (t) => {
  const malformedPath = await copyMeadow(t, 'duplicate-key.yaml', (source) => source.replace('schema_version: 2', 'schema_version: 2\nschema_version: 2'));

  await assert.rejects(loadSurvivalEpisode(malformedPath), (error) => {
    assert.equal(error.code, 'SURVIVAL_EPISODE_YAML_INVALID');
    assert.equal(error.details.path, malformedPath);
    assert.equal(error.details.line, 2);
    assert.equal(error.details.column, 1);
    return true;
  });
});

test('requires every completion predicate to prove its own goal effect', async (t) => {
  const cases = [
    ['gather', (source) => source.replace(
      'completion:\n      kind: actor_inventory_at_least\n      actor: hero\n      item: oak_log\n      count: 3',
      'completion:\n      kind: combined_inventory_at_least\n      item: cobblestone\n      count: 3'
    )],
    ['craft', (source) => source.replace(
      'actor: hero\n      item: wooden_pickaxe\n      count: 1',
      'actor: hero\n      item: oak_log\n      count: 1'
    )],
    ['place', (source) => source.replace(
      'kind: placed_at_mark\n      block: crafting_table',
      'kind: placed_at_mark\n      block: oak_log'
    )],
    ['regroup', (source) => source.replace(
      'kind: at_mark\n      actor: hero\n      mark: crafting_table',
      'kind: at_mark\n      actor: rival\n      mark: crafting_table'
    )],
    ['excavate', (source) => source.replace(
      'kind: actor_inventory_at_least\n      actor: hero\n      item: cobblestone\n      count: 6',
      'kind: actor_inventory_at_least\n      actor: hero\n      item: oak_log\n      count: 6'
    )],
    ['equip', (source) => source.replace(
      'kind: equipped_item\n      actor: hero\n      item: wooden_pickaxe',
      'kind: equipped_item\n      actor: rival\n      item: wooden_pickaxe'
    )]
  ];

  for (const [kind, mutate] of cases) {
    await t.test(kind, async () => {
      const sourcePath = await copyMeadow(t, `mismatched-${kind}.yaml`, mutate);
      await assert.rejects(loadSurvivalEpisode(sourcePath), { code: 'SURVIVAL_EPISODE_SCHEMA_INVALID' });
    });
  }
});

test('reports the exact repeated YAML leaf for destination, count, and allowed-cell failures', async (t) => {
  const cases = [
    {
      name: 'second-equip-destination.yaml',
      mutate: (source) => source.replace(
        '  - id: equip_rival_wooden_pickaxe\n    actor: rival\n    kind: equip\n    item: wooden_pickaxe\n    destination: hand',
        '  - id: equip_rival_wooden_pickaxe\n    actor: rival\n    kind: equip\n    item: wooden_pickaxe\n    destination: inventory'
      ),
      line: 167,
      column: 18
    },
    {
      name: 'second-gather-count.yaml',
      mutate: (source) => source.replace(
        '  - id: gather_rival_logs\n    actor: rival\n    kind: gather\n    region: rival_tree\n    item: oak_log\n    count: 3',
        '  - id: gather_rival_logs\n    actor: rival\n    kind: gather\n    region: rival_tree\n    item: oak_log\n    count: 0'
      ),
      line: 82,
      column: 12
    },
    {
      name: 'third-allowed-cell-z.yaml',
      mutate: (source) => source.replace('{x: 66, y: 64, z: 56}', '{x: 66, y: 64, z: nope}'),
      line: 24,
      column: 27
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const sourcePath = await copyMeadow(t, scenario.name, scenario.mutate);
      await assert.rejects(loadSurvivalEpisode(sourcePath), (error) => {
        assert.equal(error.code, 'SURVIVAL_EPISODE_SCHEMA_INVALID');
        assert.deepEqual(
          { line: error.details.line, column: error.details.column },
          { line: scenario.line, column: scenario.column }
        );
        return true;
      });
    });
  }
});

test('reports the exact repeated safe_headroom value for a later mark', async (t) => {
  const sourcePath = await copyMeadow(t, 'second-mark-headroom.yaml', (source) => source.replace(
    '    safe_headroom: true\nbeats:',
    '    safe_headroom: true\n  unsafe_spot:\n    position: {x: 53, y: 65, z: 50}\n    safe_headroom: false\nbeats:'
  ));

  await assert.rejects(loadSurvivalEpisode(sourcePath), (error) => {
    assert.equal(error.code, 'SURVIVAL_EPISODE_SCHEMA_INVALID');
    assert.deepEqual({ line: error.details.line, column: error.details.column }, { line: 45, column: 20 });
    return true;
  });
});

test('reports a missing repeated goal leaf at its owning goal mapping', async (t) => {
  const sourcePath = await copyMeadow(t, 'missing-rival-destination.yaml', (source) => source.replace(
    '  - id: equip_rival_wooden_pickaxe\n    actor: rival\n    kind: equip\n    item: wooden_pickaxe\n    destination: hand',
    '  - id: equip_rival_wooden_pickaxe\n    actor: rival\n    kind: equip\n    item: wooden_pickaxe'
  ));
  await assert.rejects(loadSurvivalEpisode(sourcePath), (error) => {
    assert.equal(error.code, 'SURVIVAL_EPISODE_SCHEMA_INVALID');
    assert.deepEqual({ line: error.details.line, column: error.details.column }, { line: 163, column: 5 });
    return true;
  });
});

test('reports the exact duplicate beat, goal, and dialogue-boundary leaf', async (t) => {
  const cases = [
    {
      name: 'duplicate-second-beat.yaml',
      mutate: (source) => source.replace('id: first_priorities', 'id: arrival'),
      offset: (source) => source.lastIndexOf('id: arrival') + 'id: '.length
    },
    {
      name: 'duplicate-second-goal.yaml',
      mutate: (source) => source.replace('id: gather_rival_logs', 'id: gather_hero_logs'),
      offset: (source) => source.lastIndexOf('id: gather_hero_logs') + 'id: '.length
    },
    {
      name: 'duplicate-second-boundary.yaml',
      mutate: (source) => asLegacySchemaOne(source).replace(
        'dialogue_boundaries: []',
        'dialogue_boundaries: [gather_hero_logs, gather_hero_logs]'
      ),
      offset: (source) => {
        const boundary = 'dialogue_boundaries: [gather_hero_logs, gather_hero_logs]';
        return source.indexOf(boundary) + boundary.lastIndexOf('gather_hero_logs');
      }
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let authoredSource;
      const sourcePath = await copyMeadow(t, scenario.name, (source) => {
        authoredSource = scenario.mutate(source);
        return authoredSource;
      });
      const offset = scenario.offset(authoredSource);
      const before = authoredSource.slice(0, offset).split('\n');
      const expected = { line: before.length, column: before.at(-1).length + 1 };

      await assert.rejects(loadSurvivalEpisode(sourcePath), (error) => {
        assert.equal(error.code, 'SURVIVAL_EPISODE_SCHEMA_INVALID');
        assert.deepEqual({ line: error.details.line, column: error.details.column }, expected);
        return true;
      });
    });
  }
});
