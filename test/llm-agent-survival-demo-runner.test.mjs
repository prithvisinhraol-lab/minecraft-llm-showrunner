import assert from 'node:assert/strict';
import test from 'node:test';

import { createSurvivalDemoRunner } from '../src/llm-agent/survival-demo-runner.mjs';
import {
  FINAL_SURVIVAL_DEMO_LINE,
  SURVIVAL_DEMO_ACTIONS
} from '../src/llm-agent/survival-demo-contracts.mjs';

class MemoryStore {
  constructor() { this.value = null; this.saves = []; this.owner = null; }
  async load() { return this.value === null ? null : structuredClone(this.value); }
  async save(value) { this.value = structuredClone(value); this.saves.push(structuredClone(value)); }
  async acquireLease(owner) {
    if (this.owner && this.owner !== owner) return false;
    this.owner = owner;
    return true;
  }
  async releaseLease(owner) { if (this.owner === owner) this.owner = null; }
}

function observed(version, overrides = {}) {
  return {
    observationVersion: version, connected: true, alive: true,
    inventory: {}, equippedHand: null,
    runFacts: { brokenOakLogs: 0, minedStone: 0, placedCraftingTable: false },
    villageEvidence: { bell: false, beds: 0, villagers: 0 },
    observedChat: [], ...overrides
  };
}

function successfulObservations() {
  return [
    observed(1),
    observed(2, { inventory: { oak_log: 3 }, runFacts: { brokenOakLogs: 3, minedStone: 0, placedCraftingTable: false } }),
    observed(3, { inventory: { oak_log: 3 }, runFacts: { brokenOakLogs: 3, minedStone: 0, placedCraftingTable: false } }),
    observed(4, { inventory: { oak_planks: 5 }, runFacts: { brokenOakLogs: 3, minedStone: 0, placedCraftingTable: true } }),
    observed(5, { inventory: { oak_planks: 5 }, runFacts: { brokenOakLogs: 3, minedStone: 0, placedCraftingTable: true } }),
    observed(6, { inventory: { wooden_pickaxe: 1 }, equippedHand: 'wooden_pickaxe', runFacts: { brokenOakLogs: 3, minedStone: 0, placedCraftingTable: true } }),
    observed(7, { inventory: { wooden_pickaxe: 1 }, equippedHand: 'wooden_pickaxe', runFacts: { brokenOakLogs: 3, minedStone: 0, placedCraftingTable: true } }),
    observed(8, { inventory: { wooden_pickaxe: 1, cobblestone: 8 }, equippedHand: 'wooden_pickaxe', runFacts: { brokenOakLogs: 3, minedStone: 8, placedCraftingTable: true } }),
    observed(9, { inventory: { wooden_pickaxe: 1, cobblestone: 8 }, equippedHand: 'wooden_pickaxe', runFacts: { brokenOakLogs: 3, minedStone: 8, placedCraftingTable: true } }),
    observed(10, { inventory: { wooden_pickaxe: 1, furnace: 1 }, equippedHand: 'wooden_pickaxe', runFacts: { brokenOakLogs: 3, minedStone: 8, placedCraftingTable: true } }),
    observed(11, { inventory: { wooden_pickaxe: 1, furnace: 1 }, equippedHand: 'wooden_pickaxe', runFacts: { brokenOakLogs: 3, minedStone: 8, placedCraftingTable: true } }),
    observed(12, { inventory: { wooden_pickaxe: 1, furnace: 1 }, equippedHand: 'wooden_pickaxe', runFacts: { brokenOakLogs: 3, minedStone: 8, placedCraftingTable: true }, villageEvidence: { bell: true, beds: 2, villagers: 1 } }),
    observed(13, { inventory: { wooden_pickaxe: 1, furnace: 1 }, equippedHand: 'wooden_pickaxe', runFacts: { brokenOakLogs: 3, minedStone: 8, placedCraftingTable: true }, villageEvidence: { bell: true, beds: 2, villagers: 1 } }),
    observed(14, { inventory: { wooden_pickaxe: 1, furnace: 1 }, equippedHand: 'wooden_pickaxe', runFacts: { brokenOakLogs: 3, minedStone: 8, placedCraftingTable: true }, villageEvidence: { bell: true, beds: 2, villagers: 1 }, observedChat: [{ username: 'LlmAgent', message: FINAL_SURVIVAL_DEMO_LINE }] })
  ];
}

function scriptedProvider(actions) {
  let index = 0;
  return {
    contexts: [],
    async decide(context) {
      this.contexts.push(structuredClone(context));
      const action = actions[index++];
      return { action, observationVersion: context.observation.observationVersion, reason: `Choose ${action}.` };
    }
  };
}

function fakeAdapter(observations) {
  let index = 0;
  return {
    executions: [], cancelled: [],
    async observe() { return structuredClone(observations[index++]); },
    async execute(action) { this.executions.push(structuredClone(action)); return { accepted: true }; },
    async cancel(reason) { this.cancelled.push(reason); }
  };
}

test('runs seven LLM-selected actions in order and speaks only after village proof', async () => {
  const actions = SURVIVAL_DEMO_ACTIONS.slice(0, 7);
  const provider = scriptedProvider(actions);
  const adapter = fakeAdapter(successfulObservations());
  const store = new MemoryStore();
  let now = Date.parse('2026-08-30T18:00:00.000Z');
  const runner = createSurvivalDemoRunner({
    actorId: 'LlmAgent', provider, adapter, store, clock: { now: () => now++ }
  });

  const state = await runner.start();

  assert.equal(state.status, 'succeeded');
  assert.equal(state.verifiedMilestones.length, 7);
  assert.deepEqual(adapter.executions.map(({ action }) => action), actions);
  assert.equal(adapter.executions.at(-1).line, FINAL_SURVIVAL_DEMO_LINE);
  assert.equal(provider.contexts[6].verifiedMilestones.includes('village_found'), true);
  assert.equal(store.value.status, 'succeeded');
  assert.equal(store.owner, null);
});

test('fails closed when the LLM attempts the final line before village proof', async () => {
  const provider = scriptedProvider(['say_final_line']);
  const adapter = fakeAdapter([observed(1)]);
  const store = new MemoryStore();
  const runner = createSurvivalDemoRunner({ actorId: 'LlmAgent', provider, adapter, store });

  await assert.rejects(runner.start(), { code: 'SURVIVAL_DEMO_DECISION_INVALID' });
  assert.deepEqual(adapter.executions, []);
  assert.equal(store.value.status, 'failed');
  assert.equal(store.owner, null);
});

test('fails closed when an action receipt claims success without milestone evidence', async () => {
  const provider = scriptedProvider(['gather_wood']);
  const adapter = fakeAdapter([observed(1), observed(2)]);
  const store = new MemoryStore();
  const runner = createSurvivalDemoRunner({ actorId: 'LlmAgent', provider, adapter, store });

  await assert.rejects(runner.start(), { code: 'SURVIVAL_DEMO_MILESTONE_NOT_VERIFIED' });
  assert.equal(store.value.status, 'failed');
  assert.deepEqual(store.value.verifiedMilestones, []);
});

test('operator stop aborts a pending LLM decision and persists a resumable stopped state', async () => {
  let resolveDecision;
  const provider = { decide: (_context, { signal }) => new Promise((resolve, reject) => {
    resolveDecision = resolve;
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'PROVIDER_ABORTED' })), { once: true });
  }) };
  const adapter = fakeAdapter([observed(1)]);
  const store = new MemoryStore();
  const runner = createSurvivalDemoRunner({ actorId: 'LlmAgent', provider, adapter, store });
  const run = runner.start();
  while (!resolveDecision) await new Promise((resolve) => setImmediate(resolve));

  await runner.stop('operator requested stop');
  await run;

  assert.equal(store.value.status, 'stopped');
  assert.equal(store.value.stoppedReason, 'operator requested stop');
  assert.deepEqual(adapter.cancelled, ['operator requested stop']);
  assert.equal(store.owner, null);
});

test('a second runner cannot acquire the same persistent execution lease', async () => {
  const store = new MemoryStore();
  store.owner = 'another-runner';
  const runner = createSurvivalDemoRunner({
    actorId: 'LlmAgent', provider: scriptedProvider(['gather_wood']), adapter: fakeAdapter([observed(1)]), store
  });
  await assert.rejects(runner.start(), { code: 'SURVIVAL_DEMO_LEASE_UNAVAILABLE' });
});
