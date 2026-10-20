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

const capabilities = new Map([
  ['observe', { id: 'observe', actionKinds: ['observe'] }],
  ['navigate', { id: 'navigate', actionKinds: ['navigate_to_target', 'navigate_to_landmark'] }],
  ['mine_block', { id: 'mine_block', actionKinds: ['mine_target'] }],
  ['collect_item', { id: 'collect_item', actionKinds: ['collect_drop'] }],
  ['craft_recipe', { id: 'craft_recipe', actionKinds: ['craft_recipe'] }],
  ['place_block', { id: 'place_block', actionKinds: ['place_against_target'] }],
  ['equip_item', { id: 'equip_item', actionKinds: ['equip_item'] }],
  ['consume_food', { id: 'consume_food', actionKinds: ['consume_item'] }],
  ['attack_hostile', { id: 'attack_hostile', actionKinds: ['attack_target'] }],
  ['retreat', { id: 'retreat', actionKinds: ['navigate_to_landmark'] }],
  ['speak', { id: 'speak', actionKinds: ['speak'] }]
]);

const predicates = new Map([
  ['actor_alive', { id: 'actor_alive', parameters: {} }],
  ['actor_connected', { id: 'actor_connected', parameters: {} }],
  ['health_at_least', { id: 'health_at_least', parameters: { value: 'positive_integer' } }],
  ['hunger_at_least', { id: 'hunger_at_least', parameters: { value: 'nonnegative_integer' } }],
  ['in_dimension', { id: 'in_dimension', parameters: { dimension: 'identifier' } }],
  ['in_region', { id: 'in_region', parameters: { region: 'identifier' } }],
  ['inventory_at_least', { id: 'inventory_at_least', parameters: { item: 'identifier', count: 'positive_integer' } }],
  ['equipped_item', { id: 'equipped_item', parameters: { item: 'identifier' } }],
  ['block_exists', { id: 'block_exists', parameters: { block: 'identifier', radius: 'positive_integer' } }],
  ['entity_exists', { id: 'entity_exists', parameters: { entity: 'identifier', radius: 'positive_integer' } }],
  ['target_state', { id: 'target_state', parameters: { targetId: 'identifier', state: 'identifier' } }],
  ['landmark_visible', { id: 'landmark_visible', parameters: { reference: 'identifier' } }],
  ['landmark_reached', { id: 'landmark_reached', parameters: { reference: 'identifier' } }],
  ['recipe_available', { id: 'recipe_available', parameters: { recipe: 'identifier' } }],
  ['time_of_day', { id: 'time_of_day', parameters: { category: 'identifier' } }],
  ['weather', { id: 'weather', parameters: { category: 'identifier' } }],
  ['hostile_threat', { id: 'hostile_threat', parameters: { exists: 'boolean' } }],
  ['container_contains', { id: 'container_contains', parameters: { containerId: 'identifier', item: 'identifier', count: 'positive_integer' } }],
  ['blueprint_complete', { id: 'blueprint_complete', parameters: { blueprintId: 'identifier' } }],
  ['outcome_proof', { id: 'outcome_proof', parameters: { proofKind: 'identifier' } }]
]);

const constraints = new Map([
  ['stay_within_radius', { id: 'stay_within_radius', parameters: { blocks: 'positive_integer' } }],
  ['do_not_attack_players', { id: 'do_not_attack_players', parameters: {} }],
  ['do_not_harm_villagers', { id: 'do_not_harm_villagers', parameters: {} }],
  ['do_not_break_protected_blocks', { id: 'do_not_break_protected_blocks', parameters: {} }]
]);

function resolve(catalog, id) {
  if (typeof id !== 'string' || !catalog.has(id)) {
    const error = new Error('vocabulary ID is not registered');
    error.code = 'PIPELINE_REGISTRY_UNKNOWN';
    throw error;
  }
  return deepFreeze(clone(catalog.get(id)));
}

export const CAPABILITY_IDS = deepFreeze([...capabilities.keys()]);
export const PREDICATE_IDS = deepFreeze([...predicates.keys()]);
export const CONSTRAINT_IDS = deepFreeze([...constraints.keys()]);
export const resolveCapability = (id) => resolve(capabilities, id);
export const resolvePredicate = (id) => resolve(predicates, id);
export const resolveConstraint = (id) => resolve(constraints, id);
