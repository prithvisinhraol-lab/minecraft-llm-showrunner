import { randomUUID } from 'node:crypto';

import { validateActorState } from '../llm-agent/contracts.mjs';
import { resolveAgentGoal } from '../llm-agent/goals.mjs';
import { eligibleGoals } from './catalog.mjs';
import {
  createInitialDirectorState,
  toDirectorContext,
  validateDirectorDecision,
  validateDirectorState
} from './contracts.mjs';

function coded(code, message, cause) { const error = new Error(message, cause ? { cause } : undefined); error.code = code; return error; }
function requirePort(value, name, methods) { if (!value || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`${name} is invalid`); }

export function createDirectorController({
  actorId, overallObjective, store, provider, loadAgentState, inspectPrerequisite, runGoal,
  clock = { now: () => new Date() }
} = {}) {
  requirePort(store, 'store', ['load', 'save', 'reset', 'acquireLease', 'releaseLease']);
  requirePort(provider, 'provider', ['select']);
  for (const [name, value] of Object.entries({ loadAgentState, inspectPrerequisite, runGoal })) {
    if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  }
  let state = null; let active = false; let activePromise = null; let aborter = null; let leaseOwner = null;
  const nowDate = () => { const value = typeof clock === 'function' ? clock() : clock.now(); return value instanceof Date ? value : new Date(value); };
  const nowIso = () => nowDate().toISOString();
  const persist = async (next) => { state = validateDirectorState(next); await store.save(actorId, state); return state; };

  async function executeRun() {
    leaseOwner = randomUUID();
    const started = nowDate();
    await store.acquireLease(actorId, {
      ownerId: leaseOwner, acquiredAt: started.toISOString(), expiresAt: new Date(started.valueOf() + 405_000).toISOString()
    });
    aborter = new AbortController();
    try {
      const previous = await store.load(actorId);
      const initial = structuredClone(createInitialDirectorState({
        actorId, runId: randomUUID(), now: started, overallObjective
      }));
      if (previous) initial.outcomes = [...validateDirectorState(previous).outcomes];
      initial.lifecycle.status = 'running'; initial.lifecycle.startedAt = started.toISOString();
      await persist(initial);

      const priorAgent = await loadAgentState({ signal: aborter.signal });
      const eligible = eligibleGoals({ latestAgentState: priorAgent });
      if (eligible.length === 0) throw coded('LLM_DIRECTOR_NO_ELIGIBLE_GOAL', 'no verified goal is eligible');
      const raw = await provider.select(toDirectorContext(state, eligible, priorAgent), { signal: aborter.signal });
      const decision = validateDirectorDecision(raw, eligible.map(({ goalId }) => goalId));
      if (decision.decision === 'stop') {
        const stopped = structuredClone(state); stopped.decision = { reason: decision.reason, stateSummary: decision.stateSummary };
        stopped.lifecycle.status = 'stopped'; stopped.lifecycle.updatedAt = nowIso(); stopped.lifecycle.finishedAt = nowIso();
        return await persist(stopped);
      }
      const goal = resolveAgentGoal(decision.goalId);
      const prerequisite = await inspectPrerequisite(goal, priorAgent, { signal: aborter.signal });
      if (prerequisite?.ok !== true) throw coded('LLM_DIRECTOR_PREREQUISITE_CHANGED', 'live goal prerequisite is no longer true');
      const selected = structuredClone(state);
      selected.currentGoalId = goal.id; selected.decision = { reason: decision.reason, stateSummary: decision.stateSummary };
      selected.limits.selectionsUsed = 1; selected.lifecycle.updatedAt = nowIso();
      await persist(selected);

      const terminalAgent = validateActorState(await runGoal(goal, { signal: aborter.signal }));
      const evidence = terminalAgent.trusted.evidence;
      const proofMatches = terminalAgent.goal.id === goal.id && terminalAgent.lifecycle.status === 'succeeded'
        && evidence.source === 'mineflayer-live' && evidence.simulated === false
        && evidence.actorId === actorId && evidence.runId === terminalAgent.lifecycle.runId
        && evidence.goalProof?.aboveBlock === 'air' && evidence.goalProof?.collectedItem === 'oak_log';
      if (!proofMatches) throw coded('LLM_DIRECTOR_AGENT_RESULT_UNVERIFIED', 'fast agent result lacks matching live proof');

      const completedAt = nowIso(); const succeeded = structuredClone(state);
      succeeded.outcomes.push({
        goalId: goal.id, status: 'succeeded', agentRunId: terminalAgent.lifecycle.runId,
        completedAt, summary: decision.stateSummary,
        proof: { kind: goal.successCondition.kind }
      });
      succeeded.lifecycle.status = 'succeeded'; succeeded.lifecycle.updatedAt = completedAt; succeeded.lifecycle.finishedAt = completedAt;
      return await persist(succeeded);
    } catch (error) {
      if (state) {
        const failed = structuredClone(state); const timestamp = nowIso();
        failed.lifecycle.status = aborter?.signal.aborted ? 'stopped' : 'failed';
        failed.lifecycle.updatedAt = timestamp; failed.lifecycle.finishedAt = timestamp;
        failed.failure = { code: error?.code ?? 'LLM_DIRECTOR_FAILED', message: error?.message ?? 'director failed' };
        try { await persist(failed); } catch {}
      }
      throw error;
    } finally {
      if (leaseOwner) await store.releaseLease(actorId, leaseOwner);
      leaseOwner = null; aborter = null; active = false;
    }
  }

  function start() {
    if (active) return Promise.reject(coded('LLM_DIRECTOR_ALREADY_RUNNING', 'director is already running'));
    active = true; activePromise = executeRun(); activePromise.catch(() => {}); return activePromise;
  }
  async function status() { if (!state) state = await store.load(actorId); return state; }
  async function stop() { aborter?.abort(); try { await activePromise; } catch {} return status(); }
  async function reset() { if (active) throw coded('LLM_DIRECTOR_ALREADY_RUNNING', 'cannot reset a running director'); await store.reset(actorId); state = null; return null; }
  async function awaitIdle() { try { await activePromise; } catch {} }
  return Object.freeze({ start, status, stop, reset, awaitIdle });
}
