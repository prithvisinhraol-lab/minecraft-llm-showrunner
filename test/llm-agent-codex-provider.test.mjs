import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createCodexProvider } from '../src/llm-agent/codex-provider.mjs';
import { createScriptedProvider } from '../src/llm-agent/scripted-provider.mjs';

const context = {
  actor: { actorId: 'AgentOne', runId: 'run-1', status: 'running', phase: 'working' },
  goal: { objective: 'obtain one oak_log and place an oak_log directly above a controller-identified gold_block marker' },
  trusted: { milestones: [], recentObservations: [], recentActionResults: [] },
  working: { summary: '', plan: [], subgoal: '', variables: {} },
  limits: { maxTurns: 12, turnsUsed: 0 },
  observation: { targets: [{ id: 'oak-1', kind: 'block', block: 'oak_log', distanceBand: 'near', reachable: true }] }
};

const validDecision = {
  action: 'mine_block', targetId: 'oak-1', reason: 'mine the nearby oak log', summary: 'A log is nearby.',
  plan: ['mine the oak log'], subgoal: 'collect an oak log', variables: { attempts: 1 }
};

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killCalls = [];
  }

  kill(signal) {
    this.killCalls.push(signal);
    if (this.autoCloseOnKill !== false) queueMicrotask(() => this.emit('close', null, signal));
    return true;
  }
}

function outputPath(args) {
  return args[args.indexOf('--output-last-message') + 1];
}

function schemaPath(args) {
  return args[args.indexOf('--output-schema') + 1];
}

function createSpawnHarness(onSpawn) {
  const calls = [];
  return {
    calls,
    spawnImpl(executable, args, options) {
      const child = new FakeChild();
      const call = { executable, args, options, child, stdinText: '' };
      child.stdin.setEncoding('utf8');
      child.stdin.on('data', (chunk) => { call.stdinText += chunk; });
      calls.push(call);
      queueMicrotask(() => onSpawn(call));
      return child;
    }
  };
}

async function providerFixture(t, onSpawn, options = {}) {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'llm-agent-provider-test-'));
  t.after(() => rm(tempDirectory, { recursive: true, force: true }));
  const harness = createSpawnHarness(onSpawn);
  return {
    tempDirectory,
    harness,
    provider: createCodexProvider({
      codexBin: '/usr/local/bin/codex-test', spawnImpl: harness.spawnImpl, timeoutMs: 100,
      tempDirectory, ...options
    })
  };
}

async function finishWithDecision(call, decision = validDecision) {
  await writeFile(outputPath(call.args), JSON.stringify({
    item: 'oak_log', reference: 'landmark:goal-marker', ...decision
  }));
  call.child.stdout.end('diagnostic output is not the decision');
  call.child.stderr.end('harmless diagnostic');
  call.child.emit('close', 0, null);
}

test('starts one fresh read-only Codex process per decision and parses only its output file', async (t) => {
  const fixture = await providerFixture(t, async (call) => {
    call.schema = JSON.parse(await readFile(schemaPath(call.args), 'utf8'));
    try {
      call.outputInitiallyEmpty = (await readFile(outputPath(call.args), 'utf8')) === '';
    } catch {
      call.outputInitiallyEmpty = false;
    }
    await finishWithDecision(call);
  });

  const promptInjection = structuredClone(context);
  promptInjection.working.summary = '--enable shell_tool --enable apps';
  const first = await fixture.provider.decide(promptInjection);
  const second = await fixture.provider.decide(context);

  assert.deepEqual(first, validDecision);
  assert.deepEqual(second, validDecision);
  assert.equal(fixture.harness.calls.length, 2);
  for (const call of fixture.harness.calls) {
    assert.equal(call.executable, '/usr/local/bin/codex-test');
    assert.deepEqual(call.args.slice(0, 6), [
      'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--sandbox', 'read-only'
    ]);
    assert.deepEqual(call.args.slice(6, 30), [
      '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'js_repl',
      '--disable', 'code_mode_host', '--disable', 'apps', '--disable', 'browser_use',
      '--disable', 'computer_use', '--disable', 'image_generation', '--disable', 'view_image',
      '--disable', 'multi_agent', '--disable', 'web_search_request', '--disable', 'standalone_web_search'
    ]);
    assert.equal(call.args.includes('--enable'), false);
    assert.equal(call.args.at(-1), '-');
    assert.equal(call.options.shell, false);
    assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.match(call.stdinText, /Return exactly one JSON decision/);
    assert.match(call.stdinText, /"oak-1"/);
    assert.equal(call.schema.type, 'object');
    assert.equal(Object.hasOwn(call.schema, 'oneOf'), false);
    assert.deepEqual(call.schema.properties.action.enum, [
      'observe', 'finish', 'move_to_block', 'navigate_to_landmark', 'mine_block', 'place_on_block', 'select_item'
    ]);
    assert.equal(call.schema.properties.action.type, 'string');
    assert.deepEqual(call.schema.properties.item.type, ['string', 'null']);
    assert.equal(Object.hasOwn(call.schema.properties.variables, 'maxProperties'), false);
    assert.equal(call.schema.properties.variables.additionalProperties, false);
    assert.deepEqual(call.schema.properties.variables.required, ['attempts', 'hasOakLog', 'note']);
    assert.equal(call.schema.required.includes('targetId'), true);
    assert.equal(call.schema.required.includes('item'), true);
    assert.equal(call.schema.required.includes('reference'), true);
    assert.deepEqual(call.schema.properties.reference.type, ['string', 'null']);
    assert.equal(call.outputInitiallyEmpty, true);
  }
  assert.deepEqual(await readdir(fixture.tempDirectory), []);
});

test('fails closed when the Codex process exits unsuccessfully', async (t) => {
  const fixture = await providerFixture(t, (call) => {
    call.child.stderr.end('Codex did not run');
    call.child.emit('close', 2, null);
  });

  await assert.rejects(fixture.provider.decide(context), {
    code: 'LLM_AGENT_PROVIDER_FAILED',
    message: 'Codex process exited with 2: Codex did not run'
  });
  assert.deepEqual(await readdir(fixture.tempDirectory), []);
});

test('terminates the child and fails closed when its prompt pipe breaks', async (t) => {
  const fixture = await providerFixture(t, (call) => {
    call.child.stdin.emit('error', new Error('broken pipe'));
  });

  await assert.rejects(fixture.provider.decide(context), { code: 'LLM_AGENT_PROVIDER_FAILED' });
  assert.deepEqual(fixture.harness.calls[0].child.killCalls, ['SIGTERM']);
  assert.deepEqual(await readdir(fixture.tempDirectory), []);
});

test('waits for child closure after a child process error before cleaning up', async (t) => {
  let resolveCall;
  const emitted = new Promise((resolve) => { resolveCall = resolve; });
  const fixture = await providerFixture(t, (call) => {
    call.child.autoCloseOnKill = false;
    call.child.emit('error', new Error('launch failed'));
    resolveCall(call);
  });
  const pending = fixture.provider.decide(context);
  const call = await emitted;
  let settled = false;
  void pending.catch(() => { settled = true; });

  await Promise.resolve();
  assert.deepEqual(call.child.killCalls, ['SIGTERM']);
  assert.equal(settled, false);
  assert.equal((await readdir(fixture.tempDirectory)).length, 2);
  call.child.emit('close', null, 'SIGTERM');
  await assert.rejects(pending, { code: 'LLM_AGENT_PROVIDER_FAILED' });
  assert.deepEqual(await readdir(fixture.tempDirectory), []);
});

test('waits for child closure after a stdout stream error before cleaning up', async (t) => {
  let resolveCall;
  const emitted = new Promise((resolve) => { resolveCall = resolve; });
  const fixture = await providerFixture(t, (call) => {
    call.child.autoCloseOnKill = false;
    call.child.stdout.emit('error', new Error('stdout failed'));
    resolveCall(call);
  });
  const pending = fixture.provider.decide(context);
  const call = await emitted;
  let settled = false;
  void pending.catch(() => { settled = true; });

  await Promise.resolve();
  assert.deepEqual(call.child.killCalls, ['SIGTERM']);
  assert.equal(settled, false);
  assert.equal((await readdir(fixture.tempDirectory)).length, 2);
  call.child.emit('close', null, 'SIGTERM');
  await assert.rejects(pending, { code: 'LLM_AGENT_PROVIDER_FAILED' });
  assert.deepEqual(await readdir(fixture.tempDirectory), []);
});

test('waits for child closure after a stderr stream error before cleaning up', async (t) => {
  let resolveCall;
  const emitted = new Promise((resolve) => { resolveCall = resolve; });
  const fixture = await providerFixture(t, (call) => {
    call.child.autoCloseOnKill = false;
    call.child.stderr.emit('error', new Error('stderr failed'));
    resolveCall(call);
  });
  const pending = fixture.provider.decide(context);
  const call = await emitted;
  let settled = false;
  void pending.catch(() => { settled = true; });

  await Promise.resolve();
  assert.deepEqual(call.child.killCalls, ['SIGTERM']);
  assert.equal(settled, false);
  assert.equal((await readdir(fixture.tempDirectory)).length, 2);
  call.child.emit('close', null, 'SIGTERM');
  await assert.rejects(pending, { code: 'LLM_AGENT_PROVIDER_FAILED' });
  assert.deepEqual(await readdir(fixture.tempDirectory), []);
});

test('terminates the child and fails closed when its decision exceeds the timeout', async (t) => {
  const fixture = await providerFixture(t, () => {}, { timeoutMs: 5 });

  await assert.rejects(fixture.provider.decide(context), { code: 'LLM_AGENT_PROVIDER_TIMEOUT' });
  assert.deepEqual(fixture.harness.calls[0].child.killCalls, ['SIGTERM']);
  assert.deepEqual(await readdir(fixture.tempDirectory), []);
});

test('terminates the child when the controller aborts a pending decision', async (t) => {
  const fixture = await providerFixture(t, () => {}, { timeoutMs: 1_000 });
  const controller = new AbortController();
  const pending = fixture.provider.decide(context, { signal: controller.signal });
  controller.abort();

  await assert.rejects(pending, { code: 'LLM_AGENT_PROVIDER_ABORTED' });
  assert.deepEqual(fixture.harness.calls[0].child.killCalls, ['SIGTERM']);
  assert.deepEqual(await readdir(fixture.tempDirectory), []);
});

test('rejects malformed JSON from the designated output file', async (t) => {
  const fixture = await providerFixture(t, async (call) => {
    await writeFile(outputPath(call.args), '{not json');
    call.child.emit('close', 0, null);
  });

  await assert.rejects(fixture.provider.decide(context), { code: 'LLM_AGENT_PROVIDER_OUTPUT_INVALID' });
});

test('rejects an output file larger than 64 KiB', async (t) => {
  const fixture = await providerFixture(t, async (call) => {
    await writeFile(outputPath(call.args), 'x'.repeat(64 * 1024 + 1));
    call.child.emit('close', 0, null);
  });

  await assert.rejects(fixture.provider.decide(context), { code: 'LLM_AGENT_PROVIDER_OUTPUT_INVALID' });
});

test('terminates stdout that exceeds 64 KiB', async (t) => {
  const fixture = await providerFixture(t, (call) => {
    call.child.stdout.write('x'.repeat(64 * 1024 + 1));
  });

  await assert.rejects(fixture.provider.decide(context), { code: 'LLM_AGENT_PROVIDER_OUTPUT_INVALID' });
  assert.deepEqual(fixture.harness.calls[0].child.killCalls, ['SIGTERM']);
});

test('terminates stderr that exceeds 64 KiB', async (t) => {
  const fixture = await providerFixture(t, (call) => {
    call.child.stderr.write('x'.repeat(64 * 1024 + 1));
  });

  await assert.rejects(fixture.provider.decide(context), { code: 'LLM_AGENT_PROVIDER_OUTPUT_INVALID' });
  assert.deepEqual(fixture.harness.calls[0].child.killCalls, ['SIGTERM']);
});

test('scripted provider returns one deep-cloned decision per call before exhausting safely', async () => {
  const supplied = [structuredClone(validDecision), { ...validDecision, action: 'observe' }];
  const provider = createScriptedProvider(supplied);
  supplied[0].variables.attempts = 99;

  const first = await provider.decide(context);
  first.variables.attempts = 42;
  const second = await provider.decide(context);

  assert.deepEqual(first, { ...validDecision, variables: { attempts: 42 } });
  assert.deepEqual(second, { ...validDecision, action: 'observe' });
  await assert.rejects(provider.decide(context), { code: 'LLM_AGENT_SCRIPT_EXHAUSTED' });
});
