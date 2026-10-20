import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createDirectorCodexProvider } from '../src/llm-director/codex-provider.mjs';
import { createScriptedDirectorProvider } from '../src/llm-director/scripted-provider.mjs';

const context = {
  schemaVersion: 1, actorId: 'LlmAgent', overallObjective: 'advance through verified goals',
  eligibleGoals: [{ goalId: 'collect_oak_log_above_gold_marker', objective: 'collect it', successKind: 'oak_log_collected_from_above_gold_marker' }],
  recentOutcomes: [], latestGoalProof: null, remainingInvocations: 1
};
const decision = {
  decision: 'select_goal', goalId: 'collect_oak_log_above_gold_marker',
  reason: 'Continue from verified placement.', stateSummary: 'The marker log is ready to collect.'
};

class Child extends EventEmitter {
  constructor() { super(); this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.kills = []; }
  kill(signal) { this.kills.push(signal); queueMicrotask(() => this.emit('close', null, signal)); return true; }
}

function harness(onSpawn) {
  const calls = [];
  return { calls, spawnImpl(executable, args, options) {
    const child = new Child();
    const call = { executable, args, options, child, prompt: '' };
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', (chunk) => { call.prompt += chunk; });
    calls.push(call); queueMicrotask(() => onSpawn(call)); return child;
  } };
}

async function fixture(t, onSpawn, timeoutMs = 90_000) {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'director-provider-'));
  t.after(() => rm(tempDirectory, { recursive: true, force: true }));
  const spawned = harness(onSpawn);
  return { spawned, tempDirectory, provider: createDirectorCodexProvider({
    codexBin: '/codex-test', spawnImpl: spawned.spawnImpl, timeoutMs, tempDirectory
  }) };
}

function argPath(call, flag) { return call.args[call.args.indexOf(flag) + 1]; }

test('runs isolated Codex with exact director schema and parses only output file', async (t) => {
  let schema;
  const f = await fixture(t, async (call) => {
    schema = JSON.parse(await readFile(argPath(call, '--output-schema'), 'utf8'));
    await writeFile(argPath(call, '--output-last-message'), JSON.stringify(decision));
    call.child.stdout.end('ignored'); call.child.emit('close', 0, null);
  });
  assert.deepEqual(await f.provider.select(context), decision);
  const call = f.spawned.calls[0];
  assert.deepEqual(call.args.slice(0, 6), ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only']);
  assert.equal(call.args.includes('--enable'), false);
  assert.equal(call.options.shell, false);
  assert.match(call.prompt, /select exactly one bounded next goal/i);
  assert.deepEqual(schema.properties.decision.enum, ['select_goal', 'stop']);
  assert.deepEqual(schema.required, ['decision', 'goalId', 'reason', 'stateSummary']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(await readdir(f.tempDirectory), []);
});

test('fails closed for malformed, oversized, unsuccessful, timed out, and aborted output', async (t) => {
  for (const [name, setup, expected] of [
    ['malformed', async (call) => { await writeFile(argPath(call, '--output-last-message'), '{bad'); call.child.emit('close', 0, null); }, 'LLM_DIRECTOR_PROVIDER_OUTPUT_INVALID'],
    ['oversized', async (call) => { await writeFile(argPath(call, '--output-last-message'), 'x'.repeat(65_537)); call.child.emit('close', 0, null); }, 'LLM_DIRECTOR_PROVIDER_OUTPUT_INVALID'],
    ['exit', (call) => { call.child.stderr.end('failed'); call.child.emit('close', 2, null); }, 'LLM_DIRECTOR_PROVIDER_FAILED']
  ]) await t.test(name, async (t) => {
    const f = await fixture(t, setup);
    await assert.rejects(f.provider.select(context), { code: expected });
    assert.deepEqual(await readdir(f.tempDirectory), []);
  });

  await t.test('timeout', async (t) => {
    const f = await fixture(t, () => {}, 5);
    await assert.rejects(f.provider.select(context), { code: 'LLM_DIRECTOR_PROVIDER_TIMEOUT' });
    assert.deepEqual(f.spawned.calls[0].child.kills, ['SIGTERM']);
  });
  await t.test('abort', async (t) => {
    const f = await fixture(t, () => {});
    const aborter = new AbortController();
    const pending = f.provider.select(context, { signal: aborter.signal }); aborter.abort();
    await assert.rejects(pending, { code: 'LLM_DIRECTOR_PROVIDER_ABORTED' });
    assert.deepEqual(f.spawned.calls[0].child.kills, ['SIGTERM']);
  });
});

test('scripted provider clones one selection and exhausts safely', async () => {
  const supplied = [structuredClone(decision)];
  const provider = createScriptedDirectorProvider(supplied);
  supplied[0].reason = 'mutated';
  assert.deepEqual(await provider.select(context), decision);
  await assert.rejects(provider.select(context), { code: 'LLM_DIRECTOR_SCRIPT_EXHAUSTED' });
});
