import { randomUUID } from 'node:crypto';

import { createFastRunner } from './fast-runner.mjs';
import { createPipelineLiveEvidenceStore } from './live-evidence-store.mjs';
import { evaluateExpression } from './predicates.mjs';
import { CAPABILITY_IDS } from './registry.mjs';
import { createPipelineStateStore } from './state-store.mjs';
import { createGoalPipelineSupervisor } from './supervisor.mjs';
import { createSurvivalAdapter } from './survival-adapter.mjs';
import { createDefaultSurvivalPermissions } from './survival-permissions.mjs';

function requirePort(value, label, method) {
  if (!value || typeof value[method] !== 'function') throw new TypeError(`${label}.${method} must be a function`);
}

function compilationPermissions(value) {
  const items = new Set([
    ...value.mineableBlocks, ...value.placeableBlocks, ...value.recipes, ...value.consumableItems,
    'cobblestone'
  ]);
  return Object.freeze({
    capabilities: [...CAPABILITY_IDS],
    items: [...items].sort(),
    blocks: [...value.mineableBlocks].sort(),
    entities: [...value.attackableEntities].sort(),
    recipes: [...value.recipes].sort(),
    landmarks: ['safe:origin'], regions: ['origin'], blueprints: [], containers: [],
    protectedBlocks: []
  });
}

function remainingLimits(state, permissions) {
  const runtimeSeconds = Math.floor((state.limits.maximumRuntimeMs - state.counters.runtimeMs) / 1_000);
  return {
    maximumActions: Math.max(0, Math.min(40, state.limits.maximumFastCalls - state.counters.fastCalls)),
    maximumReplans: 5,
    maximumSeconds: Math.max(0, Math.min(300, runtimeSeconds)),
    maximumSearchRadius: permissions.maximumSearchRadius,
    maximumTravelRadius: permissions.maximumTravelRadius
  };
}

export function createGoalPipelineLiveRuntime({
  actorId, bot, goals, Movements, slowProvider, fastProvider,
  stateDirectory = 'runtime/llm-goal-pipeline-state', origin,
  protectedRegions = [], ownerId = `pipeline-${randomUUID()}`,
  storeFactory = createPipelineStateStore,
  evidenceStoreFactory = createPipelineLiveEvidenceStore,
  permissionsFactory = createDefaultSurvivalPermissions,
  adapterFactory = createSurvivalAdapter,
  runnerFactory = createFastRunner,
  supervisorFactory = createGoalPipelineSupervisor
} = {}) {
  if (typeof actorId !== 'string' || actorId.length === 0) throw new TypeError('actorId must be a nonempty string');
  if (!bot || typeof bot !== 'object') throw new TypeError('bot must be an object');
  requirePort(slowProvider, 'slowProvider', 'generate');
  requirePort(fastProvider, 'fastProvider', 'decide');
  for (const [factory, label] of [
    [storeFactory, 'storeFactory'], [evidenceStoreFactory, 'evidenceStoreFactory'], [permissionsFactory, 'permissionsFactory'],
    [adapterFactory, 'adapterFactory'], [runnerFactory, 'runnerFactory'],
    [supervisorFactory, 'supervisorFactory']
  ]) if (typeof factory !== 'function') throw new TypeError(`${label} must be a function`);

  const stateStore = storeFactory({ directory: stateDirectory });
  const evidenceStore = evidenceStoreFactory({ directory: stateDirectory, actorId });
  const store = Object.freeze({
    ...stateStore,
    async reset(requestedActorId) {
      await stateStore.reset(requestedActorId);
      await evidenceStore.reset();
    }
  });
  const survivalPermissions = permissionsFactory({ origin, protectedRegions });
  const permissions = compilationPermissions(survivalPermissions);
  const adapter = adapterFactory({ bot, goals, Movements, permissions: survivalPermissions });
  const fastRunner = runnerFactory({
    actorId, provider: fastProvider, adapter,
    evaluateSuccess: (expression, observation) => evaluateExpression(expression, observation)
  });
  const controller = supervisorFactory({
    actorId, ownerId, store, slowProvider, fastRunner, adapter, permissions,
    remainingLimits: (state) => remainingLimits(state, survivalPermissions),
    onVerifiedOutcome: (entry) => evidenceStore.record(entry),
    missionComplete: ({ mission, outcome, pipelineState }) => pipelineState?.counters?.goalsCompleted >= 2
      && /\bstone (?:tools?|pickaxe)\b/i.test(mission.text)
      && outcome.proofKinds.includes('inventory_at_least:stone_pickaxe')
  });

  let closePromise = null;
  function close() {
    if (!closePromise) {
      closePromise = (async () => {
        try {
          await controller.stop('runtime closing');
          await controller.awaitIdle?.();
        } finally {
          await adapter.cancel?.('runtime closing');
        }
      })();
    }
    return closePromise;
  }

  return Object.freeze({ controller, adapter, store, evidenceStore, permissions, bot, close });
}
