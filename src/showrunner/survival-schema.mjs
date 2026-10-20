import { readFile } from 'node:fs/promises';
import { isMap, isSeq, LineCounter, parseDocument } from 'yaml';

import { ShowrunnerError } from './errors.mjs';
import { isEquipmentDestination } from './survival-contracts.mjs';

export const SURVIVAL_GOAL_KINDS = Object.freeze(['gather', 'craft', 'place', 'equip', 'excavate', 'regroup']);

const ACTOR_ITEMS = new Set(['oak_log', 'oak_planks', 'stick', 'crafting_table', 'wooden_pickaxe', 'cobblestone']);
const BLOCKS = new Set(['oak_log', 'stone', 'crafting_table']);
const RECIPES = new Set(['oak_planks', 'stick', 'crafting_table', 'wooden_pickaxe']);
const COMPLETION_KINDS = new Set(['actor_inventory_at_least', 'combined_inventory_at_least', 'placed_at_mark', 'at_mark', 'equipped_item']);
const GOAL_KEYS = new Set(['id', 'actor', 'kind', 'region', 'mark', 'item', 'block', 'recipe', 'destination', 'count', 'timeout_ms', 'max_replans', 'completion']);
const MAX_COUNT = 64;
const MAX_REPLANS = 5;
const MAX_TIMEOUT_MS = 120_000;

function sourceDetails({ sourcePath, source }, needle = '') {
  const index = Math.max(0, source.indexOf(needle));
  const before = source.slice(0, index);
  const lines = before.split('\n');
  return { path: sourcePath, line: lines.length, column: lines.at(-1).length + 1 };
}

function indexYamlNodes(raw, node, nodes) {
  if (!raw || typeof raw !== 'object' || !node) return;
  nodes.set(raw, node);
  if (isMap(node)) {
    for (const pair of node.items) indexYamlNodes(raw[pair.key?.value], pair.value, nodes);
  } else if (isSeq(node)) {
    node.items.forEach((item, index) => indexYamlNodes(raw[index], item, nodes));
  }
}

function yamlDetails(context, owner, key, mode = 'value') {
  if (!owner || typeof owner !== 'object' || !context.nodes) return sourceDetails(context, typeof key === 'string' ? key : '');
  const ownerNode = context.nodes.get(owner);
  let target;
  if (isMap(ownerNode)) {
    const pair = ownerNode.items.find((item) => item.key?.value === key);
    target = mode === 'key' ? pair?.key : pair?.value;
  } else if (isSeq(ownerNode) && Number.isInteger(key)) {
    target = ownerNode.items[key];
  }
  const offset = target?.range?.[0];
  if (!Number.isInteger(offset)) {
    const ownerOffset = ownerNode?.range?.[0];
    if (!Number.isInteger(ownerOffset)) return sourceDetails(context, typeof key === 'string' ? key : '');
    const ownerPosition = context.lineCounter.linePos(ownerOffset);
    return { path: context.sourcePath, line: ownerPosition.line, column: ownerPosition.col };
  }
  const position = context.lineCounter.linePos(offset);
  return { path: context.sourcePath, line: position.line, column: position.col };
}

function fail(context, message, owner, key, mode) {
  const details = owner && typeof owner === 'object'
    ? yamlDetails(context, owner, key, mode)
    : sourceDetails(context, typeof owner === 'string' ? owner : '');
  throw new ShowrunnerError('SURVIVAL_EPISODE_SCHEMA_INVALID', message, details);
}

function object(value, label, context, needle = label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(context, `${label} must be an object`, needle);
  return value;
}

function exactKeys(value, keys, label, context) {
  object(value, label, context);
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) fail(context, `${label} has forbidden field ${unknown}`, value, unknown, 'key');
  const missing = [...keys].find((key) => !Object.hasOwn(value, key));
  if (missing) fail(context, `${label} is missing ${missing}`, value, missing, 'key');
  return value;
}

function allowedKeys(value, keys, label, context) {
  object(value, label, context);
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) fail(context, `${label} has forbidden field ${unknown}`, value, unknown, 'key');
  return value;
}

function string(value, label, context, owner, key) {
  if (typeof value !== 'string' || value.trim() === '') fail(context, `${label} must be a nonempty string`, owner ?? label, key);
  return value;
}

function boundedInteger(value, label, context, { min = 1, max = Infinity, owner, key } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(context, `${label} must be an integer from ${min} to ${max}`, owner ?? label, key);
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function duplicateIndex(values) {
  const seen = new Set();
  return values.findIndex((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
}

function normalizePosition(raw, label, context) {
  exactKeys(raw, new Set(['x', 'y', 'z']), label, context);
  return {
    x: boundedInteger(raw.x, `${label}.x`, context, { min: -30_000_000, max: 30_000_000, owner: raw, key: 'x' }),
    y: boundedInteger(raw.y, `${label}.y`, context, { min: -64, max: 319, owner: raw, key: 'y' }),
    z: boundedInteger(raw.z, `${label}.z`, context, { min: -30_000_000, max: 30_000_000, owner: raw, key: 'z' })
  };
}

function normalizeRegions(raw, schemaVersion, context) {
  object(raw, 'regions', context);
  if (Object.keys(raw).length === 0) fail(context, 'regions must contain an approved region', 'regions');
  return Object.fromEntries(Object.entries(raw).map(([name, region]) => {
    object(region, `region ${name}`, context);
    const purpose = string(region.purpose, `region ${name}.purpose`, context, region, 'purpose');
    if (!['tree', 'excavation'].includes(purpose)) fail(context, `region ${name}.purpose is invalid`, region, 'purpose');
    const exactExcavationCells = schemaVersion === 2 && purpose === 'excavation';
    exactKeys(region, new Set(['purpose', 'min', 'max', 'allowed_blocks', ...(exactExcavationCells ? ['allowed_cells'] : [])]), `region ${name}`, context);
    const min = normalizePosition(region.min, `region ${name}.min`, context);
    const max = normalizePosition(region.max, `region ${name}.max`, context);
    if (['x', 'y', 'z'].some((axis) => min[axis] > max[axis])) fail(context, `region ${name} min must not exceed max`, region, 'min');
    if (!Array.isArray(region.allowed_blocks) || region.allowed_blocks.length === 0) {
      fail(context, `region ${name}.allowed_blocks must contain blocks`, region, 'allowed_blocks');
    }
    const allowedBlocks = region.allowed_blocks.map((block, index) => {
      string(block, `region ${name}.allowed_blocks`, context, region.allowed_blocks, index);
      if (!BLOCKS.has(block)) fail(context, `region ${name} has unapproved block ${block}`, region.allowed_blocks, index);
      return block;
    });
    if (purpose === 'tree' && !allowedBlocks.includes('oak_log')) fail(context, `tree region ${name} must allow oak_log`, region, 'allowed_blocks');
    if (purpose === 'excavation' && !allowedBlocks.includes('stone')) fail(context, `excavation region ${name} must allow stone`, region, 'allowed_blocks');
    let allowedCells;
    if (exactExcavationCells) {
      if (!Array.isArray(region.allowed_cells) || region.allowed_cells.length === 0) {
        fail(context, `region ${name}.allowed_cells must contain exact excavation cells`, region, 'allowed_cells');
      }
      allowedCells = region.allowed_cells.map((cell, index) => {
        const normalized = normalizePosition(cell, `region ${name}.allowed_cells[${index}]`, context);
        if (['x', 'y', 'z'].some((axis) => normalized[axis] < min[axis] || normalized[axis] > max[axis])) {
          fail(context, `region ${name} allowed cell must be inside its volume`, region.allowed_cells, index);
        }
        return normalized;
      });
      const keys = allowedCells.map(({ x, y, z }) => `${x}:${y}:${z}`);
      if (new Set(keys).size !== keys.length) fail(context, `region ${name}.allowed_cells must be unique`, region, 'allowed_cells');
    }
    return [name, { purpose, min, max, allowedBlocks, ...(allowedCells ? { allowedCells } : {}) }];
  }));
}

function normalizeMarks(raw, context) {
  object(raw, 'marks', context);
  if (Object.keys(raw).length === 0) fail(context, 'marks must contain an approved mark', 'marks');
  return Object.fromEntries(Object.entries(raw).map(([name, mark]) => {
    exactKeys(mark, new Set(['position', 'safe_headroom']), `mark ${name}`, context);
    if (mark.safe_headroom !== true) fail(context, `mark ${name} must require safe headroom`, mark, 'safe_headroom');
    return [name, { position: normalizePosition(mark.position, `mark ${name}.position`, context), safeHeadroom: true }];
  }));
}

function goalField(raw, name, context) {
  return string(raw[name], `goal.${name}`, context, raw, name);
}

function normalizeCompletion(raw, goal, actors, marks, context) {
  object(raw, 'goal.completion', context);
  const kind = string(raw.kind, 'completion.kind', context, raw, 'kind');
  if (!COMPLETION_KINDS.has(kind)) fail(context, `Unknown completion predicate ${kind}`, raw, 'kind');
  const keysByKind = {
    actor_inventory_at_least: new Set(['kind', 'actor', 'item', 'count']),
    combined_inventory_at_least: new Set(['kind', 'item', 'count']),
    placed_at_mark: new Set(['kind', 'block', 'mark']),
    at_mark: new Set(['kind', 'actor', 'mark']),
    equipped_item: new Set(['kind', 'actor', 'item', 'destination'])
  };
  exactKeys(raw, keysByKind[kind], `completion ${kind}`, context);
  if (kind === 'actor_inventory_at_least') {
    const actor = goalField(raw, 'actor', context);
    const item = goalField(raw, 'item', context);
    if (!actors.includes(actor)) fail(context, `Unknown completion actor ${actor}`, raw, 'actor');
    if (!ACTOR_ITEMS.has(item)) fail(context, `Unknown completion item ${item}`, raw, 'item');
    return { kind, actor, item, count: boundedInteger(raw.count, 'completion.count', context, { max: MAX_COUNT, owner: raw, key: 'count' }) };
  }
  if (kind === 'combined_inventory_at_least') {
    const item = goalField(raw, 'item', context);
    if (!ACTOR_ITEMS.has(item)) fail(context, `Unknown completion item ${item}`, raw, 'item');
    return { kind, item, count: boundedInteger(raw.count, 'completion.count', context, { max: MAX_COUNT, owner: raw, key: 'count' }) };
  }
  if (kind === 'placed_at_mark') {
    const block = goalField(raw, 'block', context);
    const mark = goalField(raw, 'mark', context);
    if (!BLOCKS.has(block)) fail(context, `Unknown completion block ${block}`, raw, 'block');
    if (!Object.hasOwn(marks, mark)) fail(context, `Unknown completion mark ${mark}`, raw, 'mark');
    return { kind, block, mark };
  }
  if (kind === 'at_mark') {
    const actor = goalField(raw, 'actor', context);
    const mark = goalField(raw, 'mark', context);
    if (!actors.includes(actor)) fail(context, `Unknown completion actor ${actor}`, raw, 'actor');
    if (!Object.hasOwn(marks, mark)) fail(context, `Unknown completion mark ${mark}`, raw, 'mark');
    return { kind, actor, mark };
  }
  const actor = goalField(raw, 'actor', context);
  const item = goalField(raw, 'item', context);
  if (!actors.includes(actor)) fail(context, `Unknown completion actor ${actor}`, raw, 'actor');
  if (!ACTOR_ITEMS.has(item)) fail(context, `Unknown completion item ${item}`, raw, 'item');
  return { kind, actor, item, destination: goalField(raw, 'destination', context) };
}

function requireMatchingCompletion(goal, completion, rawCompletion, context) {
  if (goal.kind === 'excavate') {
    const expected = completion.kind === 'actor_inventory_at_least'
      ? { kind: 'actor_inventory_at_least', actor: goal.actor, item: goal.item, count: goal.count }
      : { kind: 'combined_inventory_at_least', item: goal.item, count: goal.count };
    const mismatch = Object.keys(expected).find((key) => completion[key] !== expected[key]);
    if (mismatch) fail(context, `completion must confirm the excavate goal's ${mismatch}`, rawCompletion, mismatch);
    return;
  }
  const expectedByGoalKind = {
    gather: {
      kind: 'actor_inventory_at_least', actor: goal.actor, item: goal.item, count: goal.count
    },
    craft: {
      kind: 'actor_inventory_at_least', actor: goal.actor, item: goal.recipe, count: goal.count
    },
    place: {
      kind: 'placed_at_mark', block: goal.block, mark: goal.mark
    },
    equip: {
      kind: 'equipped_item', actor: goal.actor, item: goal.item, destination: goal.destination
    },
    regroup: {
      kind: 'at_mark', actor: goal.actor, mark: goal.mark
    }
  };
  const expected = expectedByGoalKind[goal.kind];
  const mismatch = Object.keys(expected).find((key) => completion[key] !== expected[key]);
  if (mismatch) {
    fail(context, `completion must confirm the ${goal.kind} goal's ${mismatch}`, rawCompletion, mismatch);
  }
}

function normalizeGoal(raw, actors, regions, marks, context) {
  allowedKeys(raw, GOAL_KEYS, 'goal', context);
  const id = goalField(raw, 'id', context);
  const actor = goalField(raw, 'actor', context);
  const kind = goalField(raw, 'kind', context);
  if (!actors.includes(actor)) fail(context, `Unknown goal actor ${actor}`, raw, 'actor');
  if (!SURVIVAL_GOAL_KINDS.includes(kind)) fail(context, `Unknown survival goal kind ${kind}`, raw, 'kind');
  const count = boundedInteger(raw.count, 'goal.count', context, { max: MAX_COUNT, owner: raw, key: 'count' });
  const timeoutMs = boundedInteger(raw.timeout_ms, 'goal.timeout_ms', context, { max: MAX_TIMEOUT_MS, owner: raw, key: 'timeout_ms' });
  const maxReplans = boundedInteger(raw.max_replans, 'goal.max_replans', context, { min: 0, max: MAX_REPLANS, owner: raw, key: 'max_replans' });
  const has = (key) => raw[key] !== undefined;
  const requireOnly = (keys) => {
    for (const key of GOAL_KEYS) {
      if (['id', 'actor', 'kind', 'count', 'timeout_ms', 'max_replans', 'completion'].includes(key)) continue;
      if (keys.includes(key) !== has(key)) fail(context, `goal ${kind} must ${keys.includes(key) ? 'declare' : 'not declare'} ${key}`, raw, key);
    }
  };
  const goal = { id, actor, kind, count, timeoutMs, maxReplans };
  if (kind === 'gather') {
    requireOnly(['region', 'item']);
    const region = goalField(raw, 'region', context);
    const item = goalField(raw, 'item', context);
    if (!Object.hasOwn(regions, region) || regions[region].purpose !== 'tree') fail(context, `gather region ${region} is not an approved tree region`, raw, 'region');
    if (item !== 'oak_log') fail(context, `gather item ${item} is not approved`, raw, 'item');
    goal.region = region;
    goal.item = item;
  } else if (kind === 'craft') {
    requireOnly(['recipe', 'mark']);
    const recipe = goalField(raw, 'recipe', context);
    const mark = goalField(raw, 'mark', context);
    if (!RECIPES.has(recipe)) fail(context, `Unknown recipe ${recipe}`, raw, 'recipe');
    if (!Object.hasOwn(marks, mark)) fail(context, `Unknown crafting mark ${mark}`, raw, 'mark');
    goal.recipe = recipe;
    goal.mark = mark;
  } else if (kind === 'place') {
    requireOnly(['block', 'mark']);
    const block = goalField(raw, 'block', context);
    const mark = goalField(raw, 'mark', context);
    if (block !== 'crafting_table') fail(context, `place block ${block} is not approved`, raw, 'block');
    if (!Object.hasOwn(marks, mark)) fail(context, `Unknown placement mark ${mark}`, raw, 'mark');
    goal.block = block;
    goal.mark = mark;
  } else if (kind === 'equip') {
    requireOnly(['item', 'destination']);
    const item = goalField(raw, 'item', context);
    if (item !== 'wooden_pickaxe') fail(context, `equip item ${item} is not approved`, raw, 'item');
    goal.item = item;
    goal.destination = goalField(raw, 'destination', context);
    if (!isEquipmentDestination(goal.destination)) {
      fail(context, `equip destination ${goal.destination} is not approved`, raw, 'destination');
    }
  } else if (kind === 'excavate') {
    requireOnly(['region', 'block', 'item']);
    const region = goalField(raw, 'region', context);
    const block = goalField(raw, 'block', context);
    const item = goalField(raw, 'item', context);
    if (!Object.hasOwn(regions, region) || regions[region].purpose !== 'excavation') fail(context, `excavate region ${region} is not an approved excavation volume`, raw, 'region');
    if (block !== 'stone' || !regions[region].allowedBlocks.includes(block)) fail(context, `excavate block ${block} is not approved`, raw, 'block');
    if (item !== 'cobblestone') fail(context, `excavate item ${item} is not approved`, raw, 'item');
    goal.region = region;
    goal.block = block;
    goal.item = item;
  } else {
    requireOnly(['mark']);
    const mark = goalField(raw, 'mark', context);
    if (!Object.hasOwn(marks, mark)) fail(context, `Unknown regroup mark ${mark}`, raw, 'mark');
    goal.mark = mark;
  }
  goal.completion = normalizeCompletion(raw.completion, goal, actors, marks, context);
  requireMatchingCompletion(goal, goal.completion, raw.completion, context);
  return goal;
}

function normalizeBeats(raw, goals, context) {
  if (!Array.isArray(raw) || raw.length !== 6) fail(context, 'beats must contain exactly six visible beats', 'beats');
  const beats = raw.map((beat, index) => {
    exactKeys(beat, new Set(['id', 'goal_ids']), `beat ${index}`, context);
    const id = string(beat.id, `beat ${index}.id`, context, beat, 'id');
    if (!Array.isArray(beat.goal_ids)) fail(context, `beat ${id}.goal_ids must be an array`, beat, 'goal_ids');
    return {
      id,
      goalIds: beat.goal_ids.map((goalId, goalIndex) => string(goalId, `beat ${id}.goal_ids`, context, beat.goal_ids, goalIndex))
    };
  });
  const duplicateBeatIndex = duplicateIndex(beats.map(({ id }) => id));
  if (duplicateBeatIndex >= 0) fail(context, 'beat ids must be unique', raw[duplicateBeatIndex], 'id');
  const actual = beats.flatMap(({ goalIds }) => goalIds);
  const expected = goals.map(({ id }) => id);
  if (actual.length !== expected.length || actual.some((goalId, index) => goalId !== expected[index])) {
    fail(context, 'beat goal_ids must partition every goal exactly once in authored order', 'beats');
  }
  return beats;
}

function normalizeSurvivalEpisode(raw, context) {
  object(raw, '$', context);
  if (![1, 2].includes(raw.schema_version)) fail(context, 'Unsupported survival episode schema version', raw, 'schema_version');
  const versionFields = raw.schema_version === 1 ? ['dialogue_boundaries'] : ['beats'];
  exactKeys(raw, new Set(['schema_version', 'episode', 'title', 'actors', 'regions', 'marks', ...versionFields, 'goals']), '$', context);
  if (!Array.isArray(raw.actors) || raw.actors.length !== 2 || new Set(raw.actors).size !== 2) {
    fail(context, 'actors must contain exactly two unique actors', raw, 'actors');
  }
  const actors = raw.actors.map((actor, index) => string(actor, 'actors', context, raw.actors, index));
  const regions = normalizeRegions(raw.regions, raw.schema_version, context);
  const marks = normalizeMarks(raw.marks, context);
  if (!Array.isArray(raw.goals) || raw.goals.length === 0) fail(context, 'goals must contain at least one goal', 'goals');
  const goals = raw.goals.map((goal) => normalizeGoal(goal, actors, regions, marks, context));
  const duplicateGoalIndex = duplicateIndex(goals.map((goal) => goal.id));
  if (duplicateGoalIndex >= 0) fail(context, 'goal ids must be unique', raw.goals[duplicateGoalIndex], 'id');
  let dialogueBoundaries;
  let beats;
  if (raw.schema_version === 1) {
    if (!Array.isArray(raw.dialogue_boundaries)) fail(context, 'dialogue_boundaries must be an array', 'dialogue_boundaries');
    dialogueBoundaries = raw.dialogue_boundaries.map((id, index) => {
      string(id, 'dialogue_boundaries', context, raw.dialogue_boundaries, index);
      if (!goals.some((goal) => goal.id === id)) fail(context, `Unknown dialogue boundary ${id}`, raw.dialogue_boundaries, index);
      return id;
    });
    const duplicateBoundaryIndex = duplicateIndex(dialogueBoundaries);
    if (duplicateBoundaryIndex >= 0) {
      fail(context, 'dialogue boundaries must be unique', raw.dialogue_boundaries, duplicateBoundaryIndex);
    }
  } else {
    beats = normalizeBeats(raw.beats, goals, context);
  }
  return deepFreeze({
    schemaVersion: raw.schema_version,
    episode: string(raw.episode, 'episode', context, raw, 'episode'),
    title: string(raw.title, 'title', context, raw, 'title'),
    actors,
    regions,
    marks,
    ...(dialogueBoundaries === undefined ? {} : { dialogueBoundaries }),
    ...(beats === undefined ? {} : { beats }),
    goals,
    sourcePath: context.sourcePath
  });
}

export async function loadSurvivalEpisode(sourcePath) {
  const source = await readFile(sourcePath, 'utf8');
  const lineCounter = new LineCounter();
  const document = parseDocument(source, { lineCounter, prettyErrors: true });
  if (document.errors.length > 0) {
    const position = document.errors[0].linePos?.[0];
    throw new ShowrunnerError('SURVIVAL_EPISODE_YAML_INVALID', `Invalid YAML in ${sourcePath}`, {
      path: sourcePath,
      line: position?.line ?? 1,
      column: position?.col ?? 1,
      cause: document.errors[0].message
    });
  }
  const raw = document.toJS();
  const nodes = new WeakMap();
  indexYamlNodes(raw, document.contents, nodes);
  return normalizeSurvivalEpisode(raw, { sourcePath, source, lineCounter, nodes });
}
