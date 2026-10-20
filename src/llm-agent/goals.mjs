export const MAX_GOAL_TURNS = 12;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  }
  return value;
}

function unsupported(message) {
  const error = new Error(message);
  error.code = 'LLM_AGENT_GOAL_UNSUPPORTED';
  throw error;
}

export const PLACE_OAK_LOG_GOAL = deepFreeze({
  id: 'place_oak_log_above_gold_marker',
  objective: 'obtain one oak_log and place an oak_log directly above a controller-identified gold_block marker',
  successCondition: { kind: 'oak_log_above_gold_marker' },
  maxTurns: MAX_GOAL_TURNS
});

export const COLLECT_OAK_LOG_GOAL = deepFreeze({
  id: 'collect_oak_log_above_gold_marker',
  objective: 'mine the oak_log directly above the controller-identified gold_block marker and retain it in inventory',
  successCondition: { kind: 'oak_log_collected_from_above_gold_marker' },
  maxTurns: MAX_GOAL_TURNS
});

const CATALOG = new Map([
  [PLACE_OAK_LOG_GOAL.id, PLACE_OAK_LOG_GOAL],
  [COLLECT_OAK_LOG_GOAL.id, COLLECT_OAK_LOG_GOAL]
]);

export const GOAL_IDS = deepFreeze([...CATALOG.keys()]);

function frozenClone(goal) {
  return deepFreeze(clone(goal));
}

export function resolveAgentGoal(goalId) {
  if (typeof goalId !== 'string' || !CATALOG.has(goalId)) unsupported('goal ID is not in the executable catalog');
  return frozenClone(CATALOG.get(goalId));
}

export function validateAgentGoal(goal) {
  if (typeof goal === 'string') {
    if (goal !== PLACE_OAK_LOG_GOAL.objective) unsupported('legacy goal objective is not supported');
    return frozenClone(PLACE_OAK_LOG_GOAL);
  }
  if (!goal || typeof goal !== 'object' || Array.isArray(goal)) unsupported('goal must be a catalog goal');

  let catalogGoal;
  if (Object.hasOwn(goal, 'id')) {
    catalogGoal = CATALOG.get(goal.id);
    if (!catalogGoal) unsupported('goal ID is not in the executable catalog');
    if (Object.keys(goal).sort().join(',') !== 'id,maxTurns,objective,successCondition') {
      unsupported('catalog goal fields are invalid');
    }
  } else {
    if (Object.keys(goal).sort().join(',') !== 'objective,successCondition') {
      unsupported('legacy goal fields are invalid');
    }
    catalogGoal = PLACE_OAK_LOG_GOAL;
  }

  if (JSON.stringify(goal.objective) !== JSON.stringify(catalogGoal.objective)
    || JSON.stringify(goal.successCondition) !== JSON.stringify(catalogGoal.successCondition)
    || (Object.hasOwn(goal, 'maxTurns') && goal.maxTurns !== catalogGoal.maxTurns)) {
    unsupported('goal does not match its executable catalog definition');
  }
  return frozenClone(catalogGoal);
}
