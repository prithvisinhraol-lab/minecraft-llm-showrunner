import { randomUUID } from 'node:crypto';

import {
  MAX_RECENT_RESULTS,
  MAX_TURNS,
  createInitialActorState,
  toDecisionContext,
  validateActorState,
  validateDecision
} from './contracts.mjs';

const DEFAULT_LIMITS = Object.freeze({
  maxTurns: MAX_TURNS,
  decisionTimeoutMs: 30_000,
  actionTimeoutMs: 30_000,
  runTimeoutMs: 300_000,
  maxInvalidResponses: 3,
  maxIdenticalFailures: 3
});

const LIMIT_KEYS = new Set(Object.keys(DEFAULT_LIMITS));
const MAX_LIMITS = Object.freeze({ ...DEFAULT_LIMITS });
const OBSERVATION_HISTORY_LIMIT = MAX_RECENT_RESULTS;
const EVIDENCE_SOURCES = new Set(['mineflayer-live', 'simulated']);
const EVIDENCE_PROVIDERS = new Set(['codex', 'scripted']);

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

function normalizeLimits(overrides) {
  if (overrides === undefined) return { ...DEFAULT_LIMITS };
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('limits must be an object');
  }
  for (const key of Object.keys(overrides)) {
    if (!LIMIT_KEYS.has(key)) throw new TypeError(`unknown controller limit: ${key}`);
  }
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${key} must be a positive integer`);
    if (value > MAX_LIMITS[key]) throw new TypeError(`${key} exceeds its safety maximum`);
  }
  if (limits.maxTurns !== MAX_TURNS) throw new TypeError(`maxTurns must be ${MAX_TURNS}`);
  return limits;
}

function clockMilliseconds(clock) {
  const value = typeof clock === 'function' ? clock() : clock?.now?.();
  if (value instanceof Date) return value.valueOf();
  if (typeof value === 'string') return Date.parse(value);
  if (typeof value === 'number') return value;
  return Date.now();
}

function errorCode(error, fallback) {
  return typeof error?.code === 'string' && error.code.length > 0 ? error.code : fallback;
}

function errorMessage(error, fallback) {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function markerIdentity(value) {
  if (!isPlainObject(value) || typeof value.dimension !== 'string' || value.dimension.length === 0
    || !Number.isSafeInteger(value.x) || !Number.isSafeInteger(value.y) || !Number.isSafeInteger(value.z)) return null;
  return { dimension: value.dimension, x: value.x, y: value.y, z: value.z };
}

function verifiedActionResult(decision, verification) {
  if (verification === false) {
    return {
      action: decision.action,
      ok: false,
      code: 'ACTION_NOT_VERIFIED',
      message: 'action result was not verified',
      ...(decision.targetId === undefined ? {} : { targetId: decision.targetId }),
      ...(decision.reference === undefined ? {} : { reference: decision.reference })
    };
  }
  if (verification === true) {
    return {
      action: decision.action,
      ok: true,
      code: 'ACTION_VERIFIED',
      message: 'action result was verified',
      ...(decision.targetId === undefined ? {} : { targetId: decision.targetId }),
      ...(decision.reference === undefined ? {} : { reference: decision.reference })
    };
  }
  if (!isPlainObject(verification) || typeof verification.ok !== 'boolean'
    || typeof verification.code !== 'string' || verification.code.length === 0
    || (verification.message !== undefined && typeof verification.message !== 'string')) {
    return {
      action: decision.action,
      ok: false,
      code: 'LLM_AGENT_ACTION_VERIFICATION_INVALID',
      message: 'adapter returned an invalid action verification',
      ...(decision.targetId === undefined ? {} : { targetId: decision.targetId }),
      ...(decision.reference === undefined ? {} : { reference: decision.reference })
    };
  }
  const marker = markerIdentity(verification.marker);
  return {
    action: decision.action,
    ok: verification.ok,
    code: verification.code,
    ...(typeof verification.message === 'string' ? { message: verification.message } : {}),
    ...(decision.targetId === undefined ? {} : { targetId: decision.targetId }),
    ...(decision.reference === undefined ? {} : { reference: decision.reference }),
    ...(marker === null ? {} : { marker })
  };
}

function failedActionResult(decision, error) {
  return {
    action: decision.action,
    ok: false,
    code: errorCode(error, 'LLM_AGENT_ACTION_FAILED'),
    message: errorMessage(error, 'adapter action failed'),
    ...(decision.targetId === undefined ? {} : { targetId: decision.targetId }),
    ...(decision.reference === undefined ? {} : { reference: decision.reference })
  };
}

function failureIdentity(result) {
  if (result.ok) return null;
  return JSON.stringify({
    action: result.action ?? null,
    targetId: result.targetId ?? null,
    reference: result.reference ?? null,
    code: result.code
  });
}

function priorFailureIdentity(state) {
  const prior = state.trusted.recentActionResults.at(-1);
  return prior && prior.ok === false ? failureIdentity(prior) : null;
}

function placementGoalProof(value) {
  if (!isPlainObject(value) || typeof value.markerTargetId !== 'string' || value.markerTargetId.length === 0
    || value.markerBlock !== 'gold_block' || value.aboveBlock !== 'oak_log') return null;
  const marker = markerIdentity(value.marker);
  if (marker === null) return null;
  return {
    markerTargetId: value.markerTargetId,
    marker,
    markerBlock: 'gold_block',
    aboveBlock: 'oak_log'
  };
}

function collectionGoalProof(value) {
  if (!isPlainObject(value) || typeof value.markerTargetId !== 'string' || value.markerTargetId.length === 0
    || value.markerBlock !== 'gold_block' || value.aboveBlock !== 'air'
    || value.collectedItem !== 'oak_log' || !Number.isSafeInteger(value.collectedCount) || value.collectedCount < 1) return null;
  const marker = markerIdentity(value.marker);
  if (marker === null) return null;
  return {
    markerTargetId: value.markerTargetId,
    marker,
    markerBlock: 'gold_block',
    aboveBlock: 'air',
    collectedItem: 'oak_log',
    collectedCount: value.collectedCount
  };
}

function goalProof(value, goal, milestones = []) {
  if (goal?.successCondition?.kind === 'oak_log_above_gold_marker') return placementGoalProof(value);
  if (goal?.successCondition?.kind === 'oak_log_collected_from_above_gold_marker'
    && milestones.includes('mined_oak_log')) return collectionGoalProof(value);
  return null;
}

function verifiedGoalResult(value, goal, milestones) {
  if (!isPlainObject(value) || value.ok !== true) return null;
  return goalProof(value.proof, goal, milestones);
}

export function createAgentController({
  actorId,
  goal,
  store,
  provider,
  adapter,
  clock = { now: () => Date.now() },
  limits: limitOverrides,
  evidenceSource = 'simulated',
  providerKind = 'scripted'
} = {}) {
  if (typeof actorId !== 'string' || actorId.length === 0) throw new TypeError('actorId must be a nonempty string');
  if (goal === undefined) throw new TypeError('goal is required');
  requirePort(store, 'store', ['load', 'save', 'reset', 'acquireLease', 'releaseLease']);
  requirePort(provider, 'provider', ['decide']);
  requirePort(adapter, 'adapter', ['observe', 'execute', 'verifyAction', 'verifyGoal', 'isConnected']);
  if (typeof clock !== 'function' && typeof clock?.now !== 'function') throw new TypeError('clock must provide now()');
  if (!EVIDENCE_SOURCES.has(evidenceSource)) throw new TypeError('evidenceSource must be mineflayer-live or simulated');
  if (!EVIDENCE_PROVIDERS.has(providerKind)) throw new TypeError('providerKind must be codex or scripted');
  const configuredLimits = normalizeLimits(limitOverrides);

  let state = null;
  let queue = Promise.resolve();
  let pendingTasks = 0;
  let turnQueued = false;
  let activeAbortController = null;
  let interruptionVersion = 0;
  const leaseOwnerId = randomUUID();
  let leaseHeld = false;
  const idleWaiters = new Set();

  const nowMs = () => {
    const value = clockMilliseconds(clock);
    if (!Number.isFinite(value)) throw coded('LLM_AGENT_CLOCK_INVALID', 'clock returned an invalid time');
    return value;
  };
  const nowIso = () => new Date(nowMs()).toISOString();

  function settleIdle() {
    if (pendingTasks !== 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  }

  function enqueue(operation) {
    pendingTasks += 1;
    const result = queue.then(operation);
    queue = result.catch(() => {});
    result.then(() => {
      pendingTasks -= 1;
      settleIdle();
    }, () => {
      pendingTasks -= 1;
      settleIdle();
    });
    return result;
  }

  function interruptActive() {
    interruptionVersion += 1;
    activeAbortController?.abort();
  }

  function mutableState() {
    return structuredClone(state);
  }

  async function persist(nextState) {
    const validated = validateActorState(nextState);
    await store.save(actorId, validated);
    state = validated;
    return state;
  }

  async function acquireRuntimeLease() {
    if (leaseHeld) return false;
    const acquiredMilliseconds = nowMs();
    await store.acquireLease(actorId, {
      ownerId: leaseOwnerId,
      acquiredAt: new Date(acquiredMilliseconds).toISOString(),
      expiresAt: new Date(acquiredMilliseconds + configuredLimits.runTimeoutMs).toISOString()
    });
    leaseHeld = true;
    return true;
  }

  async function releaseRuntimeLease() {
    if (!leaseHeld) return false;
    try {
      return await store.releaseLease(actorId, leaseOwnerId);
    } finally {
      leaseHeld = false;
    }
  }

  function applyConfiguredLimits(nextState) {
    Object.assign(nextState.limits, configuredLimits, {
      turnsUsed: 0,
      invalidResponses: 0,
      repeatedFailures: 0,
      deadline: new Date(nowMs() + configuredLimits.runTimeoutMs).toISOString()
    });
  }

  function setTerminal(nextState, status, phase, timestamp = nowIso()) {
    nextState.lifecycle.status = status;
    nextState.lifecycle.updatedAt = timestamp;
    nextState.lifecycle.finishedAt = timestamp;
    nextState.trusted.phase = phase;
  }

  function stampEvidence(nextState, { goalProof: proof = nextState.trusted.evidence.goalProof } = {}) {
    nextState.trusted.evidence = {
      source: evidenceSource,
      simulated: evidenceSource === 'simulated',
      provider: providerKind,
      actorId,
      runId: nextState.lifecycle.runId,
      observedAt: nowIso(),
      goalProof: proof === null ? null : structuredClone(proof)
    };
  }

  function appendObservation(nextState, observation) {
    const publicObservation = toDecisionContext(nextState, observation).observation;
    nextState.trusted.recentObservations = [
      ...nextState.trusted.recentObservations,
      publicObservation
    ].slice(-OBSERVATION_HISTORY_LIMIT);
    stampEvidence(nextState);
    return publicObservation;
  }

  function appendResult(nextState, result) {
    const priorIdentity = priorFailureIdentity(state);
    const currentIdentity = failureIdentity(result);
    nextState.trusted.recentActionResults = [
      ...nextState.trusted.recentActionResults,
      result
    ].slice(-MAX_RECENT_RESULTS);
    nextState.limits.repeatedFailures = currentIdentity === null
      ? 0
      : currentIdentity === priorIdentity ? nextState.limits.repeatedFailures + 1 : 1;
    if (result.action === 'mine_block' && result.ok === true && result.code === 'OAK_LOG_MINING_VERIFIED'
      && !nextState.trusted.milestones.includes('mined_oak_log')) {
      nextState.trusted.milestones.push('mined_oak_log');
    }
  }

  function remainingRunMilliseconds() {
    const deadline = Date.parse(state.limits.deadline);
    return deadline - nowMs();
  }

  async function boundedOperation(operation, timeoutMs, timeoutCode, timeoutMessage) {
    const runRemaining = remainingRunMilliseconds();
    if (runRemaining <= 0) throw coded('LLM_AGENT_RUN_TIMEOUT', 'agent run deadline expired');
    const effectiveTimeout = Math.max(1, Math.min(timeoutMs, runRemaining));
    const effectiveCode = runRemaining <= timeoutMs ? 'LLM_AGENT_RUN_TIMEOUT' : timeoutCode;
    const effectiveMessage = runRemaining <= timeoutMs ? 'agent run deadline expired' : timeoutMessage;
    const abortController = new AbortController();
    activeAbortController = abortController;
    let timer;
    let timeoutFailure;
    let removeAbortListener;
    const abortPromise = new Promise((resolve, reject) => {
      const onAbort = () => reject(timeoutFailure ?? coded('LLM_AGENT_OPERATION_ABORTED', 'agent operation was aborted'));
      abortController.signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => abortController.signal.removeEventListener('abort', onAbort);
    });
    const timeoutPromise = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        timeoutFailure = coded(effectiveCode, effectiveMessage);
        abortController.abort();
        reject(timeoutFailure);
      }, effectiveTimeout);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(abortController.signal)),
        abortPromise,
        timeoutPromise
      ]);
    } finally {
      clearTimeout(timer);
      removeAbortListener?.();
      if (activeAbortController === abortController) activeAbortController = null;
    }
  }

  async function persistControllerFailure(error, prefix = 'controller_failure') {
    if (!state) return;
    const next = mutableState();
    const code = errorCode(error, 'LLM_AGENT_CONTROLLER_FAILED');
    setTerminal(next, 'failed', `${prefix}:${code}`);
    try {
      await persist(next);
    } catch {
      state = validateActorState(next);
    } finally {
      await releaseRuntimeLease();
    }
  }

  function scheduleTurn() {
    if (turnQueued) return;
    turnQueued = true;
    const scheduled = enqueue(async () => {
      turnQueued = false;
      try {
        await runTurn();
      } catch (error) {
        await persistControllerFailure(error);
      }
    });
    scheduled.catch(() => {});
  }

  async function stopForConnection(phase) {
    try {
      if (state.lifecycle.status === 'succeeded' || state.lifecycle.status === 'failed') {
        return state;
      }
      const next = mutableState();
      setTerminal(next, 'stopped', phase);
      await persist(next);
      return state;
    } finally {
      await releaseRuntimeLease();
    }
  }

  async function finishTurn(nextState, result, postObservation) {
    if (postObservation !== undefined) appendObservation(nextState, postObservation);
    appendResult(nextState, result);
    nextState.lifecycle.updatedAt = nowIso();
    nextState.trusted.phase = result.ok ? 'action_succeeded' : `action_failed:${result.code}`;

    if (result.action === 'finish' && result.ok) {
      setTerminal(nextState, 'succeeded', 'goal_verified');
    } else if (result.code === 'LLM_AGENT_ACTION_TIMEOUT' || result.code === 'LLM_AGENT_RUN_TIMEOUT') {
      setTerminal(nextState, 'failed', `action_failure:${result.code}`);
    } else if (nextState.limits.repeatedFailures >= nextState.limits.maxIdenticalFailures) {
      setTerminal(nextState, 'failed', `repeated_failure:${result.code}`);
    } else if (nextState.limits.turnsUsed >= nextState.limits.maxTurns) {
      setTerminal(nextState, 'failed', 'turn_limit_exceeded');
    }

    await persist(nextState);
    if (state.lifecycle.status === 'running') scheduleTurn();
    else await releaseRuntimeLease();
  }

  async function runTurn() {
    if (!state || state.lifecycle.status !== 'running') return;
    if (state.limits.turnsUsed >= state.limits.maxTurns) {
      const exhausted = mutableState();
      setTerminal(exhausted, 'failed', 'turn_limit_exceeded');
      await persist(exhausted);
      await releaseRuntimeLease();
      return;
    }
    if (remainingRunMilliseconds() <= 0) {
      const expired = mutableState();
      setTerminal(expired, 'failed', 'run_timeout');
      await persist(expired);
      await releaseRuntimeLease();
      return;
    }

    const turnVersion = interruptionVersion;
    let connected;
    try {
      connected = await boundedOperation(
        (signal) => adapter.isConnected({ signal }),
        state.limits.actionTimeoutMs,
        'LLM_AGENT_CONNECTION_TIMEOUT',
        'agent connection check timed out'
      );
    } catch (error) {
      if (turnVersion !== interruptionVersion) return;
      await persistControllerFailure(error, 'connection_failure');
      return;
    }
    if (turnVersion !== interruptionVersion) return;
    if (!connected) {
      await stopForConnection('disconnected:not connected');
      return;
    }

    let observation;
    try {
      observation = await boundedOperation(
        (signal) => adapter.observe({ signal }),
        state.limits.actionTimeoutMs,
        'LLM_AGENT_OBSERVATION_TIMEOUT',
        'agent observation timed out'
      );
    } catch (error) {
      if (turnVersion !== interruptionVersion) return;
      await persistControllerFailure(error, 'observation_failure');
      return;
    }
    if (turnVersion !== interruptionVersion) return;

    const observed = mutableState();
    appendObservation(observed, observation);
    observed.lifecycle.updatedAt = nowIso();
    observed.trusted.phase = 'deciding';
    await persist(observed);
    if (turnVersion !== interruptionVersion) return;

    let rawDecision;
    try {
      const operation = (signal) => provider.decide(toDecisionContext(state, observation), { signal });
      operation.interruptionVersion = turnVersion;
      rawDecision = await boundedOperation(
        operation,
        state.limits.decisionTimeoutMs,
        'LLM_AGENT_DECISION_TIMEOUT',
        'agent decision timed out'
      );
    } catch (error) {
      if (turnVersion !== interruptionVersion) return;
      const next = mutableState();
      next.limits.turnsUsed += 1;
      const code = errorCode(error, 'LLM_AGENT_PROVIDER_FAILED');
      appendResult(next, { ok: false, code, message: errorMessage(error, 'decision provider failed') });
      setTerminal(next, 'failed', `provider_failure:${code}`);
      await persist(next);
      await releaseRuntimeLease();
      return;
    }
    if (turnVersion !== interruptionVersion) return;

    let validatedDecision;
    try {
      validatedDecision = validateDecision(rawDecision, observation);
    } catch (error) {
      const next = mutableState();
      next.limits.turnsUsed += 1;
      next.limits.invalidResponses += 1;
      appendResult(next, {
        ok: false,
        code: 'LLM_AGENT_DECISION_INVALID',
        message: errorMessage(error, 'decision was invalid')
      });
      next.lifecycle.updatedAt = nowIso();
      next.trusted.phase = 'decision_rejected';
      if (next.limits.invalidResponses >= next.limits.maxInvalidResponses) {
        setTerminal(next, 'failed', 'invalid_response_limit');
      } else if (next.limits.turnsUsed >= next.limits.maxTurns) {
        setTerminal(next, 'failed', 'turn_limit_exceeded');
      }
      await persist(next);
      if (state.lifecycle.status === 'running') scheduleTurn();
      else await releaseRuntimeLease();
      return;
    }

    const next = mutableState();
    next.limits.turnsUsed += 1;
    next.working = {
      summary: validatedDecision.summary,
      plan: [...validatedDecision.plan],
      subgoal: validatedDecision.subgoal,
      variables: structuredClone(validatedDecision.variables)
    };

    let result;
    if (validatedDecision.action === 'finish') {
      let postObservation;
      try {
        postObservation = await boundedOperation(
          (signal) => adapter.observe({ signal }),
          state.limits.actionTimeoutMs,
          'LLM_AGENT_OBSERVATION_TIMEOUT',
          'agent observation timed out'
        );
        if (turnVersion !== interruptionVersion) return;
        const operation = (signal) => adapter.verifyGoal(state.goal, { signal });
        operation.interruptionVersion = turnVersion;
        const verified = await boundedOperation(
          operation,
          state.limits.actionTimeoutMs,
          'LLM_AGENT_ACTION_TIMEOUT',
          'goal verification timed out'
        );
        if (turnVersion !== interruptionVersion) return;
        const proof = verifiedGoalResult(verified, state.goal, next.trusted.milestones);
        result = {
          action: 'finish',
          ok: proof !== null,
          code: proof !== null ? 'GOAL_VERIFIED' : 'GOAL_NOT_VERIFIED',
          message: proof !== null ? 'goal verified from the live world' : 'goal is not yet verified'
        };
        if (proof !== null) stampEvidence(next, { goalProof: proof });
      } catch (error) {
        if (turnVersion !== interruptionVersion) return;
        result = failedActionResult(validatedDecision, error);
      }
      await finishTurn(next, result, postObservation);
      return;
    }

    let receipt;
    let executionError;
    try {
      const operation = (signal) => adapter.execute(validatedDecision, { signal });
      operation.interruptionVersion = turnVersion;
      receipt = await boundedOperation(
        operation,
        state.limits.actionTimeoutMs,
        'LLM_AGENT_ACTION_TIMEOUT',
        'agent action timed out'
      );
      if (turnVersion !== interruptionVersion) return;
    } catch (error) {
      if (turnVersion !== interruptionVersion) return;
      executionError = error;
      receipt = failedActionResult(validatedDecision, error);
    }

    let postObservation;
    try {
      postObservation = await boundedOperation(
        (signal) => adapter.observe({ signal }),
        state.limits.actionTimeoutMs,
        'LLM_AGENT_OBSERVATION_TIMEOUT',
        'agent observation timed out'
      );
    } catch (error) {
      if (turnVersion !== interruptionVersion) return;
      result = failedActionResult(validatedDecision, error);
    }
    if (turnVersion !== interruptionVersion) return;
    if (postObservation !== undefined) {
      try {
        const verification = await boundedOperation(
          (signal) => adapter.verifyAction(validatedDecision, {
            before: structuredClone(observation),
            after: structuredClone(postObservation),
            receipt: structuredClone(receipt)
          }, { signal }),
          state.limits.actionTimeoutMs,
          'LLM_AGENT_ACTION_TIMEOUT',
          'agent action verification timed out'
        );
        if (turnVersion !== interruptionVersion) return;
        result = verifiedActionResult(validatedDecision, verification);
      } catch (error) {
        if (turnVersion !== interruptionVersion) return;
        result = failedActionResult(validatedDecision, error);
      }
    }
    if (executionError?.code === 'LLM_AGENT_ACTION_TIMEOUT' || executionError?.code === 'LLM_AGENT_RUN_TIMEOUT') {
      result = failedActionResult(validatedDecision, executionError);
    }
    await finishTurn(next, result, postObservation);
  }

  async function loadState() {
    const loaded = await store.load(actorId);
    state = loaded === null ? null : validateActorState(loaded);
    return state;
  }

  function start() {
    return enqueue(async () => {
      const acquiredHere = await acquireRuntimeLease();
      try {
        const existing = await store.load(actorId);
        if (existing?.lifecycle?.status === 'running') {
          throw coded('LLM_AGENT_ALREADY_RUNNING', 'actor already has a running agent');
        }
        const timestamp = nowIso();
        const initial = structuredClone(createInitialActorState({
          actorId,
          runId: randomUUID(),
          now: timestamp,
          goal
        }));
        if (existing !== null) initial.working = structuredClone(validateActorState(existing).working);
        initial.lifecycle.status = 'running';
        initial.lifecycle.startedAt = timestamp;
        initial.lifecycle.updatedAt = timestamp;
        initial.trusted.phase = 'starting';
        stampEvidence(initial, { goalProof: null });
        applyConfiguredLimits(initial);
        await persist(initial);
        scheduleTurn();
        return state;
      } catch (error) {
        if (acquiredHere) await releaseRuntimeLease();
        throw error;
      }
    });
  }

  function status() {
    return enqueue(async () => {
      if (state === null) await loadState();
      return state;
    });
  }

  function stop(reason = 'operator requested stop') {
    interruptActive();
    return enqueue(async () => {
      await acquireRuntimeLease();
      try {
        if (state === null) await loadState();
        if (state === null) return null;
        return await stopForConnection(`stopped:${String(reason)}`);
      } finally {
        await releaseRuntimeLease();
      }
    });
  }

  function resume() {
    return enqueue(async () => {
      const acquiredHere = await acquireRuntimeLease();
      try {
        if (state === null) await loadState();
        if (state === null) throw coded('LLM_AGENT_STATE_MISSING', 'actor has no persisted state to resume');
        if (state.lifecycle.status !== 'stopped' && state.lifecycle.status !== 'running') {
          throw coded('LLM_AGENT_NOT_RESUMABLE', `cannot resume actor in ${state.lifecycle.status} state`);
        }
        const next = mutableState();
        const timestamp = nowIso();
        next.lifecycle.status = 'running';
        next.lifecycle.updatedAt = timestamp;
        next.lifecycle.finishedAt = null;
        next.trusted.phase = 'resuming';
        next.limits.deadline = new Date(nowMs() + next.limits.runTimeoutMs).toISOString();
        await persist(next);
        scheduleTurn();
        return state;
      } catch (error) {
        if (acquiredHere) await releaseRuntimeLease();
        throw error;
      }
    });
  }

  function reset() {
    interruptActive();
    return enqueue(async () => {
      await acquireRuntimeLease();
      try {
        await store.reset(actorId);
        state = null;
      } finally {
        await releaseRuntimeLease();
      }
    });
  }

  function handleDeath() {
    interruptActive();
    return enqueue(async () => {
      await acquireRuntimeLease();
      try {
        if (state === null) await loadState();
        if (state === null) return null;
        return await stopForConnection('dead');
      } finally {
        await releaseRuntimeLease();
      }
    });
  }

  function handleDisconnect(reason = 'connection lost') {
    interruptActive();
    return enqueue(async () => {
      await acquireRuntimeLease();
      try {
        if (state === null) await loadState();
        if (state === null) return null;
        return await stopForConnection(`disconnected:${String(reason)}`);
      } finally {
        await releaseRuntimeLease();
      }
    });
  }

  function awaitIdle() {
    if (pendingTasks === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.add(resolve));
  }

  return Object.freeze({
    start,
    status,
    stop,
    resume,
    reset,
    handleDeath,
    handleDisconnect,
    awaitIdle
  });
}
