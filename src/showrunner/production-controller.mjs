import { randomUUID } from 'node:crypto';

const ACTOR_NAME = /^[A-Za-z0-9_]{1,16}$/;
const RESOURCE_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const GAMERULE_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const PRODUCTION_TAG = /^[A-Za-z0-9_.+-]{1,64}$/;
const SAMPLE_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const CHECKSUM = /^[a-f0-9]{64}$/;
const WEATHER = new Set(['clear', 'rain', 'thunder']);
const STABILIZING_GAMERULES = new Set(['doDaylightCycle', 'doWeatherCycle']);

function coded(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function object(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw coded(code);
  return value;
}

function exactKeys(value, allowed, code) {
  object(value, code);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw coded(code);
}

function iterableValues(value, code) {
  if (Array.isArray(value) || value instanceof Set) return [...value];
  throw coded(code);
}

function frozenSet(value, code) {
  return new Set(iterableValues(value, code));
}

function finite(value, code, minimum, maximum, { integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    throw coded(code);
  }
  return Object.is(value, -0) ? 0 : value;
}

function actorName(value) {
  if (typeof value !== 'string' || !ACTOR_NAME.test(value)) throw coded('INVALID_ACTOR_NAME');
  return value;
}

function resourceId(value, code) {
  if (typeof value !== 'string' || !RESOURCE_ID.test(value)) throw coded(code);
  return value;
}

function productionTag(value) {
  if (typeof value !== 'string' || !PRODUCTION_TAG.test(value)) throw coded('INVALID_PRODUCTION_TAG');
  return value;
}

function normalizePosition(value) {
  object(value, 'INVALID_COORDINATE');
  return Object.freeze({
    x: finite(value.x, 'INVALID_COORDINATE', -30_000_000, 30_000_000),
    y: finite(value.y, 'INVALID_COORDINATE', -64, 320),
    z: finite(value.z, 'INVALID_COORDINATE', -30_000_000, 30_000_000)
  });
}

function normalizeFacing(value) {
  object(value, 'INVALID_FACING');
  return Object.freeze({
    yaw: finite(value.yaw, 'INVALID_FACING', -180, 180),
    pitch: finite(value.pitch, 'INVALID_FACING', -90, 90)
  });
}

function normalizeMark(value, allowedDimensions) {
  object(value, 'INVALID_MARK');
  const dimension = resourceId(value.dimension, 'INVALID_DIMENSION');
  if (!allowedDimensions.has(dimension)) throw coded('DIMENSION_NOT_ALLOWED');
  if (value.safeHeadroom !== true) throw coded('UNSAFE_HEADROOM');
  return Object.freeze({
    dimension,
    position: normalizePosition(value.position),
    facing: normalizeFacing(value.facing),
    safeHeadroom: true
  });
}

function normalizeInventory(value, allowedItems) {
  if (!Array.isArray(value) || value.length > 36) throw coded('INVALID_INVENTORY');
  return Object.freeze(value.map((entry) => {
    object(entry, 'INVALID_INVENTORY');
    const item = resourceId(entry.item, 'INVALID_ITEM_ID');
    if (!allowedItems.has(item)) throw coded('ITEM_NOT_ALLOWED');
    const count = finite(entry.count, 'INVALID_ITEM_COUNT', 1, 64, { integer: true });
    return Object.freeze({ item, count });
  }));
}

function normalizeEffects(value, allowedEffects) {
  if (!Array.isArray(value) || value.length > 32) throw coded('INVALID_EFFECTS');
  return Object.freeze(value.map((entry) => {
    object(entry, 'INVALID_EFFECT');
    const id = resourceId(entry.id, 'INVALID_EFFECT_ID');
    if (!allowedEffects.has(id)) throw coded('EFFECT_NOT_ALLOWED');
    return Object.freeze({
      id,
      durationSeconds: finite(entry.durationSeconds, 'INVALID_EFFECT_DURATION', 1, 1_000_000, { integer: true }),
      amplifier: finite(entry.amplifier, 'INVALID_EFFECT_AMPLIFIER', 0, 255, { integer: true })
    });
  }));
}

function normalizeBaseline(value, allowlist, markOverride) {
  object(value, 'INVALID_ACTOR_BASELINE');
  const actor = actorName(value.actor);
  if (!allowlist.actors.has(actor)) throw coded('ACTOR_NOT_ALLOWED');
  const mark = normalizeMark(markOverride ?? value.mark, allowlist.dimensions);
  if (value.health !== 20) throw coded('UNSUPPORTED_HEALTH_BASELINE');
  if (value.food !== 20) throw coded('UNSUPPORTED_FOOD_BASELINE');
  return Object.freeze({
    actor, mark,
    inventory: normalizeInventory(value.inventory, allowlist.items),
    health: 20, food: 20,
    effects: normalizeEffects(value.effects, allowlist.effects)
  });
}

function normalizeEnvironment(value, dimension, allowlist) {
  object(value, 'INVALID_ENVIRONMENT');
  const normalizedDimension = resourceId(dimension, 'INVALID_DIMENSION');
  if (!allowlist.dimensions.has(normalizedDimension)) throw coded('DIMENSION_NOT_ALLOWED');
  const time = finite(value.time, 'INVALID_TIME', 0, 24_000, { integer: true });
  if (!WEATHER.has(value.weather)) throw coded('INVALID_WEATHER');
  object(value.gamerules, 'INVALID_GAMERULES');
  const gamerules = {};
  for (const [name, enabled] of Object.entries(value.gamerules)) {
    if (!GAMERULE_NAME.test(name)) throw coded('INVALID_GAMERULE');
    if (!allowlist.gamerules.has(name)) throw coded('GAMERULE_NOT_ALLOWED');
    if (typeof enabled !== 'boolean') throw coded('INVALID_GAMERULE_VALUE');
    gamerules[name] = enabled;
  }
  if (gamerules.doDaylightCycle !== false) throw coded('UNSTABLE_DAYLIGHT_CYCLE');
  return Object.freeze({ dimension: normalizedDimension, time, weather: value.weather, gamerules: Object.freeze(gamerules) });
}

function normalizeBlockAssertions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4096) throw coded('INVALID_BLOCK_ASSERTIONS');
  return Object.freeze(value.map((assertion) => {
    object(assertion, 'INVALID_BLOCK_ASSERTION');
    return Object.freeze({
      position: normalizePosition(assertion.position),
      block: resourceId(assertion.block, 'INVALID_BLOCK_ID')
    });
  }));
}

function normalizeChecksumSamples(value = []) {
  if (!Array.isArray(value) || value.length > 4096) throw coded('INVALID_CHECKSUM_SAMPLES');
  const ids = new Set();
  return Object.freeze(value.map((sample) => {
    object(sample, 'INVALID_CHECKSUM_SAMPLE');
    if (typeof sample.id !== 'string' || !SAMPLE_ID.test(sample.id) || ids.has(sample.id)) throw coded('INVALID_CHECKSUM_SAMPLE');
    if (typeof sample.checksum !== 'string' || !CHECKSUM.test(sample.checksum)) throw coded('INVALID_CHECKSUM_SAMPLE');
    ids.add(sample.id);
    return Object.freeze({ id: sample.id, checksum: sample.checksum });
  }));
}

function equal(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeAllowlist(input) {
  object(input, 'ALLOWLIST_REQUIRED');
  const dimensions = frozenSet(input.dimensions, 'DIMENSION_ALLOWLIST_REQUIRED');
  const actors = frozenSet(input.actors, 'ACTOR_ALLOWLIST_REQUIRED');
  const gamerules = frozenSet(input.gamerules, 'GAMERULE_ALLOWLIST_REQUIRED');
  const items = frozenSet(input.items, 'ITEM_ALLOWLIST_REQUIRED');
  const effects = frozenSet(input.effects ?? [], 'EFFECT_ALLOWLIST_REQUIRED');
  const tags = frozenSet(input.tags, 'TAG_ALLOWLIST_REQUIRED');
  for (const actor of actors) actorName(actor);
  for (const dimension of dimensions) resourceId(dimension, 'INVALID_DIMENSION');
  for (const gamerule of gamerules) if (typeof gamerule !== 'string' || !GAMERULE_NAME.test(gamerule)) throw coded('INVALID_GAMERULE');
  for (const item of items) resourceId(item, 'INVALID_ITEM_ID');
  for (const effect of effects) resourceId(effect, 'INVALID_EFFECT_ID');
  for (const tag of tags) productionTag(tag);
  object(input.marks ?? {}, 'INVALID_MARK_ALLOWLIST');
  const marks = Object.create(null);
  for (const [name, mark] of Object.entries(input.marks ?? {})) {
    if (!SAMPLE_ID.test(name)) throw coded('INVALID_MARK_ID');
    marks[name] = normalizeMark(mark, dimensions);
  }
  return Object.freeze({ actors, dimensions, gamerules, items, effects, tags, marks: Object.freeze(marks) });
}

function event(emit, kind, commandKind, details = {}, context = {}, causalSequence) {
  const identity = Object.fromEntries(['productionId', 'takeId', 'sceneId', 'beatId', 'attemptId', 'cueId']
    .filter((field) => typeof context?.[field] === 'string')
    .map((field) => [field, context[field]]));
  emit(Object.freeze({
    kind, commandKind, ...identity, eventId: randomUUID(), causalSequence,
    monotonicTimestamp: performance.now(), ...details
  }));
}

function validateReceipt(receipt) {
  if (receipt?.acknowledged !== true) throw coded('TRANSPORT_NOT_ACKNOWLEDGED');
  if (receipt?.completed !== true) throw coded('TRANSPORT_NOT_COMPLETED');
  return receipt;
}

function mismatchesFor(manifest, observation) {
  const mismatches = [];
  for (const [actor, baseline] of Object.entries(manifest.actorBaselines)) {
    const observed = observation.actors?.[actor];
    if (observed?.dimension !== baseline.mark.dimension) mismatches.push({ kind: 'actor_dimension', actor });
    if (!equal(observed?.position, baseline.mark.position)) mismatches.push({ kind: 'actor_position', actor });
    if (!equal(observed?.facing, baseline.mark.facing)) mismatches.push({ kind: 'actor_facing', actor });
    if (observed?.safeHeadroom !== true) mismatches.push({ kind: 'actor_headroom', actor });
    if (!equal(observed?.inventory, baseline.inventory)) mismatches.push({ kind: 'actor_inventory', actor });
    if (observed?.health !== baseline.health) mismatches.push({ kind: 'actor_health', actor });
    if (observed?.food !== baseline.food) mismatches.push({ kind: 'actor_food', actor });
    if (!equal(observed?.effects, baseline.effects)) mismatches.push({ kind: 'actor_effects', actor });
  }
  manifest.blockAssertions.forEach((assertion, index) => {
    const observed = observation.blocks?.[index];
    if (!equal(observed?.position, assertion.position) || observed?.block !== assertion.block) {
      mismatches.push({ kind: 'block_assertion', index });
    }
  });
  for (const sample of manifest.checksumSamples) {
    if (observation.checksums?.[sample.id] !== sample.checksum) mismatches.push({ kind: 'checksum_sample', id: sample.id });
  }
  if (observation.taggedEntityCount !== 0) mismatches.push({ kind: 'tagged_entities' });
  const observedEnvironment = observation.environment;
  const environmentMatches = observedEnvironment?.time === manifest.environment.time &&
    observedEnvironment?.weather === manifest.environment.weather &&
    Object.entries(manifest.environment.gamerules).every(([name, value]) => observedEnvironment?.gamerules?.[name] === value);
  if (!environmentMatches) mismatches.push({ kind: 'environment' });
  return mismatches;
}

/**
 * Privileged, fixed-template command adapter. It accepts typed values only and
 * never exposes raw command execution or caller-provided selectors.
 */
export function createProductionController({ transport, allowlist: inputAllowlist, emit = () => {}, eventContext } = {}) {
  if (typeof transport?.execute !== 'function') throw coded('TRANSPORT_REQUIRED');
  if (typeof emit !== 'function') throw coded('EMITTER_INVALID');
  const allowlist = normalizeAllowlist(inputAllowlist);
  let eventSequence = 0;
  const resolveEventContext = (supplied) => {
    const context = supplied ?? eventContext?.();
    const snapshot = {};
    for (const field of ['productionId', 'takeId', 'sceneId', 'beatId', 'attemptId', 'cueId']) {
      if (typeof context?.[field] !== 'string' || context[field].length === 0) throw coded('CONTROLLER_EVENT_IDENTITY_REQUIRED', { field });
      snapshot[field] = context[field];
    }
    return Object.freeze(snapshot);
  };
  const controllerEvent = (kind, commandKind, details, context) => {
    const identity = resolveEventContext(context);
    eventSequence += 1;
    event(emit, kind, commandKind, details, identity, eventSequence);
  };

  async function run(commandKind, command, context) {
    const identity = resolveEventContext(context);
    controllerEvent('command_issued', commandKind, { command }, identity);
    try {
      const receipt = validateReceipt(await transport.execute(command));
      controllerEvent('command_acknowledged', commandKind, {}, identity);
      controllerEvent('command_completed', commandKind, {}, identity);
      return receipt;
    } catch (cause) {
      controllerEvent('command_failed', commandKind, { code: cause?.code ?? 'TRANSPORT_FAILURE' }, identity);
      if (cause?.code) throw cause;
      throw coded('TRANSPORT_FAILURE', { cause: cause?.message });
    }
  }

  async function teleportActor(input, context) {
    object(input, 'INVALID_TELEPORT');
    const actor = actorName(input.actor);
    if (!allowlist.actors.has(actor)) throw coded('ACTOR_NOT_ALLOWED');
    const mark = normalizeMark(input.mark, allowlist.dimensions);
    const { x, y, z } = mark.position;
    const { yaw, pitch } = mark.facing;
    return run('teleportActor', `execute in ${mark.dimension} run tp ${actor} ${x} ${y} ${z} ${yaw} ${pitch}`, context);
  }

  async function restoreActor(input, context) {
    context = resolveEventContext(context);
    const baseline = normalizeBaseline(input, allowlist);
    await teleportActor({ actor: baseline.actor, mark: baseline.mark }, context);
    await run('restoreActor', `clear ${baseline.actor}`, context);
    for (const item of baseline.inventory) await run('restoreActor', `give ${baseline.actor} ${item.item} ${item.count}`, context);
    await run('restoreActor', `effect clear ${baseline.actor}`, context);
    await run('restoreActor', `effect give ${baseline.actor} minecraft:instant_health 1 255 true`, context);
    await run('restoreActor', `effect give ${baseline.actor} minecraft:saturation 1 255 true`, context);
    for (const effect of baseline.effects) {
      await run('restoreActor', `effect give ${baseline.actor} ${effect.id} ${effect.durationSeconds} ${effect.amplifier} true`, context);
    }
    return Object.freeze({ acknowledged: true, completed: true });
  }

  async function setEnvironment(input, context) {
    context = resolveEventContext(context);
    object(input, 'INVALID_ENVIRONMENT');
    const environment = normalizeEnvironment(input, input.dimension, allowlist);
    const entries = Object.entries(environment.gamerules);
    const stabilizers = entries.filter(([name, value]) => STABILIZING_GAMERULES.has(name) && value === false);
    const remaining = entries.filter(([name, value]) => !STABILIZING_GAMERULES.has(name) || value !== false);
    for (const [name, value] of stabilizers) {
      await run('setEnvironment', `execute in ${environment.dimension} run gamerule ${name} ${value}`, context);
    }
    await run('setEnvironment', `execute in ${environment.dimension} run time set ${environment.time}`, context);
    await run('setEnvironment', `execute in ${environment.dimension} run weather ${environment.weather}`, context);
    for (const [name, value] of remaining) {
      await run('setEnvironment', `execute in ${environment.dimension} run gamerule ${name} ${value}`, context);
    }
    return Object.freeze({ acknowledged: true, completed: true });
  }

  async function removeTaggedEntities(input, context) {
    const tag = productionTag(typeof input === 'string' ? input : input?.tag);
    if (!allowlist.tags.has(tag)) throw coded('PRODUCTION_TAG_NOT_ALLOWED');
    return run('removeTaggedEntities', `kill @e[tag=${tag}]`, context);
  }

  function normalizeManifest(manifest) {
    object(manifest, 'INVALID_BASELINE_MANIFEST');
    const dimension = resourceId(manifest.dimension, 'INVALID_DIMENSION');
    if (!allowlist.dimensions.has(dimension)) throw coded('DIMENSION_NOT_ALLOWED');
    object(manifest.actorBaselines, 'INVALID_ACTOR_BASELINES');
    const declaredActors = Object.keys(manifest.actorBaselines).sort();
    const allowedActors = [...allowlist.actors].sort();
    if (!equal(declaredActors, allowedActors)) throw coded('ACTOR_BASELINE_MISMATCH');
    const actorBaselines = {};
    for (const [actor, value] of Object.entries(manifest.actorBaselines)) {
      exactKeys(value, new Set(['mark', 'inventory', 'health', 'food', 'effects']), 'INVALID_ACTOR_BASELINE');
      if (typeof value.mark !== 'string' || !Object.hasOwn(allowlist.marks, value.mark)) throw coded('MARK_NOT_ALLOWED');
      const baseline = normalizeBaseline({ ...value, actor }, allowlist, allowlist.marks[value.mark]);
      if (baseline.mark.dimension !== dimension) throw coded('BASELINE_DIMENSION_MISMATCH');
      actorBaselines[actor] = baseline;
    }
    if (Object.keys(actorBaselines).length === 0) throw coded('INVALID_ACTOR_BASELINES');
    const tag = productionTag(manifest.entityCleanupTag);
    if (!allowlist.tags.has(tag)) throw coded('PRODUCTION_TAG_NOT_ALLOWED');
    return Object.freeze({
      dimension,
      actorBaselines: Object.freeze(actorBaselines),
      blockAssertions: normalizeBlockAssertions(manifest.blockAssertions),
      checksumSamples: normalizeChecksumSamples(manifest.checksumSamples),
      environment: normalizeEnvironment(manifest.environment, dimension, allowlist),
      entityCleanupTag: tag
    });
  }

  async function restore(manifest, context) {
    context = resolveEventContext(context);
    const normalized = normalizeManifest(manifest);
    for (const baseline of Object.values(normalized.actorBaselines)) await restoreActor(baseline, context);
    await setEnvironment(normalized.environment, context);
    return Object.freeze({ acknowledged: true, completed: true });
  }

  async function verifySet(manifest, context) {
    context = resolveEventContext(context);
    if (typeof transport.observe !== 'function') throw coded('VERIFICATION_TRANSPORT_REQUIRED');
    const normalized = normalizeManifest(manifest);
    const query = Object.freeze({
      kind: 'verifySet',
      dimension: normalized.dimension,
      actors: Object.freeze(Object.fromEntries(Object.entries(normalized.actorBaselines).map(([actor, baseline]) => [actor, Object.freeze({
        dimension: baseline.mark.dimension, position: baseline.mark.position, facing: baseline.mark.facing, safeHeadroom: true,
        inventory: baseline.inventory, health: baseline.health, food: baseline.food, effects: baseline.effects
      })]))),
      blockAssertions: normalized.blockAssertions,
      checksumSamples: normalized.checksumSamples,
      environment: normalized.environment,
      entityCleanupTag: normalized.entityCleanupTag
    });
    controllerEvent('command_issued', 'verifySet', {}, context);
    let receipt;
    try {
      receipt = validateReceipt(await transport.observe(query));
    } catch (cause) {
      controllerEvent('command_failed', 'verifySet', { code: cause?.code ?? 'TRANSPORT_FAILURE' }, context);
      if (cause?.code) throw cause;
      throw coded('TRANSPORT_FAILURE', { cause: cause?.message });
    }
    if (receipt.observation === null || typeof receipt.observation !== 'object' || Array.isArray(receipt.observation)) {
      throw coded('VERIFICATION_TELEMETRY_REQUIRED');
    }
    const mismatches = mismatchesFor(normalized, receipt.observation);
    controllerEvent('observation_verified', 'verifySet', { ok: mismatches.length === 0 }, context);
    return Object.freeze({ ok: mismatches.length === 0, mismatches: Object.freeze(mismatches) });
  }

  async function emergencyStop({ attempt, actors = [] } = {}) {
    if (typeof attempt?.revoke !== 'function' || typeof attempt?.id !== 'string') throw coded('ATTEMPT_REQUIRED');
    if (!Array.isArray(actors) || actors.some((actor) => typeof actor?.cancel !== 'function')) throw coded('ACTORS_INVALID');
    attempt.revoke('emergency-stop');
    await Promise.all(actors.map((actor) => actor.cancel(attempt.id)));
    return Object.freeze({ revoked: true });
  }

  async function execute(command) {
    object(command, 'COMMAND_INVALID');
    const handlers = Object.freeze({ teleportActor, restoreActor, setEnvironment, removeTaggedEntities, verifySet, emergencyStop });
    if (!Object.hasOwn(handlers, command.kind)) throw coded('COMMAND_KIND_NOT_ALLOWED');
    const context = resolveEventContext(command);
    return handlers[command.kind](command.payload, context);
  }

  return Object.freeze({
    execute, teleportActor, restoreActor, setEnvironment, removeTaggedEntities,
    verifySet, emergencyStop, restore, verify: verifySet
  });
}
