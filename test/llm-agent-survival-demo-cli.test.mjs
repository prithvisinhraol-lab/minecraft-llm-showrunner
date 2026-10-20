import assert from 'node:assert/strict';
import test from 'node:test';

import { startSurvivalDemoCli } from '../src/llm-agent/survival-demo-cli.mjs';

test('starts only the log gate and launches one lazy actor after the exact trigger', async () => {
  let launch;
  let gateStarted = 0;
  let hostCreated = 0;
  let hostStarted = 0;
  let gateClosed = 0;
  const output = [];
  const processImpl = {
    stdout: { write: (value) => output.push(value) }, on() {}, off() {}
  };
  const cli = await startSurvivalDemoCli({
    env: {
      CODEX_BIN: '/codex', MC_HOST: '127.0.0.1', MC_PORT: '25565', MC_VERSION: '1.21.4',
      SURVIVAL_DEMO_LOG_PATH: '/server/latest.log', SURVIVAL_DEMO_STATE_DIRECTORY: '/state',
      SURVIVAL_DEMO_CLEARING_X: '52.5', SURVIVAL_DEMO_CLEARING_Y: '66', SURVIVAL_DEMO_CLEARING_Z: '48.5'
    },
    processImpl,
    loadEnvFileImpl: async () => {},
    resolveCodexBinImpl: async ({ configured }) => configured,
    gateFactory(options) {
      launch = options.launch;
      return { async start() { gateStarted += 1; }, async close() { gateClosed += 1; }, status: () => ({ state: 'waiting' }) };
    },
    hostFactory(options) {
      hostCreated += 1;
      assert.equal(options.actorId, 'LlmAgent');
      assert.deepEqual(options.clearingStart, { x: 52.5, y: 66, z: 48.5 });
      return {
        completion: Promise.resolve({ status: 'succeeded' }),
        start() { hostStarted += 1; }, async stop() {}, async close() {}
      };
    }
  });
  assert.equal(gateStarted, 1);
  assert.equal(hostCreated, 0);
  assert.deepEqual(output, ['WAITING: join as VPNAJ, then say start.\n']);
  await launch();
  assert.equal(hostCreated, 1);
  assert.equal(hostStarted, 1);
  await cli.close();
  assert.equal(gateClosed, 1);
});

test('rejects invalid ports and nonfinite clearing coordinates before watching the log', async () => {
  const base = {
    CODEX_BIN: '/codex', MC_PORT: '25565', SURVIVAL_DEMO_LOG_PATH: '/server/latest.log',
    SURVIVAL_DEMO_CLEARING_X: '52.5', SURVIVAL_DEMO_CLEARING_Y: '66', SURVIVAL_DEMO_CLEARING_Z: '48.5'
  };
  const options = {
    processImpl: { stdout: { write() {} }, on() {}, off() {} }, loadEnvFileImpl: async () => {},
    resolveCodexBinImpl: async ({ configured }) => configured,
    gateFactory: () => ({ start: async () => {}, close: async () => {} }), hostFactory: () => ({})
  };
  await assert.rejects(startSurvivalDemoCli({ ...options, env: { ...base, MC_PORT: '0' } }), { code: 'SURVIVAL_DEMO_CONFIG_INVALID' });
  await assert.rejects(startSurvivalDemoCli({ ...options, env: { ...base, SURVIVAL_DEMO_CLEARING_X: 'NaN' } }), { code: 'SURVIVAL_DEMO_CONFIG_INVALID' });
});
