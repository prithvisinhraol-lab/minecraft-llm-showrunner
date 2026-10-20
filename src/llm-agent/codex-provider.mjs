import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';


const MAX_CAPTURED_BYTES = 64 * 1024;
const DISABLED_FEATURES = Object.freeze([
  'shell_tool', 'unified_exec', 'js_repl', 'code_mode_host', 'apps', 'browser_use',
  'computer_use', 'image_generation', 'view_image', 'multi_agent',
  'web_search_request', 'standalone_web_search'
]);

function coded(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  return error;
}

const DECISION_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['observe', 'finish', 'move_to_block', 'navigate_to_landmark', 'mine_block', 'place_on_block', 'select_item'] },
    reason: { type: 'string', minLength: 1, maxLength: 200 },
    summary: { type: 'string', maxLength: 500 },
    plan: {
      type: 'array', maxItems: 5,
      items: { type: 'string', minLength: 1, maxLength: 200 }
    },
    subgoal: { type: 'string', maxLength: 200 },
    variables: {
      type: 'object',
      properties: {
        attempts: { type: ['integer', 'null'] },
        hasOakLog: { type: ['boolean', 'null'] },
        note: { type: ['string', 'null'], maxLength: 200 }
      },
      required: ['attempts', 'hasOakLog', 'note'],
      additionalProperties: false
    },
    targetId: { type: ['string', 'null'] },
    item: { type: ['string', 'null'], enum: ['oak_log', null] },
    reference: { type: ['string', 'null'], enum: ['landmark:goal-marker', null] }
  },
  required: ['action', 'reason', 'summary', 'plan', 'subgoal', 'variables', 'targetId', 'item', 'reference'],
  additionalProperties: false
});

function buildPrompt(context, promptPreamble) {
  let serializedContext;
  try {
    serializedContext = JSON.stringify(context);
  } catch (error) {
    throw coded('LLM_AGENT_PROVIDER_FAILED', 'decision context could not be serialized', error);
  }
  if (serializedContext === undefined) {
    throw coded('LLM_AGENT_PROVIDER_FAILED', 'decision context could not be serialized');
  }
  return [
    promptPreamble ?? 'Choose the next Minecraft agent action from the supplied compact controller context.',
    'Return exactly one JSON decision matching the provided output schema.',
    'Do not include markdown, commentary, commands, coordinates, or additional fields.',
    'The controller validates the decision and is the only component that executes actions.',
    'Context JSON follows:',
    serializedContext
  ].join('\n');
}

function removeAbortListener(signal, listener) {
  if (signal && listener) signal.removeEventListener('abort', listener);
}

function waitForChild(child, { timeoutMs, signal, prompt }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let terminationRequested = false;
    let pendingError;
    let timer;
    let abortListener;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderrText = '';

    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeAbortListener(signal, abortListener);
      if (error) reject(error);
      else resolve();
    };
    const terminate = (error) => {
      if (terminationRequested || settled) return;
      terminationRequested = true;
      pendingError = error;
      try {
        child.kill('SIGTERM');
      } catch {
        // The process may already have exited; the original error remains authoritative.
      }
    };
    const capture = (stream, which) => {
      if (!stream) return;
      stream.on('data', (chunk) => {
        if (settled) return;
        const nextBytes = (which === 'stdout' ? stdoutBytes : stderrBytes) + Buffer.byteLength(chunk);
        if (which === 'stdout') stdoutBytes = nextBytes;
        else {
          stderrBytes = nextBytes;
          stderrText += chunk.toString();
        }
        if (nextBytes > MAX_CAPTURED_BYTES) {
          terminate(coded('LLM_AGENT_PROVIDER_OUTPUT_INVALID', `${which} exceeded 64 KiB`));
        }
      });
      stream.on('error', (error) => terminate(coded('LLM_AGENT_PROVIDER_FAILED', `${which} could not be read`, error)));
      stream.resume?.();
    };

    capture(child.stdout, 'stdout');
    capture(child.stderr, 'stderr');
    child.stdin?.once('error', (error) => terminate(coded('LLM_AGENT_PROVIDER_FAILED', 'Codex prompt could not be written', error)));
    child.once('error', (error) => terminate(coded('LLM_AGENT_PROVIDER_FAILED', 'Codex process could not start', error)));
    child.once('close', (exitCode, exitSignal) => {
      if (pendingError) settle(pendingError);
      else if (exitCode === 0) settle();
      else {
        const detail = stderrText.trim();
        const suffix = detail.length > 0 ? `: ${detail}` : '';
        settle(coded(
          'LLM_AGENT_PROVIDER_FAILED',
          `Codex process exited with ${exitCode ?? exitSignal ?? 'an unknown status'}${suffix}`
        ));
      }
    });

    if (signal?.aborted) {
      terminate(coded('LLM_AGENT_PROVIDER_ABORTED', 'Codex decision was aborted'));
      return;
    }
    abortListener = () => terminate(coded('LLM_AGENT_PROVIDER_ABORTED', 'Codex decision was aborted'));
    signal?.addEventListener('abort', abortListener, { once: true });
    timer = setTimeout(() => terminate(coded('LLM_AGENT_PROVIDER_TIMEOUT', `Codex decision exceeded ${timeoutMs}ms`)), timeoutMs);
    try {
      child.stdin.end(prompt);
    } catch (error) {
      terminate(coded('LLM_AGENT_PROVIDER_FAILED', 'Codex prompt could not be written', error));
    }
  });
}

async function readDecisionOutput(outputPath, normalizeDecision) {
  let output;
  try {
    const details = await stat(outputPath);
    if (details.size > MAX_CAPTURED_BYTES) {
      throw coded('LLM_AGENT_PROVIDER_OUTPUT_INVALID', 'Codex decision output exceeded 64 KiB');
    }
    output = await readFile(outputPath, 'utf8');
  } catch (error) {
    if (error?.code === 'LLM_AGENT_PROVIDER_OUTPUT_INVALID') throw error;
    throw coded('LLM_AGENT_PROVIDER_OUTPUT_INVALID', 'Codex decision output could not be read', error);
  }
  if (Buffer.byteLength(output) > MAX_CAPTURED_BYTES) {
    throw coded('LLM_AGENT_PROVIDER_OUTPUT_INVALID', 'Codex decision output exceeded 64 KiB');
  }
  try {
    return normalizeDecision(JSON.parse(output));
  } catch (error) {
    throw coded('LLM_AGENT_PROVIDER_OUTPUT_INVALID', 'Codex decision output was not valid JSON', error);
  }
}

export function createCodexProvider({
  codexBin = 'codex', spawnImpl = nodeSpawn, timeoutMs = 30_000, tempDirectory,
  decisionSchema = DECISION_SCHEMA,
  promptPreamble,
  normalizeDecision = (decision) => {
    if (decision && typeof decision === 'object' && !Array.isArray(decision)) {
      if (!['move_to_block', 'mine_block', 'place_on_block'].includes(decision.action)
        || decision.targetId === null) delete decision.targetId;
      if (decision.action !== 'select_item' || decision.item === null) delete decision.item;
      if (decision.action !== 'navigate_to_landmark' || decision.reference === null) delete decision.reference;
    }
    return decision;
  }
} = {}) {
  if (typeof codexBin !== 'string' || codexBin.length === 0) throw new TypeError('codexBin must be a nonempty string');
  if (typeof spawnImpl !== 'function') throw new TypeError('spawnImpl must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive integer');
  if (typeof tempDirectory !== 'string' || tempDirectory.length === 0) throw new TypeError('tempDirectory must be a nonempty string');
  if (!decisionSchema || typeof decisionSchema !== 'object' || Array.isArray(decisionSchema)) throw new TypeError('decisionSchema must be an object');
  if (promptPreamble !== undefined && (typeof promptPreamble !== 'string' || promptPreamble.length === 0)) throw new TypeError('promptPreamble must be a nonempty string');
  if (typeof normalizeDecision !== 'function') throw new TypeError('normalizeDecision must be a function');

  return {
    async decide(context, { signal } = {}) {
      const prompt = buildPrompt(context, promptPreamble);
      const nonce = randomUUID();
      const schemaPath = path.join(tempDirectory, `codex-decision-schema-${nonce}.json`);
      const outputPath = path.join(tempDirectory, `codex-decision-output-${nonce}.json`);
      try {
        await mkdir(tempDirectory, { recursive: true });
        await writeFile(schemaPath, JSON.stringify(decisionSchema), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await writeFile(outputPath, '', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        const args = [
          'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules',
          '--sandbox', 'read-only',
          ...DISABLED_FEATURES.flatMap((feature) => ['--disable', feature]),
          '--output-schema', schemaPath, '--output-last-message', outputPath, '-'
        ];
        let child;
        try {
          child = spawnImpl(codexBin, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (error) {
          throw coded('LLM_AGENT_PROVIDER_FAILED', 'Codex process could not start', error);
        }
        const completion = waitForChild(child, { timeoutMs, signal, prompt });
        await completion;
        return await readDecisionOutput(outputPath, normalizeDecision);
      } finally {
        await Promise.all([
          rm(schemaPath, { force: true }),
          rm(outputPath, { force: true })
        ]);
      }
    }
  };
}
