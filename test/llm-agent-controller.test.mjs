import assert from 'node:assert/strict';
import test from 'node:test';

import { FIRST_GOAL_OBJECTIVE, createInitialActorState, validateActorState } from '../src/llm-agent/contracts.mjs';
import { createAgentController } from '../src/llm-agent/controller.mjs';
import { COLLECT_OAK_LOG_GOAL, PLACE_OAK_LOG_GOAL } from '../src/llm-agent/goals.mjs';

const goal = FIRST_GOAL_OBJECTIVE;
const goalProof = Object.freeze({
  markerTargetId: 'target-2-2', marker: { dimension: 'minecraft:overworld', x: 4, y: 64, z: 0 },
  markerBlock: 'gold_block', aboveBlock: 'oak_log'
});
const collectionGoalProof = Object.freeze({
  markerTargetId: 'target-2-2', marker: { dimension: 'minecraft:overworld', x: 4, y: 64, z: 0 },
  markerBlock: 'gold_block', aboveBlock: 'air', collectedItem: 'oak_log', collectedCount: 1
});
const firstObservation = {
  health: 20,
  food: 20,
  connected: true,
  dimension: 'overworld',
  inventory: [],
  targets: [{ id: 'oak-1', kind: 'block', block: 'oak_log', distanceBand: 'near', reachable: true }]
};

function clone(value) {
  return value === null ? null : structuredClone(value);
}

function decision(overrides = {}) {
  return {
    action: 'observe',
    reason: 'inspect the live world',
    summary: 'Checking the nearby area.',
    plan: ['inspect', 'act'],
    subgoal: 'inspect',
    variables: {},
    ...overrides
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function until(predicate, message = 'condition was not reached') {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

async function within(promise, timeoutMs = 100) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('test operation timed out')), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class MemoryStore {
  constructor(initial = null, events = []) {
    this.value = clone(initial);
    this.events = events;
    this.saved = [];
    this.concurrent = 0;
    this.maxConcurrent = 0;
    this.lease = null;
  }

  async #operation(kind, callback) {
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    this.events.push(`store:${kind}`);
    await Promise.resolve();
    try {
      return callback();
    } finally {
      this.concurrent -= 1;
    }
  }

  async load(actorId) {
    return this.#operation('load', () => {
      assert.equal(actorId, 'AgentOne');
      return clone(this.value);
    });
  }

  async save(actorId, state) {
    return this.#operation('save', () => {
      assert.equal(actorId, 'AgentOne');
      this.value = clone(validateActorState(state));
      this.saved.push(clone(this.value));
    });
  }

  async reset(actorId) {
    return this.#operation('reset', () => {
      assert.equal(actorId, 'AgentOne');
      this.value = null;
    });
  }

  async acquireLease(actorId, { ownerId, acquiredAt, expiresAt }) {
    return this.#operation('acquireLease', () => {
      assert.equal(actorId, 'AgentOne');
      if (this.lease && Date.parse(this.lease.expiresAt) > Date.parse(acquiredAt)) {
        throw Object.assign(new Error('actor runtime lease is held'), { code: 'LLM_AGENT_LEASE_HELD' });
      }
      this.lease = { actorId, ownerId, acquiredAt, expiresAt };
      return clone(this.lease);
    });
  }

  async releaseLease(actorId, ownerId) {
    return this.#operation('releaseLease', () => {
      assert.equal(actorId, 'AgentOne');
      if (this.lease?.ownerId !== ownerId) return false;
      this.lease = null;
      return true;
    });
  }
}

class FakeProvider {
  constructor(decisions = [], events = []) {
    this.decisions = [...decisions];
    this.events = events;
    this.contexts = [];
    this.signals = [];
  }

  async decide(context, { signal } = {}) {
    this.events.push('provider:decide');
    this.contexts.push(clone(context));
    this.signals.push(signal);
    const next = this.decisions.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next({ context, signal });
    if (next === undefined) throw Object.assign(new Error('no scripted decision'), { code: 'SCRIPT_EXHAUSTED' });
    return clone(next);
  }
}

class FakeAdapter {
  constructor({ observations = [firstObservation], results = [], verificationResults = [], goalResults = [{ ok: true, proof: goalProof }], expectedGoal = PLACE_OAK_LOG_GOAL, connected = true, events = [] } = {}) {
    this.observations = observations.map(clone);
    this.results = results.map(clone);
    this.verificationResults = verificationResults.map(clone);
    this.goalResults = [...goalResults];
    this.connected = connected;
    this.events = events;
    this.expectedGoal = clone(expectedGoal);
    this.executed = [];
    this.observeCalls = 0;
    this.verifyCalls = 0;
    this.actionVerifications = [];
  }

  isConnected(_options = {}) {
    this.events.push('adapter:isConnected');
    return this.connected;
  }

  async observe(_options = {}) {
    this.events.push('adapter:observe');
    const index = Math.min(this.observeCalls, this.observations.length - 1);
    this.observeCalls += 1;
    return clone(this.observations[index]);
  }

  async execute(action, { signal } = {}) {
    this.events.push(`adapter:execute:${action.action}`);
    this.executed.push(clone(action));
    if (signal?.aborted) throw Object.assign(new Error('action aborted'), { code: 'ACTION_ABORTED' });
    const result = this.results.shift();
    return clone(result ?? { ok: true, code: 'OK', message: 'verified' });
  }

  async verifyAction(action, evidence) {
    this.events.push(`adapter:verifyAction:${action.action}`);
    this.actionVerifications.push({ action: clone(action), evidence: clone(evidence) });
    const result = this.verificationResults.shift();
    return clone(result ?? evidence.receipt);
  }

  async verifyGoal(receivedGoal) {
    this.events.push('adapter:verifyGoal');
    assert.deepEqual(receivedGoal, this.expectedGoal);
    const index = Math.min(this.verifyCalls, this.goalResults.length - 1);
    this.verifyCalls += 1;
    return this.goalResults[index];
  }
}

function createHarness({ decisions, adapterOptions, store, limits, evidenceSource, providerKind, goalOverride = goal, events = [] } = {}) {
  const memoryStore = store ?? new MemoryStore(null, events);
  const provider = new FakeProvider(decisions, events);
  const adapter = new FakeAdapter({ expectedGoal: goalOverride === goal ? PLACE_OAK_LOG_GOAL : goalOverride, ...adapterOptions, events });
  const controller = createAgentController({
    actorId: 'AgentOne', goal: goalOverride, store: memoryStore, provider, adapter,
    clock: { now: () => new Date('2026-08-24T12:00:00.000Z') }, limits, evidenceSource, providerKind
  });
  return { controller, store: memoryStore, provider, adapter, events };
}

test('collection goal succeeds only with live proof and this run mining milestone', async () => {
  const mine = decision({ action: 'mine_block', targetId: 'oak-1', subgoal: 'collect marker log' });
  const finish = decision({ action: 'finish', plan: [], subgoal: '' });
  const { controller, store } = createHarness({
    goalOverride: COLLECT_OAK_LOG_GOAL,
    decisions: [mine, finish],
    adapterOptions: {
      expectedGoal: COLLECT_OAK_LOG_GOAL,
      verificationResults: [{
        ok: true, code: 'OAK_LOG_MINING_VERIFIED', message: 'live mining verified'
      }],
      goalResults: [{ ok: true, proof: collectionGoalProof }]
    },
    evidenceSource: 'mineflayer-live',
    providerKind: 'codex'
  });

  await controller.start();
  await controller.awaitIdle();

  assert.equal(store.value.lifecycle.status, 'succeeded');
  assert.deepEqual(store.value.trusted.milestones, ['mined_oak_log']);
  assert.deepEqual(store.value.trusted.evidence.goalProof, collectionGoalProof);
});

test('collection goal rejects a claimed proof without this run mining milestone', async () => {
  const { controller, store } = createHarness({
    goalOverride: COLLECT_OAK_LOG_GOAL,
    decisions: Array.from({ length: 12 }, () => decision({ action: 'finish', plan: [], subgoal: '' })),
    adapterOptions: {
      expectedGoal: COLLECT_OAK_LOG_GOAL,
      goalResults: [{ ok: true, proof: collectionGoalProof }]
    },
    evidenceSource: 'mineflayer-live',
    providerKind: 'codex'
  });

  await controller.start();
  await controller.awaitIdle();

  assert.equal(store.value.lifecycle.status, 'failed');
  assert.equal(store.value.trusted.evidence.goalProof, null);
});

test('observes and persists before each decision, then executes exactly one action', async () => {
  const events = [];
  const mine = decision({ action: 'mine_block', targetId: 'oak-1', summary: 'Found the tree.', subgoal: 'mine' });
  const finish = decision({ action: 'finish', reason: 'verify the placement', summary: 'The work is complete.', plan: [], subgoal: '' });
  const { controller, store, provider, adapter } = createHarness({ decisions: [mine, finish], events });

  await controller.start();
  await controller.awaitIdle();

  assert.deepEqual(adapter.executed, [mine]);
  assert.equal(provider.contexts.length, 2);
  assert.deepEqual(provider.contexts[0].observation, firstObservation);
  assert.ok(events.indexOf('adapter:observe') < events.indexOf('provider:decide'));
  assert.ok(events.indexOf('store:save') < events.indexOf('provider:decide'));
  assert.ok(adapter.observeCalls >= 4, 'each turn must have pre- and post-decision observations');
  assert.equal(store.value.lifecycle.status, 'succeeded');
  assert.deepEqual(store.value.trusted.recentActionResults.map(({ action, ok }) => ({ action, ok })), [
    { action: 'mine_block', ok: true },
    { action: 'finish', ok: true }
  ]);
});

test('passes trusted landmarks to the LLM and records verified landmark navigation', async () => {
  const landmarkObservation = {
    ...firstObservation,
    landmarks: [{
      reference: 'landmark:goal-marker', kind: 'gold_block', status: 'out_of_view', revisitable: true
    }]
  };
  const navigate = decision({
    action: 'navigate_to_landmark', reference: 'landmark:goal-marker', subgoal: 'return to marker'
  });
  const finish = decision({ action: 'finish', plan: [], subgoal: '' });
  const { controller, provider, adapter, store } = createHarness({
    decisions: [navigate, finish],
    adapterOptions: {
      observations: [landmarkObservation],
      verificationResults: [{
        ok: true, code: 'LANDMARK_NAVIGATION_VERIFIED', message: 'landmark reached'
      }]
    }
  });

  await controller.start();
  await controller.awaitIdle();

  assert.deepEqual(provider.contexts[0].observation.landmarks, landmarkObservation.landmarks);
  assert.deepEqual(adapter.executed, [navigate]);
  assert.equal(store.value.trusted.recentActionResults[0].reference, 'landmark:goal-marker');
});

test('stamps live controller evidence only after verified mining and goal proof', async () => {
  const mine = decision({ action: 'mine_block', targetId: 'oak-1', summary: 'Mine the oak.', subgoal: 'mine' });
  const finish = decision({ action: 'finish', reason: 'verify the marker', plan: [], subgoal: '' });
  const { controller, store } = createHarness({
    decisions: [mine, finish],
    evidenceSource: 'mineflayer-live',
    providerKind: 'codex',
    adapterOptions: {
      verificationResults: [{ ok: true, code: 'OAK_LOG_MINING_VERIFIED', message: 'live pickup verified' }],
      goalResults: [{ ok: true, proof: goalProof }]
    }
  });

  await controller.start();
  await controller.awaitIdle();

  assert.equal(store.value.lifecycle.status, 'succeeded');
  assert.deepEqual(store.value.trusted.milestones, ['mined_oak_log']);
  assert.deepEqual(store.value.trusted.evidence, {
    source: 'mineflayer-live', simulated: false, provider: 'codex', actorId: 'AgentOne', runId: store.value.lifecycle.runId,
    observedAt: '2026-08-24T12:00:00.000Z', goalProof
  });
});

test('rejects attempted trusted-state writes without executing an action', async () => {
  const invalid = {
    action: 'mine_block', targetId: 'oak-1', reason: 'need a log',
    summary: 'Found the tree.', plan: ['mine', 'place'], subgoal: 'mine', variables: { attempts: 1 },
    trusted: { status: 'succeeded' }
  };
  const finish = decision({ action: 'finish', plan: [], subgoal: '' });
  const { controller, store, adapter } = createHarness({ decisions: [invalid, finish] });

  await controller.start();
  await controller.awaitIdle();

  assert.deepEqual(adapter.executed, []);
  assert.equal(store.value.limits.turnsUsed, 2);
  assert.equal(store.value.limits.invalidResponses, 1);
  assert.equal(store.value.trusted.status, undefined);
  assert.deepEqual(store.value.trusted.recentActionResults.map(({ code }) => code), [
    'LLM_AGENT_DECISION_INVALID', 'GOAL_VERIFIED'
  ]);
});

test('persists validated LLM working state without allowing trusted-field mutation', async () => {
  const mine = decision({
    action: 'mine_block', targetId: 'oak-1', summary: 'Remember this tree.',
    plan: ['mine', 'place'], subgoal: 'mine', variables: { attempts: 1 }
  });
  const finish = decision({ action: 'finish', summary: 'Placed it.', plan: [], subgoal: '', variables: { attempts: 1 } });
  const { controller, store } = createHarness({ decisions: [mine, finish] });

  await controller.start();
  await controller.awaitIdle();

  const actionSave = store.saved.find((state) => state.trusted.recentActionResults.at(-1)?.action === 'mine_block');
  assert.deepEqual(actionSave.working, {
    summary: 'Remember this tree.', plan: ['mine', 'place'], subgoal: 'mine', variables: { attempts: 1 }
  });
  assert.equal(Object.hasOwn(actionSave.trusted, 'status'), false);
});

test('treats finish as a live verification request and succeeds only after proof', async () => {
  const finish = decision({ action: 'finish', reason: 'check the marker', plan: [], subgoal: '' });
  const { controller, store, adapter } = createHarness({
    decisions: [finish, finish],
    adapterOptions: { goalResults: [{ ok: false, proof: null }, { ok: true, proof: goalProof }] }
  });

  await controller.start();
  await controller.awaitIdle();

  assert.equal(adapter.verifyCalls, 2);
  assert.deepEqual(adapter.executed, []);
  assert.equal(store.value.lifecycle.status, 'succeeded');
  assert.deepEqual(store.value.trusted.recentActionResults.map(({ code }) => code), [
    'GOAL_NOT_VERIFIED', 'GOAL_VERIFIED'
  ]);
});

test('fails after the fixed twelve-turn ceiling without asking for a thirteenth decision', async () => {
  const { controller, store, provider, adapter } = createHarness({
    decisions: Array.from({ length: 13 }, () => decision()),
    adapterOptions: { goalResults: [{ ok: false, proof: null }] }
  });

  await controller.start();
  await controller.awaitIdle();

  assert.equal(provider.contexts.length, 12);
  assert.equal(adapter.executed.length, 12);
  assert.equal(store.value.limits.turnsUsed, 12);
  assert.equal(store.value.lifecycle.status, 'failed');
  assert.equal(store.value.trusted.phase, 'turn_limit_exceeded');
});

test('fails after three identical validated actions return the same verified error code', async () => {
  const mine = decision({ action: 'mine_block', targetId: 'oak-1' });
  const { controller, store, provider, adapter } = createHarness({
    decisions: [mine, mine, mine, mine],
    adapterOptions: { results: Array.from({ length: 4 }, () => ({ ok: false, code: 'BLOCK_UNREACHABLE', message: 'path blocked' })) }
  });

  await controller.start();
  await controller.awaitIdle();

  assert.equal(provider.contexts.length, 3);
  assert.equal(adapter.executed.length, 3);
  assert.equal(store.value.limits.repeatedFailures, 3);
  assert.equal(store.value.lifecycle.status, 'failed');
  assert.equal(store.value.trusted.phase, 'repeated_failure:BLOCK_UNREACHABLE');
});

test('persists every invalid response and stops at the invalid-response limit', async () => {
  const invalid = { action: 'teleport', reason: 'shortcut' };
  const { controller, store, provider, adapter } = createHarness({ decisions: [invalid, invalid, invalid, invalid] });

  await controller.start();
  await controller.awaitIdle();

  assert.equal(provider.contexts.length, 3);
  assert.deepEqual(adapter.executed, []);
  assert.equal(store.value.limits.invalidResponses, 3);
  assert.equal(store.value.lifecycle.status, 'failed');
  assert.equal(store.value.trusted.phase, 'invalid_response_limit');
  assert.deepEqual(new Set(store.saved
    .filter((state) => state.trusted.recentActionResults.at(-1)?.code === 'LLM_AGENT_DECISION_INVALID')
    .map((state) => state.limits.turnsUsed)), new Set([1, 2, 3]));
});

test('operator stop aborts a pending decision and persists stopped state without an action', async () => {
  const pending = deferred();
  let receivedSignal;
  const pendingDecision = ({ signal }) => {
    receivedSignal = signal;
    signal.addEventListener('abort', () => pending.reject(Object.assign(new Error('aborted'), { code: 'LLM_AGENT_PROVIDER_ABORTED' })), { once: true });
    return pending.promise;
  };
  const { controller, store, adapter } = createHarness({ decisions: [pendingDecision] });

  await controller.start();
  await until(() => receivedSignal);
  await controller.stop('operator requested stop');
  await controller.awaitIdle();

  assert.equal(receivedSignal.aborted, true);
  assert.deepEqual(adapter.executed, []);
  assert.equal(store.value.lifecycle.status, 'stopped');
  assert.equal(store.value.trusted.phase, 'stopped:operator requested stop');
});

test('death and disconnect abort pending work and remain resumable stopped states', async () => {
  for (const [method, expectedPhase] of [
    ['handleDeath', 'dead'],
    ['handleDisconnect', 'disconnected:socket closed']
  ]) {
    const pending = deferred();
    let signal;
    const { controller, store } = createHarness({ decisions: [({ signal: value }) => {
      signal = value;
      value.addEventListener('abort', () => pending.reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })), { once: true });
      return pending.promise;
    }] });
    await controller.start();
    await until(() => signal);
    if (method === 'handleDeath') await controller.handleDeath();
    else await controller.handleDisconnect('socket closed');
    await controller.awaitIdle();
    assert.equal(signal.aborted, true);
    assert.equal(store.value.lifecycle.status, 'stopped');
    assert.equal(store.value.trusted.phase, expectedPhase);
  }
});

test('late stop-class events cannot regress an already verified terminal outcome', async () => {
  const finish = decision({ action: 'finish', plan: [], subgoal: '' });
  const { controller, store } = createHarness({ decisions: [finish] });
  await controller.start();
  await controller.awaitIdle();
  assert.equal(store.value.lifecycle.status, 'succeeded');

  await controller.stop('late operator command');
  await controller.handleDeath();
  await controller.handleDisconnect('late socket event');

  assert.equal(store.value.lifecycle.status, 'succeeded');
  assert.equal(store.value.trusted.phase, 'goal_verified');
});

test('a new controller resumes persisted stopped state from a fresh observation', async () => {
  const stopped = structuredClone(createInitialActorState({
    actorId: 'AgentOne', runId: 'old-run', now: '2026-08-24T11:00:00.000Z', goal
  }));
  stopped.lifecycle.status = 'stopped';
  stopped.lifecycle.startedAt = '2026-08-24T11:00:00.000Z';
  stopped.lifecycle.updatedAt = '2026-08-24T11:05:00.000Z';
  stopped.trusted.phase = 'disconnected:restart';
  stopped.working.summary = 'I already found the marker.';
  const store = new MemoryStore(validateActorState(stopped));
  const fresh = { ...firstObservation, inventory: [{ item: 'oak_log', count: 1 }], targets: [] };
  const provider = new FakeProvider([decision({ action: 'finish', plan: [], subgoal: '' })]);
  const adapter = new FakeAdapter({ observations: [fresh], goalResults: [{ ok: true, proof: goalProof }] });
  const controller = createAgentController({
    actorId: 'AgentOne', goal, store, provider, adapter,
    clock: { now: () => new Date('2026-08-24T12:00:00.000Z') }
  });

  await controller.resume();
  await controller.awaitIdle();

  assert.deepEqual(provider.contexts[0].observation, fresh);
  assert.equal(provider.contexts[0].working.summary, 'I already found the marker.');
  assert.equal(store.value.lifecycle.status, 'succeeded');
});

test('serializes concurrent lifecycle commands through one state/store queue', async () => {
  const pending = deferred();
  const store = new MemoryStore();
  const provider = new FakeProvider([({ signal }) => {
    signal.addEventListener('abort', () => pending.reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })), { once: true });
    return pending.promise;
  }]);
  const adapter = new FakeAdapter();
  const controller = createAgentController({
    actorId: 'AgentOne', goal, store, provider, adapter,
    clock: { now: () => new Date('2026-08-24T12:00:00.000Z') }
  });

  const started = controller.start();
  const status = controller.status();
  const stopped = controller.stop('queued stop');
  const reset = controller.reset();
  await Promise.all([started, status, stopped, reset]);
  await controller.awaitIdle();

  assert.equal(store.maxConcurrent, 1);
  assert.equal(store.value, null);
  assert.deepEqual(adapter.executed, []);
});

test('provider failure records a terminal failure and never invents a fallback action', async () => {
  const providerError = Object.assign(new Error('Codex exited'), { code: 'LLM_AGENT_PROVIDER_FAILED' });
  const { controller, store, adapter } = createHarness({ decisions: [providerError] });

  await controller.start();
  await controller.awaitIdle();

  assert.deepEqual(adapter.executed, []);
  assert.equal(store.value.lifecycle.status, 'failed');
  assert.equal(store.value.trusted.phase, 'provider_failure:LLM_AGENT_PROVIDER_FAILED');
  assert.deepEqual(store.value.trusted.recentActionResults.at(-1), {
    ok: false, code: 'LLM_AGENT_PROVIDER_FAILED', message: 'Codex exited'
  });
});

test('action timeout aborts execution and records a verified bounded failure', async () => {
  let actionSignal;
  const pendingAction = deferred();
  const adapter = new FakeAdapter();
  adapter.execute = async (action, { signal }) => {
    adapter.executed.push(clone(action));
    actionSignal = signal;
    signal.addEventListener('abort', () => pendingAction.reject(Object.assign(new Error('action aborted'), { code: 'ACTION_ABORTED' })), { once: true });
    return pendingAction.promise;
  };
  const store = new MemoryStore();
  const provider = new FakeProvider([decision({ action: 'mine_block', targetId: 'oak-1' })]);
  const controller = createAgentController({
    actorId: 'AgentOne', goal, store, provider, adapter,
    clock: { now: () => new Date('2026-08-24T12:00:00.000Z') },
    limits: { actionTimeoutMs: 5 }
  });

  await controller.start();
  await controller.awaitIdle();

  assert.equal(actionSignal.aborted, true);
  assert.equal(store.value.lifecycle.status, 'failed');
  assert.equal(store.value.trusted.recentActionResults.at(-1).code, 'LLM_AGENT_ACTION_TIMEOUT');
});

test('operator stop aborts a never-resolving connectivity check', async () => {
  const pending = deferred();
  let connectionSignal;
  const adapter = new FakeAdapter();
  adapter.isConnected = ({ signal } = {}) => {
    connectionSignal = signal;
    return pending.promise;
  };
  const store = new MemoryStore();
  const controller = createAgentController({
    actorId: 'AgentOne', goal, store, provider: new FakeProvider([decision()]), adapter,
    clock: { now: () => new Date('2026-08-24T12:00:00.000Z') }
  });

  await controller.start();
  await until(() => connectionSignal !== undefined);
  await within(controller.stop('bounded stop'));
  await within(controller.awaitIdle());

  assert.equal(connectionSignal.aborted, true);
  assert.equal(store.value.lifecycle.status, 'stopped');
  assert.equal(store.lease, null);
});

test('death aborts a never-resolving pre-decision observation', async () => {
  const pending = deferred();
  let observationSignal;
  const adapter = new FakeAdapter();
  adapter.observe = ({ signal } = {}) => {
    observationSignal = signal;
    return pending.promise;
  };
  const store = new MemoryStore();
  const controller = createAgentController({
    actorId: 'AgentOne', goal, store, provider: new FakeProvider([decision()]), adapter,
    clock: { now: () => new Date('2026-08-24T12:00:00.000Z') }
  });

  await controller.start();
  await until(() => observationSignal !== undefined);
  await within(controller.handleDeath());
  await within(controller.awaitIdle());

  assert.equal(observationSignal.aborted, true);
  assert.equal(store.value.lifecycle.status, 'stopped');
  assert.equal(store.value.trusted.phase, 'dead');
  assert.equal(store.lease, null);
});

test('disconnect aborts a never-resolving post-action observation', async () => {
  const pending = deferred();
  let observationSignal;
  const adapter = new FakeAdapter();
  const originalObserve = adapter.observe.bind(adapter);
  adapter.observe = (options = {}) => {
    if (adapter.observeCalls === 0) return originalObserve(options);
    observationSignal = options.signal;
    return pending.promise;
  };
  const store = new MemoryStore();
  const controller = createAgentController({
    actorId: 'AgentOne', goal, store,
    provider: new FakeProvider([decision({ action: 'mine_block', targetId: 'oak-1' })]),
    adapter, clock: { now: () => new Date('2026-08-24T12:00:00.000Z') }
  });

  await controller.start();
  await until(() => observationSignal !== undefined);
  await within(controller.handleDisconnect('post-observation socket loss'));
  await within(controller.awaitIdle());

  assert.equal(observationSignal.aborted, true);
  assert.equal(store.value.lifecycle.status, 'stopped');
  assert.equal(store.value.trusted.phase, 'disconnected:post-observation socket loss');
  assert.equal(store.lease, null);
});

test('run deadline bounds never-resolving connectivity and observation ports', async (t) => {
  for (const port of ['isConnected', 'observe']) {
    await t.test(port, async () => {
      const pending = deferred();
      let signal;
      const adapter = new FakeAdapter();
      adapter[port] = ({ signal: receivedSignal } = {}) => {
        signal = receivedSignal;
        return pending.promise;
      };
      const store = new MemoryStore();
      const controller = createAgentController({
        actorId: 'AgentOne', goal, store, provider: new FakeProvider([decision()]), adapter,
        clock: { now: () => new Date('2026-08-24T12:00:00.000Z') }, limits: { runTimeoutMs: 5 }
      });

      await controller.start();
      await within(controller.awaitIdle());

      assert.equal(signal.aborted, true);
      assert.equal(store.value.lifecycle.status, 'failed');
      assert.match(store.value.trusted.phase, /LLM_AGENT_RUN_TIMEOUT/);
      assert.equal(store.lease, null);
    });
  }
});

test('only one concurrent controller can claim one actor runtime lease', async () => {
  const store = new MemoryStore();
  const makePendingController = () => {
    const pending = deferred();
    const provider = new FakeProvider([({ signal }) => {
      signal.addEventListener('abort', () => pending.reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })), { once: true });
      return pending.promise;
    }]);
    return createAgentController({
      actorId: 'AgentOne', goal, store, provider, adapter: new FakeAdapter(),
      clock: { now: () => new Date('2026-08-24T12:00:00.000Z') }
    });
  };
  const first = makePendingController();
  const second = makePendingController();

  const starts = await Promise.allSettled([first.start(), second.start()]);
  await Promise.allSettled([first.stop('test cleanup'), second.stop('test cleanup')]);
  await Promise.all([within(first.awaitIdle()), within(second.awaitIdle())]);

  assert.equal(starts.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejection = starts.find(({ status }) => status === 'rejected');
  assert.equal(rejection.reason.code, 'LLM_AGENT_LEASE_HELD');
  assert.equal(store.lease, null);
});

test('records only post-observation action verification, never a contradictory receipt', async (t) => {
  const mine = decision({ action: 'mine_block', targetId: 'oak-1' });
  await t.test('successful receipt rejected by verification', async () => {
    const { controller, store, adapter } = createHarness({
      decisions: [mine, decision({ action: 'finish', plan: [], subgoal: '' })],
      adapterOptions: {
        results: [{ ok: true, code: 'OK', message: 'receipt claims success' }],
        verificationResults: [false]
      }
    });
    await controller.start();
    await controller.awaitIdle();

    assert.deepEqual(store.value.trusted.recentActionResults[0], {
      action: 'mine_block', targetId: 'oak-1', ok: false,
      code: 'ACTION_NOT_VERIFIED', message: 'action result was not verified'
    });
    assert.deepEqual(adapter.actionVerifications[0].evidence.before, firstObservation);
    assert.deepEqual(adapter.actionVerifications[0].evidence.after, firstObservation);
  });

  await t.test('failure receipt superseded by successful verification', async () => {
    const { controller, store } = createHarness({
      decisions: [mine, decision({ action: 'finish', plan: [], subgoal: '' })],
      adapterOptions: {
        results: [{ ok: false, code: 'BLOCK_UNREACHABLE', message: 'receipt claims failure' }],
        verificationResults: [{ ok: true, code: 'ACTION_VERIFIED', message: 'world delta proved' }]
      }
    });
    await controller.start();
    await controller.awaitIdle();

    assert.deepEqual(store.value.trusted.recentActionResults[0], {
      action: 'mine_block', targetId: 'oak-1', ok: true,
      code: 'ACTION_VERIFIED', message: 'world delta proved'
    });
  });

  await t.test('malformed verification fails closed', async () => {
    const { controller, store } = createHarness({
      decisions: [mine, decision({ action: 'finish', plan: [], subgoal: '' })],
      adapterOptions: { verificationResults: [{ ok: true }] }
    });
    await controller.start();
    await controller.awaitIdle();

    assert.equal(store.value.trusted.recentActionResults[0].ok, false);
    assert.equal(store.value.trusted.recentActionResults[0].code, 'LLM_AGENT_ACTION_VERIFICATION_INVALID');
  });
});

test('rejects configured limits above the fixed safety maxima', () => {
  const tooHigh = {
    maxTurns: 13,
    decisionTimeoutMs: 30_001,
    actionTimeoutMs: 30_001,
    runTimeoutMs: 300_001,
    maxInvalidResponses: 4,
    maxIdenticalFailures: 4
  };
  for (const [field, value] of Object.entries(tooHigh)) {
    assert.throws(() => createHarness({ decisions: [], limits: { [field]: value } }), {
      name: 'TypeError'
    }, field);
  }
  assert.doesNotThrow(() => createHarness({ decisions: [], limits: {
    maxTurns: 12,
    decisionTimeoutMs: 30_000,
    actionTimeoutMs: 30_000,
    runTimeoutMs: 300_000,
    maxInvalidResponses: 3,
    maxIdenticalFailures: 3
  } }));
});

test('terminal persistence failures release an already-held owner lease', async (t) => {
  for (const event of ['stop', 'handleDeath', 'handleDisconnect']) {
    await t.test(event, async () => {
      const store = new MemoryStore();
      let activeSignal;
      const { controller } = createHarness({
        store,
        decisions: [({ signal }) => {
          activeSignal = signal;
          return new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(
              new Error('decision aborted'),
              { code: 'DECISION_ABORTED' }
            )), { once: true });
          });
        }]
      });

      await controller.start();
      await until(() => activeSignal, 'controller never entered its decision');
      const originalSave = store.save.bind(store);
      store.save = async () => {
        throw Object.assign(new Error('injected persistence failure'), { code: 'EIO' });
      };

      const terminalCall = event === 'stop'
        ? controller.stop('test stop')
        : event === 'handleDeath'
          ? controller.handleDeath()
          : controller.handleDisconnect('test disconnect');
      await assert.rejects(within(terminalCall), { code: 'EIO' });
      await within(controller.awaitIdle());
      store.save = originalSave;

      assert.equal(store.lease, null, 'the failing controller must release its owner lease');
      const { controller: replacement } = createHarness({
        store,
        decisions: [decision({ action: 'finish', plan: [], subgoal: '' })]
      });
      await replacement.resume();
      await within(replacement.awaitIdle());
      assert.equal(store.value.lifecycle.status, 'succeeded');
    });
  }
});

test('reset failure releases an already-held owner lease', async () => {
  const store = new MemoryStore();
  let activeSignal;
  const { controller } = createHarness({
    store,
    decisions: [({ signal }) => {
      activeSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(
          new Error('decision aborted'),
          { code: 'DECISION_ABORTED' }
        )), { once: true });
      });
    }]
  });

  await controller.start();
  await until(() => activeSignal, 'controller never entered its decision');
  const originalReset = store.reset.bind(store);
  store.reset = async () => {
    throw Object.assign(new Error('injected reset failure'), { code: 'EIO' });
  };

  await assert.rejects(within(controller.reset()), { code: 'EIO' });
  await within(controller.awaitIdle());
  store.reset = originalReset;

  assert.equal(store.lease, null, 'the failing controller must release its owner lease');
  const { controller: replacement } = createHarness({
    store,
    decisions: [decision({ action: 'finish', plan: [], subgoal: '' })]
  });
  await replacement.resume();
  await within(replacement.awaitIdle());
  assert.equal(store.value.lifecycle.status, 'succeeded');
});
