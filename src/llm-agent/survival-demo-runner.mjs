import { randomUUID } from 'node:crypto';

import {
  FINAL_SURVIVAL_DEMO_LINE,
  SURVIVAL_DEMO_MILESTONES,
  applyVerifiedSurvivalDemoOutcome,
  createInitialSurvivalDemoState,
  expectedSurvivalDemoAction,
  validateSurvivalDemoDecision,
  validateSurvivalDemoState,
  verifySurvivalDemoMilestone
} from './survival-demo-contracts.mjs';

const MAXIMUM_RUN_MS = 15 * 60 * 1_000;

function coded(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function requirePort(value, name, methods) {
  if (!value || typeof value !== 'object') throw new TypeError(`${name} must be an object`);
  for (const method of methods) {
    if (typeof value[method] !== 'function') throw new TypeError(`${name}.${method} must be a function`);
  }
}

function milliseconds(clock) {
  const value = clock?.now?.();
  if (value instanceof Date) return value.valueOf();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return Date.parse(value);
  throw coded('SURVIVAL_DEMO_CLOCK_INVALID', 'clock returned an invalid value');
}

function iso(clock) {
  return new Date(milliseconds(clock)).toISOString();
}

function publicContext(state, observation) {
  return Object.freeze({
    actorId: state.actorId,
    objective: 'Complete the first survival progression and find a village.',
    nextMilestone: SURVIVAL_DEMO_MILESTONES[state.nextMilestoneIndex],
    expectedAction: expectedSurvivalDemoAction(state),
    verifiedMilestones: Object.freeze([...state.verifiedMilestones]),
    remainingDecisions: state.maximumDecisions - state.decisionsUsed,
    observation: Object.freeze(structuredClone(observation))
  });
}

function executionRequest(decision) {
  return Object.freeze({
    action: decision.action,
    observationVersion: decision.observationVersion,
    ...(decision.action === 'say_final_line' ? { line: FINAL_SURVIVAL_DEMO_LINE } : {})
  });
}

export function createSurvivalDemoRunner({
  actorId,
  provider,
  adapter,
  store,
  clock = { now: () => Date.now() },
  maximumRunMs = MAXIMUM_RUN_MS
} = {}) {
  if (typeof actorId !== 'string' || actorId.length === 0) throw new TypeError('actorId must be a nonempty string');
  requirePort(provider, 'provider', ['decide']);
  requirePort(adapter, 'adapter', ['observe', 'execute', 'cancel']);
  requirePort(store, 'store', ['load', 'save', 'acquireLease', 'releaseLease']);
  if (!clock || typeof clock.now !== 'function') throw new TypeError('clock.now must be a function');
  if (!Number.isSafeInteger(maximumRunMs) || maximumRunMs < 1 || maximumRunMs > MAXIMUM_RUN_MS) {
    throw new TypeError(`maximumRunMs must be between 1 and ${MAXIMUM_RUN_MS}`);
  }

  const owner = randomUUID();
  let state = null;
  let activeAbortController = null;
  let runPromise = null;
  let stopRequested = null;
  let leaseHeld = false;

  async function save(next) {
    state = validateSurvivalDemoState(next);
    await store.save(state);
    return state;
  }

  async function persistTerminal(status, reason) {
    if (!state) return;
    await save({
      ...structuredClone(state),
      status,
      updatedAt: iso(clock),
      stoppedReason: reason
    });
  }

  async function executeRun() {
    const acquired = await store.acquireLease(owner);
    if (acquired !== true) throw coded('SURVIVAL_DEMO_LEASE_UNAVAILABLE', 'another survival demo runner owns the lease');
    leaseHeld = true;
    const runStartedMs = milliseconds(clock);
    try {
      const loaded = await store.load();
      state = loaded === null
        ? createInitialSurvivalDemoState({ actorId, runId: randomUUID(), now: new Date(runStartedMs).toISOString() })
        : validateSurvivalDemoState(loaded);
      if (state.actorId !== actorId) throw coded('SURVIVAL_DEMO_STATE_INVALID', 'persisted actor identity does not match');
      if (state.status === 'succeeded') return state;
      await save({
        ...structuredClone(state),
        status: 'running',
        startedAt: state.startedAt ?? new Date(runStartedMs).toISOString(),
        updatedAt: iso(clock),
        stoppedReason: null
      });

      while (state.status === 'running') {
        if (milliseconds(clock) - runStartedMs > maximumRunMs) {
          throw coded('SURVIVAL_DEMO_DEADLINE_EXCEEDED', 'survival demo exceeded its total deadline');
        }
        activeAbortController = new AbortController();
        const signal = activeAbortController.signal;
        const before = await adapter.observe({ signal });
        if (stopRequested) break;
        const rawDecision = await provider.decide(publicContext(state, before), { signal });
        if (stopRequested) break;
        const decision = validateSurvivalDemoDecision(rawDecision, state, before);
        if (decision.action === 'stop') {
          stopRequested = decision.reason;
          break;
        }
        const request = executionRequest(decision);
        await adapter.execute(request, { signal });
        if (stopRequested) break;
        const after = await adapter.observe({ signal });
        const milestone = SURVIVAL_DEMO_MILESTONES[state.nextMilestoneIndex];
        const verification = verifySurvivalDemoMilestone(milestone, after, { actorId });
        if (!verification.verified) {
          throw coded('SURVIVAL_DEMO_MILESTONE_NOT_VERIFIED', `${milestone} was not verified after ${decision.action}`);
        }
        await save(applyVerifiedSurvivalDemoOutcome(state, {
          action: decision.action,
          observationVersion: after.observationVersion,
          verification,
          observedAt: iso(clock)
        }));
      }

      if (stopRequested && state.status !== 'stopped') {
        await persistTerminal('stopped', stopRequested);
      }
      return state;
    } catch (error) {
      if (stopRequested) {
        if (state && state.status !== 'stopped') await persistTerminal('stopped', stopRequested);
        return state;
      }
      if (state && !['succeeded', 'failed'].includes(state.status)) {
        await persistTerminal('failed', error?.code ?? 'SURVIVAL_DEMO_FAILED');
      }
      throw error;
    } finally {
      activeAbortController = null;
      if (leaseHeld) {
        await store.releaseLease(owner);
        leaseHeld = false;
      }
    }
  }

  function start() {
    if (!runPromise) runPromise = executeRun();
    return runPromise;
  }

  async function stop(reason = 'operator requested stop') {
    if (typeof reason !== 'string' || reason.length === 0 || reason.length > 200) throw new TypeError('stop reason is invalid');
    stopRequested = reason;
    activeAbortController?.abort();
    await adapter.cancel(reason);
    if (state && !['stopped', 'succeeded', 'failed'].includes(state.status)) await persistTerminal('stopped', reason);
    return state;
  }

  return Object.freeze({
    start,
    stop,
    status: () => state === null ? null : validateSurvivalDemoState(state)
  });
}
