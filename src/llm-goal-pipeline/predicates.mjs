import { resolvePredicate } from './registry.mjs';

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw coded('PIPELINE_OBSERVATION_INVALID', `${label} is not a finite observation value`);
  }
  return value;
}

function actor(snapshot) {
  if (!snapshot?.actor || typeof snapshot.actor !== 'object' || Array.isArray(snapshot.actor)) {
    throw coded('PIPELINE_OBSERVATION_INVALID', 'actor observation is invalid');
  }
  return snapshot.actor;
}

function array(value, label) {
  if (!Array.isArray(value)) throw coded('PIPELINE_OBSERVATION_INVALID', `${label} observation is invalid`);
  return value;
}

function fact(ok, value, proofKind) {
  return { ok, facts: [value], proofKinds: ok ? [proofKind] : [] };
}

function boolean(value, label) {
  if (typeof value !== 'boolean') throw coded('PIPELINE_OBSERVATION_INVALID', `${label} observation is invalid`);
  return value;
}

function inventoryCount(snapshot, item) {
  const inventory = actor(snapshot).inventory;
  if (!inventory || typeof inventory !== 'object' || Array.isArray(inventory)) {
    throw coded('PIPELINE_OBSERVATION_INVALID', 'inventory observation is invalid');
  }
  return finite(inventory[item] ?? 0, `inventory.${item}`);
}

function leaf(entry, expression, snapshot, context) {
  const id = entry.id;
  if (id === 'actor_alive') {
    const actual = boolean(actor(snapshot).alive, 'actor.alive');
    return fact(actual, { predicate: id, actual, required: true }, id);
  }
  if (id === 'actor_connected') {
    const actual = boolean(actor(snapshot).connected, 'actor.connected');
    return fact(actual, { predicate: id, actual, required: true }, id);
  }
  if (id === 'health_at_least' || id === 'hunger_at_least') {
    const field = id === 'health_at_least' ? 'health' : 'hunger';
    const actual = finite(actor(snapshot)[field], `actor.${field}`);
    return fact(actual >= expression.value,
      { predicate: id, actual, required: expression.value }, `${id}:${expression.value}`);
  }
  if (id === 'in_dimension' || id === 'in_region') {
    const field = id === 'in_dimension' ? 'dimension' : 'region';
    const actual = actor(snapshot)[field];
    if (typeof actual !== 'string') throw coded('PIPELINE_OBSERVATION_INVALID', `actor.${field} observation is invalid`);
    const required = expression[field];
    return fact(actual === required, { predicate: id, actual, required }, `${id}:${required}`);
  }
  if (id === 'inventory_at_least') {
    const actual = inventoryCount(snapshot, expression.item);
    return fact(actual >= expression.count,
      { predicate: id, item: expression.item, actual, required: expression.count }, `${id}:${expression.item}`);
  }
  if (id === 'equipped_item') {
    const actual = actor(snapshot).equippedItem ?? null;
    if (actual !== null && typeof actual !== 'string') throw coded('PIPELINE_OBSERVATION_INVALID', 'equipped item observation is invalid');
    return fact(actual === expression.item,
      { predicate: id, item: expression.item, actual, required: expression.item }, `${id}:${expression.item}`);
  }
  if (id === 'block_exists' || id === 'entity_exists') {
    const collection = array(snapshot[id === 'block_exists' ? 'blocks' : 'entities'], id);
    const field = id === 'block_exists' ? 'block' : 'entity';
    const matching = collection.filter((entryValue) => entryValue?.[field] === expression[field]);
    for (const entryValue of matching) finite(entryValue.distance, `${id}.distance`);
    const nearest = matching.reduce((value, entryValue) => Math.min(value, entryValue.distance), Infinity);
    return fact(nearest <= expression.radius,
      { predicate: id, [field]: expression[field], nearest: Number.isFinite(nearest) ? nearest : null, radius: expression.radius },
      `${id}:${expression[field]}`);
  }
  if (id === 'target_state') {
    const target = array(snapshot.targets, 'targets').find((entryValue) => entryValue?.targetId === expression.targetId);
    const actual = target?.state ?? null;
    return fact(actual === expression.state,
      { predicate: id, targetId: expression.targetId, actual, required: expression.state }, `${id}:${expression.targetId}:${expression.state}`);
  }
  if (id === 'landmark_visible' || id === 'landmark_reached') {
    const landmark = array(snapshot.landmarks, 'landmarks').find((entryValue) => entryValue?.reference === expression.reference);
    const field = id === 'landmark_visible' ? 'visible' : 'reached';
    const actual = landmark ? boolean(landmark[field], `landmark.${field}`) : false;
    return fact(actual, { predicate: id, reference: expression.reference, actual, required: true }, `${id}:${expression.reference}`);
  }
  if (id === 'recipe_available') {
    const actual = array(snapshot.recipes, 'recipes').includes(expression.recipe);
    return fact(actual, { predicate: id, recipe: expression.recipe, actual, required: true }, `${id}:${expression.recipe}`);
  }
  if (id === 'time_of_day' || id === 'weather') {
    const field = id === 'time_of_day' ? 'timeOfDay' : 'weather';
    const actual = snapshot[field];
    if (typeof actual !== 'string') throw coded('PIPELINE_OBSERVATION_INVALID', `${field} observation is invalid`);
    return fact(actual === expression.category,
      { predicate: id, actual, required: expression.category }, `${id}:${expression.category}`);
  }
  if (id === 'hostile_threat') {
    const actual = array(snapshot.entities, 'entities').some((entryValue) => entryValue?.hostile === true);
    return fact(actual === expression.exists,
      { predicate: id, actual, required: expression.exists }, `${id}:${expression.exists}`);
  }
  if (id === 'container_contains') {
    const container = array(snapshot.containers, 'containers').find((entryValue) => entryValue?.containerId === expression.containerId);
    const actual = container ? finite(container.items?.[expression.item] ?? 0, 'container item count') : 0;
    return fact(actual >= expression.count,
      { predicate: id, containerId: expression.containerId, item: expression.item, actual, required: expression.count },
      `${id}:${expression.containerId}:${expression.item}`);
  }
  if (id === 'blueprint_complete') {
    const blueprint = array(snapshot.blueprints, 'blueprints').find((entryValue) => entryValue?.blueprintId === expression.blueprintId);
    const actual = blueprint ? boolean(blueprint.complete, 'blueprint.complete') : false;
    return fact(actual, { predicate: id, blueprintId: expression.blueprintId, actual, required: true }, `${id}:${expression.blueprintId}`);
  }
  if (id === 'outcome_proof') {
    const outcomes = array(context.outcomes ?? [], 'outcomes');
    const actual = outcomes.some((outcome) => Array.isArray(outcome?.proofKinds) && outcome.proofKinds.includes(expression.proofKind));
    return fact(actual, { predicate: id, proofKind: expression.proofKind, actual, required: true }, `${id}:${expression.proofKind}`);
  }
  throw coded('PIPELINE_PREDICATE_INVALID', 'predicate has no evaluator');
}

function combineAll(results) {
  return {
    ok: results.every((result) => result.ok),
    facts: results.flatMap((result) => result.facts),
    proofKinds: results.flatMap((result) => result.proofKinds)
  };
}

function combineAny(results) {
  const successful = results.find((result) => result.ok);
  return successful ?? { ok: false, facts: results.flatMap((result) => result.facts), proofKinds: [] };
}

function invert(result) {
  const ok = !result.ok;
  return {
    ok,
    facts: result.facts.map((entry) => ({ ...entry, negated: true })),
    proofKinds: ok ? result.facts.map((entry) => {
      const suffix = Object.values(entry).filter((value) => typeof value === 'string').slice(1).join(':');
      return `not:${entry.predicate}${suffix ? `:${suffix}` : ''}${typeof entry.required === 'boolean' ? `:${entry.required}` : ''}`;
    }) : []
  };
}

export function evaluateExpression(expression, snapshot, context = {}) {
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) {
    throw coded('PIPELINE_PREDICATE_INVALID', 'predicate expression is invalid');
  }
  let result;
  if (Array.isArray(expression.all)) result = combineAll(expression.all.map((entry) => evaluateExpression(entry, snapshot, context)));
  else if (Array.isArray(expression.any)) result = combineAny(expression.any.map((entry) => evaluateExpression(entry, snapshot, context)));
  else if (expression.not) result = invert(evaluateExpression(expression.not, snapshot, context));
  else {
    let entry;
    try { entry = resolvePredicate(expression.predicate); }
    catch { throw coded('PIPELINE_PREDICATE_INVALID', 'predicate is not registered'); }
    result = leaf(entry, expression, snapshot, context);
  }
  return deepFreeze(result);
}
