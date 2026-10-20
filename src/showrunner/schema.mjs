import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isMap, isSeq, LineCounter, parseDocument } from 'yaml';

import { ERROR_CODES, ShowrunnerError } from './errors.mjs';

const EPISODE_KEYS = new Set(['schema_version', 'episode', 'title', 'content_rating', 'actors', 'set', 'scene', 'retry']);
const PROFILE_KEYS = new Set([
  'schema_version', 'actor', 'relationship', 'voice', 'vocabulary', 'cadence', 'humor', 'emotional_range',
  'scene_attitude', 'preferred_subjects', 'forbidden_subjects', 'max_line_words', 'positive_examples', 'rehearsal'
]);
const MANIFEST_KEYS = new Set([
  'schema_version', 'set_id', 'set_version', 'dimension', 'protected_cuboid', 'block_assertions', 'actor_baselines',
  'environment', 'entity_cleanup_tag', 'reset_timeout_ms'
]);

function sourceDetails(sourcePath, source, needle = '') {
  const index = source.indexOf(needle);
  const before = source.slice(0, Math.max(0, index));
  const lines = before.split('\n');
  return { path: sourcePath, line: lines.length, column: lines.at(-1).length + 1 };
}

function indexYamlNodes(raw, node, nodes, parentPairs, parentPair) {
  if (!raw || typeof raw !== 'object' || !node) return;
  nodes.set(raw, node);
  if (parentPair) parentPairs.set(raw, parentPair);
  if (isMap(node)) {
    for (const pair of node.items) indexYamlNodes(raw[pair.key?.value], pair.value, nodes, parentPairs, pair);
  } else if (isSeq(node)) {
    node.items.forEach((item, index) => indexYamlNodes(raw[index], item, nodes, parentPairs));
  }
}

function yamlDetails(context, owner, key, mode = 'value') {
  if (!context.nodes || !owner || typeof owner !== 'object') {
    return sourceDetails(context.path, context.source, typeof key === 'string' ? key : '');
  }
  const ownerNode = context.nodes.get(owner);
  let target;
  if (key !== undefined && isMap(ownerNode)) {
    const pair = ownerNode.items.find((item) => item.key?.value === key);
    target = mode === 'key' ? pair?.key : pair?.value;
  } else if (key !== undefined && isSeq(ownerNode)) {
    target = ownerNode.items[key];
  } else {
    target = context.parentPairs.get(owner)?.key ?? ownerNode;
  }
  const offset = target?.range?.[0];
  if (!Number.isInteger(offset)) return sourceDetails(context.path, context.source);
  const position = context.lineCounter.linePos(offset);
  return { path: context.path, line: position.line, column: position.col };
}

function fail(context, message, owner, key, mode) {
  throw new ShowrunnerError(context.code, message, yamlDetails(context, owner, key, mode));
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function object(value, label, context, owner, key) {
  if (!isObject(value)) fail(context, `${label} must be an object`, owner, key);
  return value;
}

function exactKeys(value, keys, label, context, owner, key) {
  object(value, label, context, owner, key);
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) fail(context, `${label} has forbidden field ${unknown}`, value, unknown, 'key');
  const missing = [...keys].find((key) => !(key in value));
  if (missing) fail(context, `${label} is missing ${missing}`, value);
  return value;
}

function allowedKeys(value, keys, label, context, owner, key) {
  object(value, label, context, owner, key);
  const unknown = Object.keys(value).find((candidate) => !keys.has(candidate));
  if (unknown) fail(context, `${label} has forbidden field ${unknown}`, value, unknown, 'key');
  return value;
}

function string(value, label, context, owner, key) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(context, `${label} must be a nonempty string`, owner, key);
  }
  return value;
}

function number(value, label, context, owner, key, { positive = false, integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0) || (integer && !Number.isInteger(value))) {
    fail(context, `${label} must be a${positive ? ' positive' : ''}${integer ? ' integer' : ''} number`, owner, key);
  }
  return value;
}

function boolean(value, label, context, owner, key) {
  if (typeof value !== 'boolean') fail(context, `${label} must be a boolean`, owner, key);
  return value;
}

function array(value, label, context, owner, key, { min = 0, max = Infinity } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail(context, `${label} must contain ${min}${max !== Infinity ? ` to ${max}` : '+'} items`, owner, key);
  }
  return value;
}

function stringArray(value, label, context, owner, key, limits) {
  return array(value, label, context, owner, key, limits).map((item, index) => string(item, label, context, value, index));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

async function readYaml(sourcePath, code) {
  let source;
  try {
    source = await readFile(sourcePath, 'utf8');
  } catch (cause) {
    throw new ShowrunnerError(code, `Unable to read ${sourcePath}`, { path: sourcePath, cause: cause.code });
  }
  let document;
  const lineCounter = new LineCounter();
  try {
    document = parseDocument(source, { lineCounter, prettyErrors: true });
  } catch (cause) {
    const position = cause.linePos?.[0];
    throw new ShowrunnerError(code, `Invalid YAML in ${sourcePath}`, {
      path: sourcePath, line: position?.line ?? 1, column: position?.col ?? 1, cause: cause.message
    });
  }
  if (document.errors.length > 0) {
    const position = document.errors[0].linePos?.[0];
    throw new ShowrunnerError(code, `Invalid YAML in ${sourcePath}`, {
      path: sourcePath, line: position?.line ?? 1, column: position?.col ?? 1, cause: document.errors[0].message
    });
  }
  const raw = document.toJS();
  const nodes = new WeakMap();
  const parentPairs = new WeakMap();
  indexYamlNodes(raw, document.contents, nodes, parentPairs);
  return { raw, source, lineCounter, nodes, parentPairs };
}

function normalizePosition(raw, label, context, owner, key) {
  exactKeys(raw, new Set(['x', 'y', 'z']), label, context, owner, key);
  return {
    x: number(raw.x, `${label}.x`, context, raw, 'x'),
    y: number(raw.y, `${label}.y`, context, raw, 'y'),
    z: number(raw.z, `${label}.z`, context, raw, 'z')
  };
}

function normalizeFacing(raw, label, context, owner, key) {
  exactKeys(raw, new Set(['yaw', 'pitch']), label, context, owner, key);
  return {
    yaw: number(raw.yaw, `${label}.yaw`, context, raw, 'yaw'),
    pitch: number(raw.pitch, `${label}.pitch`, context, raw, 'pitch')
  };
}

function normalizeMark(raw, name, dimension, context, marks) {
  exactKeys(raw, new Set(['position', 'facing', 'radius', 'dwell_ticks', 'safe_headroom']), `mark ${name}`, context, marks, name);
  const safeHeadroom = boolean(raw.safe_headroom, `mark ${name}.safe_headroom`, context, raw, 'safe_headroom');
  if (!safeHeadroom) fail(context, `mark ${name} must require safe headroom`, raw, 'safe_headroom');
  return {
    dimension,
    position: normalizePosition(raw.position, `mark ${name}.position`, context, raw, 'position'),
    facing: normalizeFacing(raw.facing, `mark ${name}.facing`, context, raw, 'facing'),
    radius: number(raw.radius, `mark ${name}.radius`, context, raw, 'radius', { positive: true }),
    dwellTicks: number(raw.dwell_ticks, `mark ${name}.dwell_ticks`, context, raw, 'dwell_ticks', { positive: true, integer: true }),
    safeHeadroom
  };
}

function normalizeDialogueLine(raw, cueId, actorNames, marks, context, dialogue, index) {
  const required = new Set(['id', 'speaker', 'mark', 'required_intent', 'approved_variants', 'fallback_line']);
  exactKeys(raw, required, 'dialogue line', context, dialogue, index);
  const id = string(raw.id, 'dialogue line.id', context, raw, 'id');
  const speaker = string(raw.speaker, 'dialogue line.speaker', context, raw, 'speaker');
  const mark = string(raw.mark, 'dialogue line.mark', context, raw, 'mark');
  if (!actorNames.includes(speaker)) fail(context, `Unknown dialogue line speaker ${speaker}`, raw, 'speaker');
  if (!(mark in marks)) fail(context, `Unknown dialogue line mark ${mark}`, raw, 'mark');
  return {
    id,
    cueId,
    speaker,
    mark,
    requiredIntent: string(raw.required_intent, 'dialogue line.required_intent', context, raw, 'required_intent'),
    approvedVariants: stringArray(raw.approved_variants, 'dialogue line.approved_variants', context, raw, 'approved_variants', { min: 1 }),
    fallbackLine: string(raw.fallback_line, 'dialogue line.fallback_line', context, raw, 'fallback_line')
  };
}

function normalizeCue(raw, actorNames, marks, context, cues, index, schemaVersion) {
  if (schemaVersion === 1) {
    const required = new Set(['id', 'speaker', 'mark', 'required_intent', 'approved_variants', 'fallback_line', 'timeout_seconds']);
    allowedKeys(raw, new Set([...required, 'goal_id']), 'cue', context, cues, index);
    const missing = [...required].find((key) => !Object.hasOwn(raw, key));
    if (missing) fail(context, `cue is missing ${missing}`, raw, missing);
    const id = string(raw.id, 'cue.id', context, raw, 'id');
    const speaker = string(raw.speaker, 'cue.speaker', context, raw, 'speaker');
    const mark = string(raw.mark, 'cue.mark', context, raw, 'mark');
    if (!actorNames.includes(speaker)) fail(context, `Unknown cue speaker ${speaker}`, raw, 'speaker');
    if (!(mark in marks)) fail(context, `Unknown cue mark ${mark}`, raw, 'mark');
    return {
      id, speaker, mark,
      requiredIntent: string(raw.required_intent, 'cue.required_intent', context, raw, 'required_intent'),
      approvedVariants: stringArray(raw.approved_variants, 'cue.approved_variants', context, raw, 'approved_variants', { min: 1 }),
      fallbackLine: string(raw.fallback_line, 'cue.fallback_line', context, raw, 'fallback_line'),
      timeoutSeconds: number(raw.timeout_seconds, 'cue.timeout_seconds', context, raw, 'timeout_seconds', { positive: true }),
      ...(raw.goal_id === undefined ? {} : { goalId: string(raw.goal_id, 'cue.goal_id', context, raw, 'goal_id') })
    };
  }

  const required = new Set(['id', 'survival_beat_id', 'survival_goal_ids', 'dialogue', 'timeout_seconds']);
  exactKeys(raw, required, 'cue', context, cues, index);
  const id = string(raw.id, 'cue.id', context, raw, 'id');
  const survivalBeatId = string(raw.survival_beat_id, 'cue.survival_beat_id', context, raw, 'survival_beat_id');
  if (survivalBeatId !== id) {
    fail(context, 'schema-v2 cues must bind their id to the same Survival beat', raw, 'survival_beat_id');
  }
  const survivalGoalIds = stringArray(raw.survival_goal_ids, 'cue.survival_goal_ids', context, raw, 'survival_goal_ids');
  if (new Set(survivalGoalIds).size !== survivalGoalIds.length) {
    fail(context, 'cue.survival_goal_ids must be unique', raw, 'survival_goal_ids');
  }
  const rawDialogue = array(raw.dialogue, 'cue.dialogue', context, raw, 'dialogue', { min: 1 });
  const dialogue = rawDialogue.map((line, lineIndex) => normalizeDialogueLine(
    line, id, actorNames, marks, context, rawDialogue, lineIndex
  ));
  if (new Set(dialogue.map((line) => line.id)).size !== dialogue.length) {
    fail(context, 'dialogue line ids must be unique within a cue', raw, 'dialogue');
  }
  return {
    id,
    survivalBeatId,
    survivalGoalIds,
    dialogue,
    timeoutSeconds: number(raw.timeout_seconds, 'cue.timeout_seconds', context, raw, 'timeout_seconds', { positive: true })
  };
}

function normalizeEpisode(raw, context) {
  exactKeys(raw, EPISODE_KEYS, '$', context);
  if (![1, 2].includes(raw.schema_version)) fail(context, 'Unsupported episode schema version', raw, 'schema_version');
  const schemaVersion = raw.schema_version;
  exactKeys(raw.actors, new Set(['hero', 'rival']), 'actors', context, raw, 'actors');
  const actors = Object.fromEntries(Object.entries(raw.actors).map(([name, profilePath]) => [name, {
    profilePath: string(profilePath, `actors.${name}`, context, raw.actors, name)
  }]));
  exactKeys(raw.set, new Set(['id', 'baseline_manifest']), 'set', context, raw, 'set');
  exactKeys(raw.scene, new Set(['id', 'dimension', 'marks', 'dialogue_policy', 'cues']), 'scene', context, raw, 'scene');
  const dimension = string(raw.scene.dimension, 'scene.dimension', context, raw.scene, 'dimension');
  object(raw.scene.marks, 'scene.marks', context, raw.scene, 'marks');
  const marks = Object.fromEntries(Object.entries(raw.scene.marks).map(([name, mark]) => [name, normalizeMark(mark, name, dimension, context, raw.scene.marks)]));
  if (Object.keys(marks).length < 2) fail(context, 'scene.marks must include both actor marks', raw.scene, 'marks');
  exactKeys(raw.scene.dialogue_policy, new Set(['maximum_words_per_line', 'forbidden_literals', 'forbidden_patterns', 'allow_overlap']), 'scene.dialogue_policy', context, raw.scene, 'dialogue_policy');
  const rawCues = array(raw.scene.cues, 'scene.cues', context, raw.scene, 'cues', schemaVersion === 2
    ? { min: 6, max: 6 }
    : { min: 2, max: 3 });
  const cues = rawCues.map((cue, index) => normalizeCue(cue, Object.keys(actors), marks, context, rawCues, index, schemaVersion));
  if (new Set(cues.map((cue) => cue.id)).size !== cues.length) {
    const duplicateIndex = cues.findIndex((cue, index) => cues.findIndex((item) => item.id === cue.id) !== index);
    fail(context, 'cue ids must be unique', rawCues[duplicateIndex], 'id');
  }
  if (schemaVersion === 2) {
    const goalIds = cues.flatMap((cue) => cue.survivalGoalIds);
    if (new Set(goalIds).size !== goalIds.length) fail(context, 'schema-v2 survival goal ids must be globally unique', raw.scene, 'cues');
    const dialogueLineIds = cues.flatMap((cue) => cue.dialogue.map((line) => line.id));
    if (new Set(dialogueLineIds).size !== dialogueLineIds.length) {
      fail(context, 'schema-v2 dialogue line ids must be globally unique', raw.scene, 'cues');
    }
  }
  exactKeys(raw.retry, new Set(['whole_scene_attempts']), 'retry', context, raw, 'retry');
  if (![1, 2].includes(raw.retry.whole_scene_attempts)) {
    fail(context, 'whole_scene_attempts must be 1 or 2', raw.retry, 'whole_scene_attempts');
  }
  const allowOverlap = boolean(raw.scene.dialogue_policy.allow_overlap, 'dialogue_policy.allow_overlap', context, raw.scene.dialogue_policy, 'allow_overlap');
  if (allowOverlap) fail(context, 'allow_overlap must be false for the MVP', raw.scene.dialogue_policy, 'allow_overlap');
  return {
    schemaVersion, episode: string(raw.episode, 'episode', context, raw, 'episode'), title: string(raw.title, 'title', context, raw, 'title'),
    contentRating: string(raw.content_rating, 'content_rating', context, raw, 'content_rating'), actors,
    set: { id: string(raw.set.id, 'set.id', context, raw.set, 'id'), baselineManifestPath: string(raw.set.baseline_manifest, 'set.baseline_manifest', context, raw.set, 'baseline_manifest') },
    scene: {
      id: string(raw.scene.id, 'scene.id', context, raw.scene, 'id'), dimension, marks,
      dialoguePolicy: {
        maximumWordsPerLine: number(raw.scene.dialogue_policy.maximum_words_per_line, 'dialogue_policy.maximum_words_per_line', context, raw.scene.dialogue_policy, 'maximum_words_per_line', { positive: true, integer: true }),
        forbiddenLiterals: stringArray(raw.scene.dialogue_policy.forbidden_literals, 'dialogue_policy.forbidden_literals', context, raw.scene.dialogue_policy, 'forbidden_literals'),
        forbiddenPatterns: stringArray(raw.scene.dialogue_policy.forbidden_patterns, 'dialogue_policy.forbidden_patterns', context, raw.scene.dialogue_policy, 'forbidden_patterns'),
        allowOverlap
      }, cues
    },
    retry: { wholeSceneAttempts: raw.retry.whole_scene_attempts }, sourcePath: context.path
  };
}

function normalizeProfile(raw, context) {
  exactKeys(raw, PROFILE_KEYS, '$', context);
  if (raw.schema_version !== 1) fail(context, 'Unsupported profile schema version', raw, 'schema_version');
  exactKeys(raw.rehearsal, new Set(['provider', 'model', 'runtime_use', 'max_candidates', 'max_input_tokens', 'max_output_tokens', 'timeout_seconds', 'max_retries']), 'rehearsal', context, raw, 'rehearsal');
  const runtimeUse = boolean(raw.rehearsal.runtime_use, 'rehearsal.runtime_use', context, raw.rehearsal, 'runtime_use');
  if (runtimeUse) fail(context, 'rehearsal.runtime_use must be false', raw.rehearsal, 'runtime_use');
  return {
    schemaVersion: 1, actor: string(raw.actor, 'actor', context, raw, 'actor'), relationship: string(raw.relationship, 'relationship', context, raw, 'relationship'),
    voice: string(raw.voice, 'voice', context, raw, 'voice'), vocabulary: string(raw.vocabulary, 'vocabulary', context, raw, 'vocabulary'), cadence: string(raw.cadence, 'cadence', context, raw, 'cadence'), humor: string(raw.humor, 'humor', context, raw, 'humor'),
    emotionalRange: stringArray(raw.emotional_range, 'emotional_range', context, raw, 'emotional_range', { min: 1 }), sceneAttitude: string(raw.scene_attitude, 'scene_attitude', context, raw, 'scene_attitude'),
    preferredSubjects: stringArray(raw.preferred_subjects, 'preferred_subjects', context, raw, 'preferred_subjects'), forbiddenSubjects: stringArray(raw.forbidden_subjects, 'forbidden_subjects', context, raw, 'forbidden_subjects'),
    maxLineWords: number(raw.max_line_words, 'max_line_words', context, raw, 'max_line_words', { positive: true, integer: true }), positiveExamples: stringArray(raw.positive_examples, 'positive_examples', context, raw, 'positive_examples', { min: 1 }),
    rehearsal: {
      provider: string(raw.rehearsal.provider, 'rehearsal.provider', context, raw.rehearsal, 'provider'),
      model: string(raw.rehearsal.model, 'rehearsal.model', context, raw.rehearsal, 'model'), runtimeUse,
      maxCandidates: number(raw.rehearsal.max_candidates, 'rehearsal.max_candidates', context, raw.rehearsal, 'max_candidates', { positive: true, integer: true }),
      maxInputTokens: number(raw.rehearsal.max_input_tokens, 'rehearsal.max_input_tokens', context, raw.rehearsal, 'max_input_tokens', { positive: true, integer: true }), maxOutputTokens: number(raw.rehearsal.max_output_tokens, 'rehearsal.max_output_tokens', context, raw.rehearsal, 'max_output_tokens', { positive: true, integer: true }),
      timeoutSeconds: number(raw.rehearsal.timeout_seconds, 'rehearsal.timeout_seconds', context, raw.rehearsal, 'timeout_seconds', { positive: true }), maxRetries: number(raw.rehearsal.max_retries, 'rehearsal.max_retries', context, raw.rehearsal, 'max_retries', { integer: true })
    }, sourcePath: context.path
  };
}

function normalizeManifest(raw, context) {
  exactKeys(raw, MANIFEST_KEYS, '$', context);
  if (raw.schema_version !== 1) fail(context, 'Unsupported baseline schema version', raw, 'schema_version');
  const resetTimeoutMs = number(raw.reset_timeout_ms, 'reset_timeout_ms', context, raw, 'reset_timeout_ms', { positive: true, integer: true });
  if (resetTimeoutMs > 60_000) fail(context, 'reset_timeout_ms must not exceed 60000', raw, 'reset_timeout_ms');
  exactKeys(raw.protected_cuboid, new Set(['min', 'max']), 'protected_cuboid', context, raw, 'protected_cuboid');
  const protectedCuboid = {
    min: normalizePosition(raw.protected_cuboid.min, 'protected_cuboid.min', context, raw.protected_cuboid, 'min'),
    max: normalizePosition(raw.protected_cuboid.max, 'protected_cuboid.max', context, raw.protected_cuboid, 'max')
  };
  if (['x', 'y', 'z'].some((axis) => protectedCuboid.min[axis] > protectedCuboid.max[axis])) fail(context, 'protected_cuboid min must not exceed max', raw, 'protected_cuboid');
  const rawAssertions = array(raw.block_assertions, 'block_assertions', context, raw, 'block_assertions', { min: 1 });
  const blockAssertions = rawAssertions.map((assertion, index) => {
    exactKeys(assertion, new Set(['position', 'block', 'verification']), 'block_assertion', context, rawAssertions, index);
    const position = normalizePosition(assertion.position, 'block_assertion.position', context, assertion, 'position');
    if (['x', 'y', 'z'].some((axis) => position[axis] < protectedCuboid.min[axis] || position[axis] > protectedCuboid.max[axis])) {
      fail(context, 'block assertion must be inside protected_cuboid', assertion, 'position');
    }
    const verification = string(assertion.verification, 'block_assertion.verification', context, assertion, 'verification');
    if (!['authored_unverified', 'live_verified'].includes(verification)) fail(context, 'block assertion verification is invalid', assertion, 'verification');
    return { position, block: string(assertion.block, 'block_assertion.block', context, assertion, 'block'), verification };
  });
  object(raw.actor_baselines, 'actor_baselines', context, raw, 'actor_baselines');
  if (Object.keys(raw.actor_baselines).length !== 2) {
    fail(context, 'actor_baselines must contain exactly two actors', raw, 'actor_baselines');
  }
  const actorBaselines = Object.fromEntries(Object.entries(raw.actor_baselines).map(([actor, baseline]) => {
    exactKeys(baseline, new Set(['mark', 'inventory', 'health', 'food', 'effects']), `actor_baseline.${actor}`, context, raw.actor_baselines, actor);
    const health = number(baseline.health, `actor_baseline.${actor}.health`, context, baseline, 'health', { positive: true });
    const food = number(baseline.food, `actor_baseline.${actor}.food`, context, baseline, 'food', { positive: true });
    if (health !== 20) fail(context, `actor_baseline.${actor}.health must be 20 for the MVP`, baseline, 'health');
    if (food !== 20) fail(context, `actor_baseline.${actor}.food must be 20 for the MVP`, baseline, 'food');
    return [actor, {
      mark: string(baseline.mark, `actor_baseline.${actor}.mark`, context, baseline, 'mark'), inventory: array(baseline.inventory, `actor_baseline.${actor}.inventory`, context, baseline, 'inventory'),
      health, food, effects: array(baseline.effects, `actor_baseline.${actor}.effects`, context, baseline, 'effects')
    }];
  }));
  exactKeys(raw.environment, new Set(['time', 'weather', 'gamerules']), 'environment', context, raw, 'environment');
  object(raw.environment.gamerules, 'environment.gamerules', context, raw.environment, 'gamerules');
  for (const [name, value] of Object.entries(raw.environment.gamerules)) boolean(value, `environment.gamerules.${name}`, context, raw.environment.gamerules, name);
  if (raw.environment.gamerules.doDaylightCycle !== false) {
    fail(context, 'environment.gamerules.doDaylightCycle must be false for the MVP', raw.environment.gamerules, 'doDaylightCycle');
  }
  const weather = string(raw.environment.weather, 'environment.weather', context, raw.environment, 'weather');
  if (!['clear', 'rain', 'thunder'].includes(weather)) fail(context, 'environment.weather is invalid', raw.environment, 'weather');
  return {
    schemaVersion: 1, setId: string(raw.set_id, 'set_id', context, raw, 'set_id'), setVersion: number(raw.set_version, 'set_version', context, raw, 'set_version', { positive: true, integer: true }), dimension: string(raw.dimension, 'dimension', context, raw, 'dimension'),
    protectedCuboid, blockAssertions, actorBaselines,
    environment: { time: number(raw.environment.time, 'environment.time', context, raw.environment, 'time', { integer: true }), weather, gamerules: raw.environment.gamerules },
    entityCleanupTag: string(raw.entity_cleanup_tag, 'entity_cleanup_tag', context, raw, 'entity_cleanup_tag'),
    resetTimeoutMs,
    sourcePath: context.path
  };
}

export async function loadProfile(sourcePath) {
  const resolvedPath = path.resolve(sourcePath);
  const yaml = await readYaml(resolvedPath, ERROR_CODES.PROFILE_YAML_INVALID);
  return deepFreeze(normalizeProfile(yaml.raw, { code: ERROR_CODES.PROFILE_SCHEMA_INVALID, path: resolvedPath, ...yaml }));
}

export async function loadBaselineManifest(sourcePath) {
  const resolvedPath = path.resolve(sourcePath);
  let raw;
  let source;
  try {
    source = await readFile(resolvedPath, 'utf8');
    raw = JSON.parse(source);
  } catch (cause) {
    throw new ShowrunnerError(ERROR_CODES.BASELINE_MANIFEST_INVALID, `Invalid baseline manifest ${resolvedPath}`, { path: resolvedPath, cause: cause.code ?? cause.message });
  }
  return deepFreeze(normalizeManifest(raw, { code: ERROR_CODES.BASELINE_MANIFEST_INVALID, path: resolvedPath, source }));
}

export async function loadEpisode(sourcePath) {
  const resolvedPath = path.resolve(sourcePath);
  const yaml = await readYaml(resolvedPath, ERROR_CODES.EPISODE_YAML_INVALID);
  const episode = normalizeEpisode(yaml.raw, { code: ERROR_CODES.EPISODE_SCHEMA_INVALID, path: resolvedPath, ...yaml });
  try {
    for (const [actor, value] of Object.entries(episode.actors)) {
      const profile = await loadProfile(path.resolve(path.dirname(resolvedPath), value.profilePath));
      if (profile.actor !== actor) throw new ShowrunnerError(ERROR_CODES.EPISODE_REFERENCE_INVALID, `Profile actor does not match ${actor}`, { path: profile.sourcePath });
      value.profile = profile;
      value.profilePath = profile.sourcePath;
    }
    const baselineManifest = await loadBaselineManifest(path.resolve(path.dirname(resolvedPath), episode.set.baselineManifestPath));
    if (baselineManifest.setId !== episode.set.id || baselineManifest.dimension !== episode.scene.dimension) {
      throw new ShowrunnerError(ERROR_CODES.EPISODE_REFERENCE_INVALID, 'Episode set does not match its baseline manifest', { path: baselineManifest.sourcePath });
    }
    const episodeActors = Object.keys(episode.actors).sort();
    const baselineActors = Object.keys(baselineManifest.actorBaselines).sort();
    if (episodeActors.length !== baselineActors.length || episodeActors.some((actor, index) => actor !== baselineActors[index])) {
      throw new ShowrunnerError(ERROR_CODES.EPISODE_REFERENCE_INVALID, 'Baseline actor set must exactly match episode actors', { path: baselineManifest.sourcePath });
    }
    for (const actor of Object.keys(episode.actors)) {
      const baseline = baselineManifest.actorBaselines[actor];
      if (!baseline || !(baseline.mark in episode.scene.marks)) {
        throw new ShowrunnerError(ERROR_CODES.EPISODE_REFERENCE_INVALID, `Baseline is missing a valid mark for ${actor}`, { path: baselineManifest.sourcePath });
      }
    }
    episode.set.baselineManifest = baselineManifest;
    episode.set.baselineManifestPath = baselineManifest.sourcePath;
  } catch (cause) {
    if (cause instanceof ShowrunnerError && cause.code === ERROR_CODES.EPISODE_REFERENCE_INVALID) throw cause;
    throw new ShowrunnerError(ERROR_CODES.EPISODE_REFERENCE_INVALID, `Unable to resolve episode asset for ${resolvedPath}`, { path: resolvedPath, cause: cause.code ?? cause.message });
  }
  return deepFreeze(episode);
}
