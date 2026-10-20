import assert from 'node:assert/strict';
import test from 'node:test';

import { createGoalPipelineSupervisor } from '../src/llm-goal-pipeline/supervisor.mjs';
import { createInitialPipelineState, validatePipelineState } from '../src/llm-goal-pipeline/state.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function proposal(fences) {
  return {
    contractId: fences.contractId, missionVersion: fences.missionVersion,
    predecessor: { contractId: fences.predecessorContractId, status: 'succeeded', proofKinds: fences.predecessorContractId ? ['inventory_at_least:oak_log'] : ['mission:start'] },
    objective: 'Collect one oak log.', rationale: 'Begin bounded survival progress.',
    prerequisites: { predicate: 'actor_alive' },
    success: { predicate: 'inventory_at_least', item: 'oak_log', count: 1 },
    constraints: [{ rule: 'stay_within_radius', blocks: 16 }],
    capabilities: ['observe', 'mine_block'],
    budget: { maximumActions: 4, maximumReplans: 1, maximumSeconds: 30, maximumSearchRadius: 16, maximumTravelRadius: 16 },
    expectedOutcome: { summary: 'One oak log is held.', proofKinds: ['inventory_at_least:oak_log'] },
    question: null
  };
}

function questionProposal(fences) {
  return {
    ...proposal(fences),
    question: {
      prompt: 'Which safe opening should I use?',
      choices: [{ id: 'wood', label: 'Collect wood' }, { id: 'shelter', label: 'Find shelter' }],
      defaultChoiceId: 'wood', timeoutSeconds: 10
    }
  };
}

function dependencies() {
  const fastStarted = deferred();
  const finishFirst = deferred();
  const slowCalls = [];
  const fastRuns = [];
  let version = 0;
  let saved = null;
  return {
    fastStarted, finishFirst, slowCalls, fastRuns,
    options: {
      actorId: 'PipelineBot', ownerId: 'test-owner',
      store: {
        load: async () => saved,
        save: async (_actorId, state) => { saved = structuredClone(state); },
        reset: async () => { saved = null; },
        acquireLease: async () => {}, releaseLease: async () => {}
      },
      adapter: {
        observe: async () => ({ observationVersion: ++version, actor: { alive: true, connected: true, inventory: {} } }),
        cancel: async () => {}
      },
      slowProvider: {
        generate: async (context) => { slowCalls.push(context); return proposal(context.fences); }
      },
      compile: ({ proposal: generated, fences, snapshot }) => {
        assert.equal(fences.observationVersion, snapshot.observationVersion);
        return { ...generated, authority: {
          capabilities: ['observe', 'mine_block'], items: ['oak_log'], blocks: ['oak_log'],
          entities: [], recipes: [], landmarks: [], regions: [], blueprints: [], containers: []
        } };
      },
      fastRunner: {
        run: async (compiled, { onFastCall } = {}) => {
          await onFastCall?.({ turn: 0 });
          fastRuns.push(compiled);
          if (fastRuns.length === 1) { fastStarted.resolve(); return finishFirst.promise; }
          return { status: 'stopped', code: 'TEST_END', proofKinds: ['goal:stopped'] };
        },
        stop: async () => {}
      },
      permissions: {}, remainingLimits: () => ({ maximumActions: 40, maximumReplans: 5, maximumSeconds: 300, maximumSearchRadius: 64, maximumTravelRadius: 128 }),
      clock: { now: () => Date.parse('2026-09-10T12:00:00.000Z') }
    }
  };
}

test('runs one active contract while generating exactly one speculative successor', async () => {
  const rig = dependencies();
  const run = rig.options.fastRunner;
  const pending = createGoalPipelineSupervisor(rig.options).start({ mission: 'reach stone tools' });
  await rig.fastStarted.promise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(rig.slowCalls.length, 2);
  assert.equal(rig.fastRuns.length, 1);
  rig.finishFirst.resolve({ status: 'succeeded', proofKinds: ['inventory_at_least:oak_log'], facts: [{ item: 'oak_log', actual: 1 }] });
  const final = await pending;
  assert.equal(rig.fastRuns.length, 2);
  assert.equal(rig.slowCalls.length, 3);
  assert.equal(final.counters.fastCalls, 2);
  assert.equal(final.counters.consecutiveGoalFailures, 0);
  assert.equal(rig.fastRuns[1].predecessor.contractId, rig.fastRuns[0].contractId);
  assert.equal(run === rig.options.fastRunner, true);

  const firstId = rig.fastRuns[0].contractId;
  const secondId = rig.fastRuns[1].contractId;
  const eventIndex = (kind, contractId) => final.audit.findIndex((event) => event.kind === kind && event.contractId === contractId);
  assert.ok(eventIndex('execution_started', firstId) < eventIndex('generation_started', secondId));
  assert.ok(eventIndex('generation_started', secondId) < eventIndex('generation_completed', secondId));
  assert.ok(eventIndex('generation_completed', secondId) < eventIndex('promotion_validated', secondId));
  assert.ok(eventIndex('promotion_validated', secondId) < eventIndex('execution_started', secondId));
  const promotion = final.audit.find((event) => event.kind === 'promotion_validated' && event.contractId === secondId);
  assert.equal(promotion.predecessorContractId, firstId);
  assert.ok(promotion.relatedObservationVersion > promotion.observationVersion);
});

test('urgent mission update stops active work and invalidates speculative authority', async () => {
  const rig = dependencies();
  let stops = 0;
  rig.options.fastRunner.stop = async () => { stops += 1; rig.finishFirst.resolve({ status: 'stopped', proofKinds: ['operator:stop'] }); };
  const supervisor = createGoalPipelineSupervisor(rig.options);
  const pending = supervisor.start({ mission: 'reach stone tools' });
  await rig.fastStarted.promise;
  await supervisor.updateMission('return to safety', { urgent: true });
  await pending;
  const status = await supervisor.status();
  assert.equal(stops, 1);
  assert.equal(status.mission.text, 'return to safety');
  assert.equal(status.speculativeContract, null);
});

test('a question draft cannot execute until one exact choice is replanned into a new contract', async () => {
  const rig = dependencies();
  const contexts = [];
  let calls = 0;
  rig.options.slowProvider.generate = async (context) => {
    contexts.push(context);
    calls += 1;
    return calls === 1 ? questionProposal(context.fences) : proposal(context.fences);
  };
  rig.options.fastRunner.run = async (compiled) => {
    rig.fastRuns.push(compiled);
    return { status: 'stopped', code: 'TEST_END', proofKinds: ['goal:stopped'] };
  };
  const supervisor = createGoalPipelineSupervisor(rig.options);
  const pending = supervisor.start({ mission: 'survive safely' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(rig.fastRuns.length, 0);
  assert.deepEqual((await supervisor.status()).pendingQuestion.choices, [
    { id: 'wood', label: 'Collect wood' }, { id: 'shelter', label: 'Find shelter' }
  ]);
  await assert.rejects(supervisor.answer('invalid'), { code: 'PIPELINE_QUESTION_CHOICE_INVALID' });
  await supervisor.answer('shelter');
  await pending;

  assert.equal(rig.fastRuns.length, 1);
  assert.deepEqual(contexts[1].questionAnswer, {
    contractId: contexts[0].fences.contractId, choiceId: 'shelter', label: 'Find shelter', usedDefault: false
  });
  await assert.rejects(supervisor.answer('wood'), { code: 'PIPELINE_NO_PENDING_QUESTION' });
});

test('question timeout selects only the declared safe default', async () => {
  const rig = dependencies();
  const scheduled = [];
  rig.options.timers = {
    setTimeout: (callback, milliseconds) => { scheduled.push({ callback, milliseconds }); return scheduled.length; },
    clearTimeout: () => {}
  };
  const contexts = [];
  let calls = 0;
  rig.options.slowProvider.generate = async (context) => {
    contexts.push(context);
    calls += 1;
    return calls === 1 ? questionProposal(context.fences) : proposal(context.fences);
  };
  rig.options.fastRunner.run = async () => ({ status: 'stopped', code: 'TEST_END', proofKinds: ['goal:stopped'] });
  const supervisor = createGoalPipelineSupervisor(rig.options);
  const pending = supervisor.start({ mission: 'survive safely' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduled[0].milliseconds, 10_000);
  scheduled[0].callback();
  await pending;
  assert.deepEqual(contexts[1].questionAnswer, {
    contractId: contexts[0].fences.contractId, choiceId: 'wood', label: 'Collect wood', usedDefault: true
  });
});

test('an exhausted global call ceiling pauses before observation or generation and survives resume', async () => {
  const now = '2026-09-10T12:00:00.000Z';
  const initial = structuredClone(createInitialPipelineState({ actorId: 'PipelineBot', mission: 'survive', now }));
  initial.counters.slowCalls = initial.limits.maximumSlowCalls;
  let saved = validatePipelineState(initial);
  let observations = 0;
  let generations = 0;
  const supervisor = createGoalPipelineSupervisor({
    actorId: 'PipelineBot', ownerId: 'test-owner',
    store: {
      load: async () => saved,
      save: async (_actorId, state) => { saved = structuredClone(state); },
      reset: async () => {}, acquireLease: async () => {}, releaseLease: async () => {}
    },
    adapter: { observe: async () => { observations += 1; }, cancel: async () => {} },
    slowProvider: { generate: async () => { generations += 1; } },
    compile: () => {}, fastRunner: { run: async () => {}, stop: async () => {} },
    permissions: {}, remainingLimits: () => ({}), clock: { now: () => Date.parse(now) }
  });

  await supervisor.start({ mission: 'survive' });
  assert.equal((await supervisor.status()).lifecycle.status, 'paused');
  assert.equal(observations, 0);
  assert.equal(generations, 0);
  await supervisor.resume();
  assert.equal((await supervisor.status()).lifecycle.status, 'paused');
  assert.equal(generations, 0);
});

test('accounts persisted running time and pauses before new work at the runtime ceiling', async () => {
  const startedAt = '2026-09-10T10:30:00.000Z';
  const resumedAt = '2026-09-10T12:00:00.000Z';
  const initial = structuredClone(createInitialPipelineState({ actorId: 'PipelineBot', mission: 'survive', now: startedAt }));
  initial.lifecycle.status = 'running';
  initial.lifecycle.startedAt = startedAt;
  let saved = validatePipelineState(initial);
  let observations = 0;
  const supervisor = createGoalPipelineSupervisor({
    actorId: 'PipelineBot', ownerId: 'test-owner',
    store: {
      load: async () => saved, save: async (_actorId, state) => { saved = structuredClone(state); },
      reset: async () => {}, acquireLease: async () => {}, releaseLease: async () => {}
    },
    adapter: { observe: async () => { observations += 1; }, cancel: async () => {} },
    slowProvider: { generate: async () => { throw new Error('must not generate'); } },
    compile: () => {}, fastRunner: { run: async () => {}, stop: async () => {} },
    permissions: {}, remainingLimits: () => ({}), clock: { now: () => Date.parse(resumedAt) }
  });

  const result = await supervisor.start({ mission: 'survive' });
  assert.equal(result.counters.runtimeMs, result.limits.maximumRuntimeMs);
  assert.equal(result.lifecycle.status, 'paused');
  assert.equal(result.failure.code, 'PIPELINE_GLOBAL_LIMIT');
  assert.equal(observations, 0);
});

test('three generation failures pause without granting fast execution authority', async () => {
  const rig = dependencies();
  let calls = 0;
  rig.options.slowProvider.generate = async () => {
    calls += 1;
    throw Object.assign(new Error('planner unavailable'), { code: 'PLANNER_UNAVAILABLE' });
  };
  const supervisor = createGoalPipelineSupervisor(rig.options);
  await supervisor.start({ mission: 'survive safely' });
  const status = await supervisor.status();
  assert.equal(calls, 3);
  assert.equal(rig.fastRuns.length, 0);
  assert.equal(status.counters.consecutiveGenerationFailures, 3);
  assert.equal(status.lifecycle.status, 'paused');
  assert.equal(status.failure.code, 'PIPELINE_GENERATION_LIMIT');
});

test('records verified live output and terminates when the mission completion policy matches', async () => {
  const rig = dependencies();
  const recorded = [];
  rig.options.fastRunner.run = async (compiled, { onFastCall }) => {
    await onFastCall({ turn: 0 });
    rig.fastRuns.push(compiled);
    return {
      status: 'succeeded', proofKinds: ['inventory_at_least:stone_pickaxe'],
      facts: [{ predicate: 'inventory_at_least', item: 'stone_pickaxe', actual: 1, required: 1 }]
    };
  };
  rig.options.onVerifiedOutcome = async (entry) => { recorded.push(entry); };
  rig.options.missionComplete = ({ outcome }) => outcome.proofKinds.includes('inventory_at_least:stone_pickaxe');

  const final = await createGoalPipelineSupervisor(rig.options).start({ mission: 'reach stone tools' });
  assert.equal(final.lifecycle.status, 'succeeded');
  assert.equal(final.activeContract, null);
  assert.equal(final.speculativeContract, null);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].contract.contractId, rig.fastRuns[0].contractId);
  assert.deepEqual(recorded[0].result.facts, [
    { predicate: 'inventory_at_least', item: 'stone_pickaxe', actual: 1, required: 1 }
  ]);
});

test('a question replan that exhausts the slow-call budget pauses as a global ceiling', async () => {
  const now = '2026-09-10T12:00:00.000Z';
  const initial = structuredClone(createInitialPipelineState({ actorId: 'PipelineBot', mission: 'survive', now }));
  initial.counters.slowCalls = initial.limits.maximumSlowCalls - 1;
  let saved = validatePipelineState(initial);
  let calls = 0;
  const supervisor = createGoalPipelineSupervisor({
    actorId: 'PipelineBot', ownerId: 'test-owner',
    store: {
      load: async () => saved, save: async (_actorId, state) => { saved = structuredClone(state); },
      reset: async () => {}, acquireLease: async () => {}, releaseLease: async () => {}
    },
    adapter: {
      observe: async () => ({ observationVersion: calls + 1, actor: { alive: true, connected: true, inventory: {} } }),
      cancel: async () => {}
    },
    slowProvider: { generate: async (context) => { calls += 1; return questionProposal(context.fences); } },
    compile: () => {}, fastRunner: { run: async () => {}, stop: async () => {} },
    permissions: {}, remainingLimits: () => ({}), clock: { now: () => Date.parse(now) },
    timers: {
      setTimeout: (callback) => { setImmediate(callback); return 1; }, clearTimeout: () => {}
    }
  });
  await supervisor.start({ mission: 'survive' });
  const status = await supervisor.status();
  assert.equal(calls, 1);
  assert.equal(status.lifecycle.status, 'paused');
  assert.equal(status.failure.code, 'PIPELINE_GLOBAL_LIMIT');
  assert.equal(status.counters.consecutiveGenerationFailures, 0);
});

test('failed fast goals discard speculative assumptions and replan until the three-goal ceiling', async () => {
  const rig = dependencies();
  rig.options.fastRunner.run = async (compiled) => {
    rig.fastRuns.push(compiled);
    return { status: 'failed', code: 'NO_SAFE_PATH', proofKinds: ['goal:failed'] };
  };
  const supervisor = createGoalPipelineSupervisor(rig.options);
  await supervisor.start({ mission: 'survive safely' });
  const status = await supervisor.status();

  assert.equal(rig.fastRuns.length, 3);
  assert.equal(status.counters.consecutiveGoalFailures, 3);
  assert.equal(status.lifecycle.status, 'paused');
  assert.equal(status.failure.code, 'PIPELINE_GOAL_FAILURE_LIMIT');
  assert.equal(status.speculativeContract, null);
});
