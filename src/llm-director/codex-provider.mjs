import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_BYTES = 64 * 1024;
const DISABLED = ['shell_tool', 'unified_exec', 'js_repl', 'code_mode_host', 'apps', 'browser_use',
  'computer_use', 'image_generation', 'view_image', 'multi_agent', 'web_search_request', 'standalone_web_search'];
const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object',
  properties: {
    decision: { type: 'string', enum: ['select_goal', 'stop'] },
    goalId: { type: ['string', 'null'] },
    reason: { type: 'string', minLength: 1, maxLength: 300 },
    stateSummary: { type: 'string', maxLength: 500 }
  },
  required: ['decision', 'goalId', 'reason', 'stateSummary'], additionalProperties: false
};

function coded(code, message, cause) { const error = new Error(message, cause ? { cause } : undefined); error.code = code; return error; }

function wait(child, { timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    let done = false; let pending; let timer; let stderr = ''; let outBytes = 0; let errBytes = 0;
    const settle = (error) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
    const terminate = (error) => { if (pending || done) return; pending = error; try { child.kill('SIGTERM'); } catch {} };
    const capture = (stream, which) => {
      stream?.on('data', (chunk) => {
        if (which === 'out') outBytes += Buffer.byteLength(chunk); else { errBytes += Buffer.byteLength(chunk); stderr += chunk.toString(); }
        if ((which === 'out' ? outBytes : errBytes) > MAX_BYTES) terminate(coded('LLM_DIRECTOR_PROVIDER_OUTPUT_INVALID', `${which} exceeded 64 KiB`));
      });
      stream?.on('error', (cause) => terminate(coded('LLM_DIRECTOR_PROVIDER_FAILED', `${which} failed`, cause)));
      stream?.resume?.();
    };
    capture(child.stdout, 'out'); capture(child.stderr, 'err');
    child.stdin?.once('error', (cause) => terminate(coded('LLM_DIRECTOR_PROVIDER_FAILED', 'prompt write failed', cause)));
    child.once('error', (cause) => terminate(coded('LLM_DIRECTOR_PROVIDER_FAILED', 'Codex start failed', cause)));
    child.once('close', (code, closeSignal) => {
      if (pending) settle(pending);
      else if (code === 0) settle();
      else settle(coded('LLM_DIRECTOR_PROVIDER_FAILED', `Codex process exited with ${code ?? closeSignal}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
    const abort = () => terminate(coded('LLM_DIRECTOR_PROVIDER_ABORTED', 'director selection was aborted'));
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => terminate(coded('LLM_DIRECTOR_PROVIDER_TIMEOUT', `director selection exceeded ${timeoutMs}ms`)), timeoutMs);
  });
}

export function createDirectorCodexProvider({ codexBin = 'codex', spawnImpl = nodeSpawn, timeoutMs = 90_000, tempDirectory } = {}) {
  if (typeof tempDirectory !== 'string' || !tempDirectory) throw new TypeError('tempDirectory is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 90_000) throw new TypeError('timeoutMs is invalid');
  return Object.freeze({
    async select(context, { signal } = {}) {
      const nonce = randomUUID(); const schemaFile = path.join(tempDirectory, `director-schema-${nonce}.json`);
      const outputFile = path.join(tempDirectory, `director-output-${nonce}.json`);
      await mkdir(tempDirectory, { recursive: true });
      try {
        await writeFile(schemaFile, JSON.stringify(SCHEMA), { mode: 0o600, flag: 'wx' });
        await writeFile(outputFile, '', { mode: 0o600, flag: 'wx' });
        const args = ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--sandbox', 'read-only',
          ...DISABLED.flatMap((name) => ['--disable', name]), '--output-schema', schemaFile, '--output-last-message', outputFile, '-'];
        const child = spawnImpl(codexBin, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        const completion = wait(child, { timeoutMs, signal });
        child.stdin.end(['Select exactly one bounded next goal from eligibleGoals, or stop.',
          'Return only JSON matching the schema. Never emit actions, coordinates, commands, or new goal text.',
          `Context JSON: ${JSON.stringify(context)}`].join('\n'));
        await completion;
        if ((await stat(outputFile)).size > MAX_BYTES) throw coded('LLM_DIRECTOR_PROVIDER_OUTPUT_INVALID', 'output exceeded 64 KiB');
        try { return JSON.parse(await readFile(outputFile, 'utf8')); }
        catch (cause) { throw coded('LLM_DIRECTOR_PROVIDER_OUTPUT_INVALID', 'output was not valid JSON', cause); }
      } finally {
        await Promise.all([rm(schemaFile, { force: true }), rm(outputFile, { force: true })]);
      }
    }
  });
}
