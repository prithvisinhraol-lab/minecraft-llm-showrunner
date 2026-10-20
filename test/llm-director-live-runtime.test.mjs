import assert from 'node:assert/strict';
import test from 'node:test';

import { COLLECT_OAK_LOG_GOAL } from '../src/llm-agent/goals.mjs';
import { createDirectorLiveRuntime } from '../src/llm-director/live-runtime.mjs';

test('composes director ports over one shared adapter and a fresh fast controller', async () => {
  const calls = [];
  const prior = { identity: { actorId: 'LlmAgent' } };
  const terminal = { lifecycle: { status: 'succeeded' } };
  const actorStore = { async load() { calls.push('loadAgent'); return prior; } };
  const adapter = { async inspectPrerequisite(goal, state, options) { calls.push('inspect'); assert.equal(goal.id, COLLECT_OAK_LOG_GOAL.id); assert.equal(state, prior); assert.ok(options.signal); return { ok: true }; } };
  const fast = { async start() { calls.push('fast:start'); }, async awaitIdle() { calls.push('fast:idle'); }, async status() { return terminal; }, async stop() { calls.push('fast:stop'); } };
  let ports;
  const director = { async stop() { calls.push('director:stop'); }, async awaitIdle() { calls.push('director:idle'); } };
  const runtime = createDirectorLiveRuntime({
    actorId: 'LlmAgent', overallObjective: 'advance', adapter, actorStore, actorProvider: { decide() {} },
    directorStore: {}, directorProvider: {},
    agentControllerFactory(options) { assert.equal(options.adapter, adapter); assert.equal(options.goal.id, COLLECT_OAK_LOG_GOAL.id); return fast; },
    directorControllerFactory(options) { ports = options; return director; }
  });
  const signal = new AbortController().signal;
  assert.equal(await ports.loadAgentState(), prior);
  assert.deepEqual(await ports.inspectPrerequisite(COLLECT_OAK_LOG_GOAL, prior, { signal }), { ok: true });
  assert.equal(await ports.runGoal(COLLECT_OAK_LOG_GOAL, { signal }), terminal);
  await runtime.close();
  assert.deepEqual(calls, ['loadAgent', 'inspect', 'fast:start', 'fast:idle', 'director:stop', 'director:idle']);
});
