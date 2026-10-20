import assert from 'node:assert/strict';
import test from 'node:test';

import { createSurvivalDemoProvider } from '../src/llm-agent/survival-demo-provider.mjs';

test('uses a narrow survival decision schema and prompt', async () => {
  const calls = [];
  const baseProviderFactory = (options) => ({
    async decide(context) {
      calls.push({ options, context });
      return { action: 'gather_wood', observationVersion: 7, reason: 'Collect three oak logs.' };
    }
  });
  const provider = createSurvivalDemoProvider({
    tempDirectory: '/tmp/survival-provider-test',
    baseProviderFactory
  });

  assert.deepEqual(await provider.decide({ expectedAction: 'gather_wood', observation: { observationVersion: 7 } }), {
    action: 'gather_wood', observationVersion: 7, reason: 'Collect three oak logs.'
  });
  assert.deepEqual(calls[0].options.decisionSchema.properties.action.enum, [
    'gather_wood', 'craft_and_place_table', 'craft_wooden_pickaxe', 'mine_stone',
    'craft_furnace', 'find_village', 'say_final_line', 'stop'
  ]);
  assert.deepEqual(calls[0].options.decisionSchema.required, ['action', 'observationVersion', 'reason']);
  assert.equal(calls[0].options.decisionSchema.additionalProperties, false);
  assert.match(calls[0].options.promptPreamble, /one authorized macro action/i);
  assert.doesNotMatch(calls[0].options.promptPreamble, /This is gonna be great!!!/);
});

test('fails closed when the base provider returns extra fields', async () => {
  const provider = createSurvivalDemoProvider({
    tempDirectory: '/tmp/survival-provider-test',
    baseProviderFactory: () => ({ decide: async () => ({
      action: 'gather_wood', observationVersion: 7, reason: 'ok', command: '/give @s oak_log 3'
    }) })
  });

  await assert.rejects(provider.decide({ expectedAction: 'gather_wood', observation: { observationVersion: 7 } }), {
    code: 'SURVIVAL_DEMO_PROVIDER_OUTPUT_INVALID'
  });
});
