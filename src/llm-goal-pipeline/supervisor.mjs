import { compileGeneratedContract } from './compiler.mjs';
import { createContractRequestFences } from './contracts.mjs';
import { createInitialPipelineState, validatePipelineState } from './state.mjs';

const REGISTRY_VERSION = 1;
const LEASE_MS = 900_000;
const CONTRACT_MS = 300_000;

function coded(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function requirePort(value, label, methods) {
  if (!value || typeof value !== 'object' || methods.some((method) => typeof value[method] !== 'function')) {
    throw new TypeError(`${label} is invalid`);
  }
}

function iso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(coded('PIPELINE_SUPERVISOR_ABORTED', 'supervisor operation was aborted'));
  return Promise.race([
    promise,
    new Promise((_, reject) => signal.addEventListener('abort', () => {
      reject(coded('PIPELINE_SUPERVISOR_ABORTED', 'supervisor operation was aborted'));
    }, { once: true }))
  ]);
}

function clone(value) {
  return value === null ? null : structuredClone(value);
}

export function createGoalPipelineSupervisor({
  actorId, ownerId, store, slowProvider, fastRunner, adapter,
  compile = compileGeneratedContract, permissions, remainingLimits,
  onVerifiedOutcome = async () => {}, missionComplete = () => false,
  clock = { now: () => Date.now() },
  timers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout }
} = {}) {
  if (typeof actorId !== 'string' || actorId.length === 0) throw new TypeError('actorId must be a nonempty string');
  if (typeof ownerId !== 'string' || ownerId.length === 0) throw new TypeError('ownerId must be a nonempty string');
  requirePort(store, 'store', ['load', 'save', 'reset', 'acquireLease', 'releaseLease']);
  requirePort(slowProvider, 'slowProvider', ['generate']);
  requirePort(fastRunner, 'fastRunner', ['run', 'stop']);
  requirePort(adapter, 'adapter', ['observe', 'cancel']);
  if (typeof compile !== 'function') throw new TypeError('compile must be a function');
  if (typeof remainingLimits !== 'function') throw new TypeError('remainingLimits must be a function');
  if (typeof onVerifiedOutcome !== 'function') throw new TypeError('onVerifiedOutcome must be a function');
  if (typeof missionComplete !== 'function') throw new TypeError('missionComplete must be a function');
  if (!clock || typeof clock.now !== 'function') throw new TypeError('clock.now must be a function');
  requirePort(timers, 'timers', ['setTimeout', 'clearTimeout']);

  let state = null;
  let running = false;
  let runPromise = null;
  let supervisorAbort = null;
  let slowAbort = null;
  let speculativePromise = null;
  let speculativeCompiled = null;
  let currentQuestion = null;
  let sequence = 0;
  let queue = Promise.resolve();

  function enqueue(operation) {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  }

  async function replace(mutator) {
    return enqueue(async () => {
      const draft = clone(state);
      const now = clock.now();
      if (draft.lifecycle.status === 'running') {
        const elapsed = Math.max(0, now - Date.parse(draft.lifecycle.updatedAt));
        draft.counters.runtimeMs = Math.min(
          draft.limits.maximumRuntimeMs,
          draft.counters.runtimeMs + elapsed
        );
      }
      mutator(draft);
      draft.lifecycle.updatedAt = iso(now);
      state = validatePipelineState(draft);
      await store.save(actorId, state);
      return state;
    });
  }

  function fencesFor(snapshot, predecessorContractId) {
    sequence += 1;
    return createContractRequestFences({
      contractId: `contract-${state.mission.version}-${sequence}`,
      missionVersion: state.mission.version,
      observationVersion: snapshot.observationVersion,
      predecessorContractId,
      registryVersion: REGISTRY_VERSION,
      now: iso(clock.now())
    });
  }

  function slot(proposal, fences, status) {
    return {
      status, proposal: clone(proposal), fences: clone(fences),
      compiledAt: iso(clock.now()), expiresAt: iso(clock.now() + CONTRACT_MS)
    };
  }

  function auditEvent(kind, fences, relatedObservationVersion = null) {
    return {
      kind,
      contractId: fences.contractId,
      predecessorContractId: fences.predecessorContractId,
      observationVersion: fences.observationVersion,
      relatedObservationVersion,
      observedAt: iso(clock.now())
    };
  }

  function appendAudit(draft, event) {
    draft.audit = [...draft.audit, event].slice(-40);
  }

  function generationContext(snapshot, fences, predecessor, questionAnswer) {
    return {
      actorId, mission: clone(state.mission), observation: clone(snapshot), fences,
      predecessor: clone(predecessor), outcomes: clone(state.outcomes), permissions: clone(permissions),
      remainingLimits: clone(remainingLimits(state)), questionAnswer: clone(questionAnswer)
    };
  }

  async function selectQuestion(choiceId, usedDefault) {
    const pending = currentQuestion;
    if (!pending || pending.settled) throw coded('PIPELINE_NO_PENDING_QUESTION', 'no pending question is available');
    const choice = pending.choices.find(({ id }) => id === choiceId);
    if (!choice) throw coded('PIPELINE_QUESTION_CHOICE_INVALID', 'question choice is invalid');
    pending.settled = true;
    timers.clearTimeout(pending.timer);
    await replace((draft) => {
      if (!draft.pendingQuestion || draft.pendingQuestion.contractId !== pending.contractId) {
        throw coded('PIPELINE_NO_PENDING_QUESTION', 'no pending question is available');
      }
      draft.pendingQuestion.answeredChoiceId = choice.id;
    });
    currentQuestion = null;
    pending.resolve({ contractId: pending.contractId, choiceId: choice.id, label: choice.label, usedDefault });
  }

  async function presentQuestion(proposal, signal) {
    if (currentQuestion) throw coded('PIPELINE_QUESTION_PENDING', 'a question is already pending');
    const question = proposal.question;
    await replace((draft) => {
      draft.pendingQuestion = {
        contractId: proposal.contractId,
        prompt: question.prompt,
        choices: clone(question.choices),
        defaultChoiceId: question.defaultChoiceId,
        expiresAt: iso(clock.now() + question.timeoutSeconds * 1_000),
        answeredChoiceId: null
      };
    });
    return new Promise((resolve, reject) => {
      const pending = {
        contractId: proposal.contractId, choices: clone(question.choices),
        defaultChoiceId: question.defaultChoiceId, resolve, reject, settled: false, timer: null
      };
      currentQuestion = pending;
      pending.timer = timers.setTimeout(() => {
        selectQuestion(pending.defaultChoiceId, true).catch(reject);
      }, question.timeoutSeconds * 1_000);
      signal.addEventListener('abort', () => {
        if (pending.settled) return;
        pending.settled = true;
        timers.clearTimeout(pending.timer);
        if (currentQuestion === pending) currentQuestion = null;
        reject(coded('PIPELINE_SUPERVISOR_ABORTED', 'question was invalidated'));
      }, { once: true });
    });
  }

  async function generate(snapshot, predecessor, { speculative, questionAnswer = null }) {
    if (state.counters.slowCalls >= state.limits.maximumSlowCalls) {
      throw coded('PIPELINE_SLOW_CALL_LIMIT', 'slow call ceiling is exhausted');
    }
    const fences = fencesFor(snapshot, predecessor?.contractId ?? null);
    const controller = new AbortController();
    slowAbort = controller;
    await replace((draft) => {
      draft.counters.slowCalls += 1;
      appendAudit(draft, auditEvent('generation_started', fences));
    });
    try {
      const proposal = await abortable(
        Promise.resolve(slowProvider.generate(generationContext(snapshot, fences, predecessor, questionAnswer), { signal: controller.signal })),
        controller.signal
      );
      if (controller.signal.aborted || fences.missionVersion !== state.mission.version) {
        throw coded('PIPELINE_STALE_GENERATION', 'generated contract fences are stale');
      }
      await replace((draft) => { appendAudit(draft, auditEvent('generation_completed', fences)); });
      if (proposal.question) {
        const selected = await presentQuestion(proposal, controller.signal);
        await replace((draft) => { draft.pendingQuestion = null; });
        const fresh = await abortable(Promise.resolve(adapter.observe({ signal: controller.signal })), controller.signal);
        return generate(fresh, predecessor, { speculative, questionAnswer: selected });
      }
      if (speculative) {
        await replace((draft) => { draft.speculativeContract = slot(proposal, fences, 'speculative'); });
        return { proposal, fences };
      }
      const compiled = compile({
        proposal, fences, snapshot, permissions, remainingLimits: remainingLimits(state),
        context: { outcomes: state.outcomes }
      });
      return { proposal, fences, compiled };
    } finally {
      if (slowAbort === controller) slowAbort = null;
    }
  }

  async function generateWithRecovery(snapshot, predecessor, options) {
    while (!supervisorAbort.signal.aborted) {
      try {
        const generated = await generate(snapshot, predecessor, options);
        if (state.counters.consecutiveGenerationFailures > 0) {
          await replace((draft) => { draft.counters.consecutiveGenerationFailures = 0; });
        }
        return generated;
      } catch (error) {
        if (error?.code === 'PIPELINE_SUPERVISOR_ABORTED' || error?.code === 'PIPELINE_STALE_GENERATION') throw error;
        if (error?.code === 'PIPELINE_SLOW_CALL_LIMIT') {
          await pauseForCeiling(['slowCalls', 'maximumSlowCalls']);
          return null;
        }
        const nextCount = state.counters.consecutiveGenerationFailures + 1;
        await replace((draft) => {
          draft.counters.consecutiveGenerationFailures = nextCount;
          draft.failureFences = [...draft.failureFences, {
            kind: 'generation', key: `mission:${draft.mission.version}`,
            code: error?.code ?? 'PIPELINE_GENERATION_FAILED', count: nextCount,
            observedAt: iso(clock.now())
          }].slice(-10);
          if (nextCount >= draft.limits.maximumGenerationFailures) {
            draft.lifecycle.status = 'paused';
            draft.lifecycle.finishedAt = iso(clock.now());
            draft.failure = {
              code: 'PIPELINE_GENERATION_LIMIT',
              message: 'consecutive contract generation failures reached the safety ceiling',
              observedAt: iso(clock.now())
            };
          }
        });
        if (nextCount >= state.limits.maximumGenerationFailures) return null;
      }
    }
    throw coded('PIPELINE_SUPERVISOR_ABORTED', 'supervisor operation was aborted');
  }

  function launchSpeculative(snapshot, active) {
    if (speculativePromise || state.speculativeContract) return;
    const predecessor = {
      contractId: active.contractId, status: 'succeeded',
      proofKinds: [...active.expectedOutcome.proofKinds]
    };
    speculativePromise = generateWithRecovery(snapshot, predecessor, { speculative: true })
      .catch(() => null);
  }

  function outcomeFor(contract, result) {
    const status = ['succeeded', 'failed', 'stopped'].includes(result?.status) ? result.status : 'failed';
    const proofKinds = Array.isArray(result?.proofKinds) && result.proofKinds.length > 0
      ? result.proofKinds : [`goal:${status}`];
    return {
      contractId: contract.contractId, status, proofKinds,
      summary: result?.code ?? status, completedAt: iso(clock.now())
    };
  }

  function reachedGlobalCeiling(value) {
    const checks = [
      ['runtimeMs', 'maximumRuntimeMs'], ['goalsCompleted', 'maximumGoals'],
      ['slowCalls', 'maximumSlowCalls'], ['fastCalls', 'maximumFastCalls'],
      ['consecutiveGoalFailures', 'maximumGoalFailures'],
      ['consecutiveGenerationFailures', 'maximumGenerationFailures']
    ];
    return checks.find(([counter, limit]) => value.counters[counter] >= value.limits[limit]) ?? null;
  }

  async function pauseForCeiling([counter, limit]) {
    await replace((draft) => {
      draft.lifecycle.status = 'paused';
      draft.lifecycle.finishedAt = iso(clock.now());
      draft.speculativeContract = null;
      draft.pendingQuestion = null;
      draft.failure = {
        code: 'PIPELINE_GLOBAL_LIMIT',
        message: `${counter} reached ${limit}`,
        observedAt: iso(clock.now())
      };
    });
  }

  async function recordFastCall() {
    if (state.counters.fastCalls >= state.limits.maximumFastCalls) {
      throw coded('PIPELINE_FAST_CALL_LIMIT', 'fast call ceiling is exhausted');
    }
    await replace((draft) => { draft.counters.fastCalls += 1; });
  }

  function predecessorMatches(proposal, outcome) {
    return outcome.status === 'succeeded'
      && proposal.predecessor.contractId === outcome.contractId
      && proposal.predecessor.proofKinds.every((kind) => outcome.proofKinds.includes(kind));
  }

  async function executeLoop(initial, signal) {
    let current = initial;
    while (!signal.aborted) {
      await replace((draft) => {
        draft.lifecycle.status = 'running';
        draft.activeContract = slot(current.proposal, current.fences, 'executing');
        draft.speculativeContract = null;
        draft.pendingQuestion = null;
        appendAudit(draft, auditEvent('execution_started', current.fences));
      });
      launchSpeculative(current.snapshot, current.compiled);
      const result = await abortable(Promise.resolve(fastRunner.run(current.compiled, {
        signal, onFastCall: recordFastCall
      })), signal);
      const outcome = outcomeFor(current.compiled, result);
      await replace((draft) => {
        draft.outcomes = [...draft.outcomes, outcome].slice(-5);
        draft.activeContract.status = outcome.status;
        if (outcome.status === 'succeeded') {
          draft.counters.goalsCompleted += 1;
          draft.counters.consecutiveGoalFailures = 0;
        } else if (outcome.status === 'failed') {
          draft.counters.consecutiveGoalFailures += 1;
          if (draft.counters.consecutiveGoalFailures >= draft.limits.maximumGoalFailures) {
            draft.lifecycle.status = 'paused';
            draft.lifecycle.finishedAt = iso(clock.now());
            draft.failure = {
              code: 'PIPELINE_GOAL_FAILURE_LIMIT',
              message: 'consecutive goal failures reached the safety ceiling',
              observedAt: iso(clock.now())
            };
            draft.speculativeContract = null;
          }
        }
      });
      if (outcome.status === 'succeeded') {
        await onVerifiedOutcome({
          actorId, mission: clone(state.mission), contract: clone(current.compiled),
          outcome: clone(outcome), result: clone(result)
        });
        if (missionComplete({
          mission: clone(state.mission), outcome: clone(outcome), result: clone(result),
          pipelineState: clone(state)
        })) {
          slowAbort?.abort();
          await speculativePromise;
          speculativePromise = null;
          await replace((draft) => {
            draft.lifecycle.status = 'succeeded';
            draft.lifecycle.finishedAt = iso(clock.now());
            draft.activeContract = null;
            draft.speculativeContract = null;
            draft.pendingQuestion = null;
          });
          break;
        }
      }
      const terminalCeiling = reachedGlobalCeiling(state);
      if (terminalCeiling && state.lifecycle.status === 'running') await pauseForCeiling(terminalCeiling);
      if (state.lifecycle.status === 'paused') {
        slowAbort?.abort();
        await speculativePromise;
        speculativePromise = null;
        await replace((draft) => { draft.speculativeContract = null; draft.pendingQuestion = null; });
        break;
      }
      if (outcome.status === 'stopped' || signal.aborted) break;
      if (outcome.status === 'failed') {
        slowAbort?.abort();
        await speculativePromise;
        speculativePromise = null;
        await replace((draft) => { draft.speculativeContract = null; draft.pendingQuestion = null; });
        const snapshot = await abortable(Promise.resolve(adapter.observe({ signal })), signal);
        const predecessor = [...state.outcomes].reverse().find(({ status }) => status === 'succeeded') ?? null;
        const recovery = await generateWithRecovery(snapshot, predecessor, { speculative: false });
        if (!recovery) break;
        current = { ...recovery, snapshot };
        continue;
      }
      const speculative = await speculativePromise;
      speculativePromise = null;
      if (!speculative || !predecessorMatches(speculative.proposal, outcome)
        || speculative.fences.missionVersion !== state.mission.version
        || Date.parse(state.speculativeContract?.expiresAt ?? '') <= clock.now()) {
        await replace((draft) => { draft.speculativeContract = null; });
        const snapshot = await abortable(Promise.resolve(adapter.observe({ signal })), signal);
        const replacement = await generateWithRecovery(snapshot, outcome, { speculative: false });
        if (!replacement) break;
        current = { ...replacement, snapshot };
        continue;
      }
      const snapshot = await abortable(Promise.resolve(adapter.observe({ signal })), signal);
      try {
        const promotionFences = createContractRequestFences({
          ...speculative.fences,
          observationVersion: snapshot.observationVersion,
          now: iso(clock.now())
        });
        speculativeCompiled = compile({
          proposal: speculative.proposal, fences: promotionFences, snapshot,
          permissions, remainingLimits: remainingLimits(state), context: { outcomes: state.outcomes }
        });
        await replace((draft) => {
          appendAudit(draft, auditEvent(
            'promotion_validated', speculative.fences, snapshot.observationVersion
          ));
        });
        speculative.fences = promotionFences;
      } catch {
        await replace((draft) => { draft.speculativeContract = null; });
        const replacement = await generateWithRecovery(snapshot, outcome, { speculative: false });
        if (!replacement) break;
        current = { ...replacement, snapshot };
        continue;
      }
      current = { ...speculative, compiled: speculativeCompiled, snapshot };
      speculativeCompiled = null;
    }
  }

  async function run(mission) {
    const now = clock.now();
    await store.acquireLease(actorId, { ownerId, acquiredAt: iso(now), expiresAt: iso(now + LEASE_MS) });
    try {
      state = await store.load(actorId);
      if (!state) state = createInitialPipelineState({ actorId, mission, now: iso(now) });
      const initialCeiling = reachedGlobalCeiling(state);
      if (initialCeiling) {
        await pauseForCeiling(initialCeiling);
        return state;
      }
      await replace((draft) => {
        draft.lifecycle.status = 'running';
        draft.lifecycle.startedAt ??= iso(now);
        draft.lifecycle.finishedAt = null;
      });
      const resumedCeiling = reachedGlobalCeiling(state);
      if (resumedCeiling) {
        await pauseForCeiling(resumedCeiling);
        return state;
      }
      const signal = supervisorAbort.signal;
      const snapshot = await abortable(Promise.resolve(adapter.observe({ signal })), signal);
      const initial = await generateWithRecovery(snapshot, null, { speculative: false });
      if (!initial) return state;
      await executeLoop({ ...initial, snapshot }, signal);
      if (state.lifecycle.status === 'running') {
        await replace((draft) => {
          draft.lifecycle.status = draft.activeContract?.status === 'succeeded' ? 'succeeded' : 'stopped';
          draft.lifecycle.finishedAt = iso(clock.now());
          draft.speculativeContract = null;
        });
      }
    } catch (error) {
      if (error?.code === 'PIPELINE_SUPERVISOR_ABORTED' || supervisorAbort.signal.aborted) {
        if (state) await replace((draft) => {
          draft.lifecycle.status = 'stopped';
          draft.lifecycle.finishedAt = iso(clock.now());
          draft.speculativeContract = null;
        });
      } else {
        if (state) await replace((draft) => {
          draft.lifecycle.status = 'failed';
          draft.lifecycle.finishedAt = iso(clock.now());
          draft.failure = { code: error?.code ?? 'PIPELINE_SUPERVISOR_FAILED', message: error?.message ?? 'pipeline failed', observedAt: iso(clock.now()) };
        });
        throw error;
      }
    } finally {
      running = false;
      speculativePromise = null;
      slowAbort = null;
      if (currentQuestion) {
        timers.clearTimeout(currentQuestion.timer);
        currentQuestion = null;
      }
      await store.releaseLease(actorId, ownerId);
    }
    return state;
  }

  function start({ mission } = {}) {
    if (running) return Promise.reject(coded('PIPELINE_ALREADY_RUNNING', 'pipeline supervisor is already running'));
    if (typeof mission !== 'string' || mission.trim().length === 0 || Array.from(mission).length > 300) {
      return Promise.reject(coded('PIPELINE_MISSION_INVALID', 'mission is invalid'));
    }
    running = true;
    supervisorAbort = new AbortController();
    runPromise = run(mission);
    runPromise.catch(() => {});
    return runPromise;
  }

  async function updateMission(text, { urgent = false } = {}) {
    if (typeof text !== 'string' || text.trim().length === 0 || Array.from(text).length > 300) throw coded('PIPELINE_MISSION_INVALID', 'mission is invalid');
    if (!state) throw coded('PIPELINE_NOT_STARTED', 'pipeline has not started');
    slowAbort?.abort();
    await replace((draft) => {
      draft.mission = { text, version: draft.mission.version + 1 };
      draft.speculativeContract = null;
      draft.pendingQuestion = null;
    });
    if (urgent) {
      supervisorAbort?.abort();
      await fastRunner.stop('urgent mission update');
      await adapter.cancel('urgent mission update');
    }
    return state;
  }

  async function stop(reason = 'operator stop') {
    if (!running) return state;
    slowAbort?.abort();
    supervisorAbort?.abort();
    await fastRunner.stop(reason);
    await adapter.cancel(reason);
    try { await runPromise; } catch {}
    return state;
  }

  async function status() {
    await queue;
    return clone(state);
  }

  async function awaitIdle() {
    try { await runPromise; } catch {}
    return state;
  }

  async function reset() {
    if (running) throw coded('PIPELINE_ALREADY_RUNNING', 'stop the pipeline before reset');
    await store.reset(actorId);
    state = null;
  }

  async function resume() {
    if (running) throw coded('PIPELINE_ALREADY_RUNNING', 'pipeline supervisor is already running');
    const saved = await store.load(actorId);
    if (!saved) throw coded('PIPELINE_NOT_STARTED', 'no pipeline state exists');
    state = saved;
    return start({ mission: saved.mission.text });
  }

  async function answer(choiceId) {
    if (typeof choiceId !== 'string' || choiceId.length === 0) throw coded('PIPELINE_QUESTION_CHOICE_INVALID', 'question choice is invalid');
    await selectQuestion(choiceId, false);
    return state;
  }

  return Object.freeze({ start, updateMission, answer, status, stop, resume, reset, awaitIdle });
}
