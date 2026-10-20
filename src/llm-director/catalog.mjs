import { validateActorState } from '../llm-agent/contracts.mjs';
import { COLLECT_OAK_LOG_GOAL, PLACE_OAK_LOG_GOAL } from '../llm-agent/goals.mjs';

export function eligibleGoals({ latestAgentState } = {}) {
  let state;
  try {
    state = validateActorState(latestAgentState);
  } catch {
    return [];
  }
  const evidence = state.trusted.evidence;
  const proof = evidence.goalProof;
  const placementSucceeded = state.identity.actorId === evidence.actorId
    && state.lifecycle.runId === evidence.runId
    && state.lifecycle.status === 'succeeded'
    && state.goal.id === PLACE_OAK_LOG_GOAL.id
    && evidence.source === 'mineflayer-live'
    && evidence.simulated === false
    && proof?.markerBlock === 'gold_block'
    && proof?.aboveBlock === 'oak_log';
  if (!placementSucceeded) return [];
  return Object.freeze([Object.freeze({
    goalId: COLLECT_OAK_LOG_GOAL.id,
    objective: COLLECT_OAK_LOG_GOAL.objective,
    successKind: COLLECT_OAK_LOG_GOAL.successCondition.kind
  })]);
}
