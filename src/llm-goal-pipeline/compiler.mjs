import { validateGeneratedContract } from './contracts.mjs';
import { resolveCapability } from './registry.mjs';
import { evaluateExpression } from './predicates.mjs';

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

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  return value;
}

function list(value, label) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw coded('PIPELINE_PERMISSION_DENIED', `${label} permissions are invalid`);
  }
  return value;
}

function leaves(expression, output = []) {
  if (expression.predicate) output.push(expression);
  else if (expression.not) leaves(expression.not, output);
  else for (const child of expression.all ?? expression.any ?? []) leaves(child, output);
  return output;
}

function leafKey(value) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)));
}

function assertNoContradictions(expression) {
  if (expression.not || expression.predicate) return;
  if (expression.all) {
    const positive = new Set();
    const negative = new Set();
    for (const child of expression.all) {
      if (child.predicate) positive.add(leafKey(child));
      if (child.not?.predicate) negative.add(leafKey(child.not));
      assertNoContradictions(child);
    }
    if ([...positive].some((key) => negative.has(key))) {
      throw coded('PIPELINE_CONTRADICTION', 'all expression contains a predicate and its negation');
    }
  } else {
    for (const child of expression.any ?? []) assertNoContradictions(child);
  }
}

const SUCCESS_CAPABILITIES = Object.freeze({
  inventory_at_least: ['collect_item', 'mine_block', 'craft_recipe'],
  equipped_item: ['equip_item'],
  target_state: ['mine_block', 'place_block'],
  landmark_reached: ['navigate', 'retreat'],
  recipe_available: ['craft_recipe'],
  hostile_threat: ['attack_hostile', 'retreat'],
  container_contains: ['collect_item'],
  blueprint_complete: ['place_block']
});

function assertSuccessSupported(expression, capabilities) {
  for (const entry of leaves(expression)) {
    const required = SUCCESS_CAPABILITIES[entry.predicate];
    if (required && !required.some((capability) => capabilities.includes(capability))) {
      throw coded('PIPELINE_SUCCESS_UNSUPPORTED', `success predicate ${entry.predicate} is unsupported by requested capabilities`);
    }
  }
}

function assertRemainingBudgets(budget, remaining) {
  const fields = ['maximumActions', 'maximumReplans', 'maximumSeconds', 'maximumSearchRadius', 'maximumTravelRadius'];
  if (!remaining || typeof remaining !== 'object') throw coded('PIPELINE_BUDGET_EXCEEDED', 'remaining limits are invalid');
  for (const field of fields) {
    if (!Number.isSafeInteger(remaining[field]) || remaining[field] < budget[field]) {
      throw coded('PIPELINE_BUDGET_EXCEEDED', `${field} exceeds the remaining session limit`);
    }
  }
}

function collectResources(expressions) {
  const result = {
    items: new Set(), blocks: new Set(), entities: new Set(), recipes: new Set(),
    landmarks: new Set(), regions: new Set(), blueprints: new Set(), containers: new Set()
  };
  for (const expression of expressions) {
    for (const entry of leaves(expression)) {
      if (entry.item) result.items.add(entry.item);
      if (entry.block) result.blocks.add(entry.block);
      if (entry.entity) result.entities.add(entry.entity);
      if (entry.recipe) result.recipes.add(entry.recipe);
      if (entry.reference) result.landmarks.add(entry.reference);
      if (entry.region) result.regions.add(entry.region);
      if (entry.blueprintId) result.blueprints.add(entry.blueprintId);
      if (entry.containerId) result.containers.add(entry.containerId);
    }
  }
  return result;
}

function resolveAuthority(proposal, permissions) {
  if (!permissions || typeof permissions !== 'object') throw coded('PIPELINE_PERMISSION_DENIED', 'permissions are invalid');
  const permittedCapabilities = new Set(list(permissions.capabilities, 'capability'));
  for (const capability of proposal.capabilities) {
    resolveCapability(capability);
    if (!permittedCapabilities.has(capability)) throw coded('PIPELINE_PERMISSION_DENIED', `capability ${capability} is not permitted`);
  }
  const resources = collectResources([proposal.prerequisites, proposal.success]);
  const categories = ['items', 'blocks', 'entities', 'recipes', 'landmarks', 'regions', 'blueprints', 'containers'];
  for (const category of categories) {
    const allowed = new Set(list(permissions[category] ?? [], category));
    for (const id of resources[category]) {
      if (!allowed.has(id)) throw coded('PIPELINE_PERMISSION_DENIED', `${category} resource ${id} is not permitted`);
    }
  }
  const protectedBlocks = new Set(list(permissions.protectedBlocks ?? [], 'protected block'));
  for (const block of resources.blocks) {
    if (protectedBlocks.has(block)) throw coded('PIPELINE_PROTECTED_RESOURCE', `block ${block} is protected`);
  }
  return deepFreeze({
    capabilities: [...proposal.capabilities].sort(),
    ...Object.fromEntries(categories.map((category) => [category, [...resources[category]].sort()]))
  });
}

export function compileGeneratedContract({ proposal: source, fences, snapshot, permissions, remainingLimits, context = {} }) {
  const proposal = validateGeneratedContract(source, fences);
  if (!Number.isSafeInteger(snapshot?.observationVersion) || snapshot.observationVersion !== fences.observationVersion) {
    throw coded('PIPELINE_FENCE_MISMATCH', 'snapshot observation version does not match the contract fence');
  }
  assertRemainingBudgets(proposal.budget, remainingLimits);
  const authority = resolveAuthority(proposal, permissions);
  assertNoContradictions(proposal.prerequisites);
  assertNoContradictions(proposal.success);
  assertSuccessSupported(proposal.success, authority.capabilities);
  const prerequisiteProof = evaluateExpression(proposal.prerequisites, snapshot, context);
  if (!prerequisiteProof.ok) {
    throw coded('PIPELINE_PREREQUISITE_UNMET', 'generated contract prerequisites are not met');
  }
  return deepFreeze({ ...clone(proposal), authority, prerequisiteProof, compiledAt: fences.now });
}
