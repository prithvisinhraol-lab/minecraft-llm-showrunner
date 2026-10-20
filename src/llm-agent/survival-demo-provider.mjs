import { createCodexProvider } from './codex-provider.mjs';
import { SURVIVAL_DEMO_ACTIONS } from './survival-demo-contracts.mjs';

const DECISION_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    action: { type: 'string', enum: [...SURVIVAL_DEMO_ACTIONS] },
    observationVersion: { type: 'integer', minimum: 1 },
    reason: { type: 'string', minLength: 1, maxLength: 200 }
  },
  required: ['action', 'observationVersion', 'reason'],
  additionalProperties: false
});

const PROMPT = [
  'Choose exactly one authorized macro action for the bounded Minecraft survival demo.',
  'Choose expectedAction unless safety or disconnection requires stop.',
  'Echo observation.observationVersion exactly. Never invent commands, coordinates, dialogue, or extra fields.'
].join(' ');

function invalid(message) {
  const error = new Error(message);
  error.code = 'SURVIVAL_DEMO_PROVIDER_OUTPUT_INVALID';
  return error;
}

function validateShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'action,observationVersion,reason') {
    throw invalid('survival demo decision contains unknown or missing fields');
  }
  if (!SURVIVAL_DEMO_ACTIONS.includes(value.action)
    || !Number.isSafeInteger(value.observationVersion) || value.observationVersion < 1
    || typeof value.reason !== 'string' || value.reason.trim().length === 0 || value.reason.length > 200) {
    throw invalid('survival demo decision has an invalid field');
  }
  return Object.freeze(structuredClone(value));
}

export function createSurvivalDemoProvider({ baseProviderFactory = createCodexProvider, ...options } = {}) {
  if (typeof baseProviderFactory !== 'function') throw new TypeError('baseProviderFactory must be a function');
  const provider = baseProviderFactory({
    ...options,
    decisionSchema: DECISION_SCHEMA,
    promptPreamble: PROMPT,
    normalizeDecision: (decision) => decision
  });
  if (!provider || typeof provider.decide !== 'function') throw new TypeError('base provider must expose decide');
  return Object.freeze({
    async decide(context, execution = {}) {
      return validateShape(await provider.decide(context, execution));
    }
  });
}
