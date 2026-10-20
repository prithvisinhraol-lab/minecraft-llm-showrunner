import { resolveCapability } from './registry.mjs';

const TERMINAL = new Set(['finish', 'fail']);

function invalid(message) {
  const error = new Error(message);
  error.code = 'PIPELINE_FAST_DECISION_INVALID';
  throw error;
}

function plain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exact(value, keys, label) {
  if (!plain(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) invalid(`${label} contains unknown or missing fields`);
}

function string(value, maximum, label, empty = false) {
  if (typeof value !== 'string' || (!empty && value.trim().length === 0) || Array.from(value).length > maximum || /[\u0000-\u001f]/u.test(value)) invalid(`${label} is invalid`);
}

function integer(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`${label} is invalid`);
}

function includes(list, value, label) {
  if (!Array.isArray(list) || !list.includes(value)) invalid(`${label} is not authorized`);
}

function target(context, id, kinds) {
  const found = context.observation.targets?.find((entry) => entry?.id === id);
  if (!found || (kinds && !kinds.includes(found.kind))) invalid('targetId is not current or compatible');
}

const ACTION_FIELDS = Object.freeze({
  observe: [],
  navigate_to_target: ['targetId'],
  navigate_to_landmark: ['reference'],
  mine_target: ['targetId'],
  collect_drop: ['targetId'],
  craft_recipe: ['recipe', 'count'],
  place_against_target: ['item', 'targetId'],
  equip_item: ['item'],
  consume_item: ['item'],
  attack_target: ['targetId'],
  speak: ['text']
});

function allowedKinds(authority) {
  const result = new Set();
  for (const capability of authority.capabilities ?? []) {
    let resolved;
    try { resolved = resolveCapability(capability); } catch { invalid('capability is unknown'); }
    for (const kind of resolved.actionKinds) result.add(kind);
  }
  return result;
}

function validateAction(value, context) {
  if (!plain(value) || typeof value.kind !== 'string' || !Object.hasOwn(ACTION_FIELDS, value.kind)) invalid('action kind is invalid');
  exact(value, ['kind', 'observationVersion', ...ACTION_FIELDS[value.kind]], 'action');
  integer(value.observationVersion, 1, Number.MAX_SAFE_INTEGER, 'observationVersion');
  if (value.observationVersion !== context.observation.observationVersion) invalid('observationVersion is stale');
  if (!allowedKinds(context.authority).has(value.kind)) invalid('action kind is not authorized');
  if (['navigate_to_target'].includes(value.kind)) target(context, value.targetId);
  if (value.kind === 'mine_target') target(context, value.targetId, ['block']);
  if (value.kind === 'collect_drop') target(context, value.targetId, ['drop']);
  if (value.kind === 'attack_target') target(context, value.targetId, ['entity']);
  if (value.kind === 'place_against_target') { target(context, value.targetId, ['block']); includes(context.authority.items, value.item, 'item'); }
  if (['equip_item', 'consume_item'].includes(value.kind)) includes(context.authority.items, value.item, 'item');
  if (value.kind === 'craft_recipe') { includes(context.authority.recipes, value.recipe, 'recipe'); integer(value.count, 1, 64, 'recipe count'); }
  if (value.kind === 'navigate_to_landmark') includes(context.authority.landmarks, value.reference, 'landmark');
  if (value.kind === 'speak') string(value.text, 200, 'speech');
  return structuredClone(value);
}

export function validateFastDecision(value, context) {
  exact(value, ['decision', 'action', 'summary', 'plan'], 'fast decision');
  if (value.decision !== 'act' && !TERMINAL.has(value.decision)) invalid('decision is invalid');
  string(value.summary, 500, 'summary', true);
  if (!Array.isArray(value.plan) || value.plan.length > 5) invalid('plan is invalid');
  for (const entry of value.plan) string(entry, 200, 'plan entry');
  const action = value.decision === 'act' ? validateAction(value.action, context) : null;
  if (value.decision !== 'act' && value.action !== null) invalid('terminal action must be null');
  const normalized = { decision: value.decision, action, summary: value.summary, plan: [...value.plan] };
  Object.freeze(normalized.plan);
  if (action) Object.freeze(action);
  return Object.freeze(normalized);
}
