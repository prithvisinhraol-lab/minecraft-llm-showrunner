import { validateFastDecision } from './fast-contracts.mjs';

function coded(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

function requirePort(value, name, methods) {
  if (!value || typeof value !== 'object' || methods.some((method) => typeof value[method] !== 'function')) throw new TypeError(`${name} is invalid`);
}

export function createFastRunner({ actorId, provider, adapter, evaluateSuccess, clock = { now: () => Date.now() } } = {}) {
  if (typeof actorId !== 'string' || actorId.length === 0) throw new TypeError('actorId must be a nonempty string');
  requirePort(provider, 'provider', ['decide']);
  requirePort(adapter, 'adapter', ['observe', 'execute', 'verifyAction', 'isConnected', 'cancel']);
  if (typeof evaluateSuccess !== 'function') throw new TypeError('evaluateSuccess must be a function');
  if (!clock || typeof clock.now !== 'function') throw new TypeError('clock.now must be a function');

  let running = false;
  let activeAbort = null;
  let activePromise = null;
  let stopReason = null;
  let latest = null;

  function terminal(status, details = {}) {
    latest = Object.freeze({ status, ...structuredClone(details) });
    return latest;
  }

  async function executeRun(contract, externalSignal, onTransition, onFastCall) {
    const controller = new AbortController();
    activeAbort = controller;
    const relay = () => controller.abort();
    externalSignal?.addEventListener('abort', relay, { once: true });
    const signal = controller.signal;
    const started = clock.now();
    try {
      if (await adapter.isConnected({ signal }) !== true) throw coded('PIPELINE_ACTOR_DISCONNECTED', 'fast actor is disconnected');
      for (let turn = 0; turn < contract.budget.maximumActions; turn += 1) {
        if (clock.now() - started > contract.budget.maximumSeconds * 1_000) throw coded('PIPELINE_FAST_DEADLINE', 'fast contract deadline exceeded');
        onTransition({ phase: 'observing', turn });
        const before = await adapter.observe({ signal, contract });
        const beforeSuccess = evaluateSuccess(contract.success, before);
        if (beforeSuccess?.ok === true) return terminal('succeeded', { proofKinds: [...beforeSuccess.proofKinds], facts: structuredClone(beforeSuccess.facts) });
        onTransition({ phase: 'deciding', turn });
        await onFastCall({ turn });
        const decision = validateFastDecision(
          await provider.decide({ actorId, contract, authority: contract.authority, observation: before, turn }, { signal }),
          { authority: contract.authority, observation: before }
        );
        if (decision.decision !== 'act') {
          return terminal('failed', { code: decision.decision === 'finish' ? 'PIPELINE_GOAL_NOT_VERIFIED' : 'PIPELINE_FAST_DECLINED', proofKinds: [] });
        }
        onTransition({ phase: 'acting', turn });
        const receipt = await adapter.execute(decision.action, { signal, contract, before });
        const after = await adapter.observe({ signal, contract });
        onTransition({ phase: 'verifying_action', turn });
        const actionProof = await adapter.verifyAction(decision.action, receipt, before, after, { signal, contract });
        if (actionProof?.ok !== true) throw coded('PIPELINE_ACTION_NOT_VERIFIED', actionProof?.code ?? 'action was not verified');
        onTransition({ phase: 'verifying_goal', turn });
        const success = evaluateSuccess(contract.success, after);
        if (success?.ok === true) return terminal('succeeded', { proofKinds: [...success.proofKinds], facts: structuredClone(success.facts) });
      }
      return terminal('failed', { code: 'PIPELINE_ACTION_LIMIT', proofKinds: [] });
    } catch (error) {
      if (stopReason || signal.aborted) return terminal('stopped', { code: 'PIPELINE_FAST_STOPPED', reason: stopReason ?? 'aborted', proofKinds: [] });
      throw error;
    } finally {
      externalSignal?.removeEventListener('abort', relay);
      activeAbort = null;
      running = false;
    }
  }

  function run(contract, { signal, onTransition = () => {}, onFastCall = () => {} } = {}) {
    if (running) return Promise.reject(coded('PIPELINE_FAST_ALREADY_RUNNING', 'fast runner is already active'));
    if (!contract || typeof contract !== 'object' || !contract.budget || !contract.authority) return Promise.reject(coded('PIPELINE_CONTRACT_INVALID', 'fast contract is invalid'));
    if (typeof onTransition !== 'function') return Promise.reject(new TypeError('onTransition must be a function'));
    if (typeof onFastCall !== 'function') return Promise.reject(new TypeError('onFastCall must be a function'));
    running = true;
    stopReason = null;
    activePromise = executeRun(contract, signal, onTransition, onFastCall);
    activePromise.catch(() => {});
    return activePromise;
  }

  async function stop(reason = 'operator stop') {
    stopReason = reason;
    activeAbort?.abort();
    await adapter.cancel(reason);
    try { await activePromise; } catch {}
    return latest;
  }

  return Object.freeze({ run, stop, status: () => latest });
}
